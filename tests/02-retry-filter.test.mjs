// SPEC §14 验收项 1 + 2：重试接口在**执行层**过滤 hit / zero；captcha 状态的 analysis 不得进入自动重试队列。
// 编号说明：SPEC §14 表把这两条分别标为 EARS #20 与 #10；PRD §7 中"仅重试失败项"的原文实为 EARS #28，
// 过滤语义（限频 / 网络错误 / 解析异常 / 凭据错误可重跑；成功有结果与成功零结果不可重跑）以 PRD #28 为准。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import {
  makeClient,
  makeOfflineConfig,
  seedAnalysis,
  seedFrame,
  seedTask,
  startApp,
  waitForIdsSettled,
  zeroOutbound,
} from './helpers.mjs';

// 夹具矩阵：覆盖「必须重试 / 不得重试 / captcha 不得重试」三类。
// status 取值与生产一致：captcha 在生产中落为 status='manual' + error_code='CAPTCHA'；
// 另补一个假设性的 status='captcha' 行做防御（防止未来状态名变更后误入重试集）。
const FIXTURES = [
  { key: 'hit', status: 'succeeded', error_code: null, expectRetry: false },
  { key: 'zero', status: 'zero_result', error_code: null, expectRetry: false },
  { key: 'manual', status: 'manual', error_code: 'CAPTCHA', expectRetry: false },
  { key: 'captcha_status', status: 'captcha', error_code: 'CAPTCHA', expectRetry: false },
  { key: 'failed_captcha', status: 'failed', error_code: 'CAPTCHA', expectRetry: false },
  { key: 'cancelled_captcha', status: 'cancelled', error_code: 'CAPTCHA', expectRetry: false },
  { key: 'rate_limited', status: 'failed', error_code: 'RATE_LIMITED', expectRetry: true },
  { key: 'network_error', status: 'failed', error_code: 'NETWORK_ERROR', expectRetry: true },
  { key: 'parse_error', status: 'failed', error_code: 'PARSE_ERROR', expectRetry: true },
  { key: 'timeout', status: 'failed', error_code: 'TIMEOUT', expectRetry: true },
  { key: 'forbidden', status: 'failed', error_code: 'FORBIDDEN', expectRetry: true },
  { key: 'cancelled_network', status: 'cancelled', error_code: 'NETWORK_ERROR', expectRetry: true },
  { key: 'upload_rejected', status: 'failed', error_code: 'UPLOAD_REJECTED', expectRetry: false },
  { key: 'provider_disabled', status: 'failed', error_code: 'PROVIDER_DISABLED', expectRetry: false },
];

describe('SPEC §14 验收项 1/2：重试在执行层过滤', () => {
  test('验收项1：retry-failed 只重置失败项，hit 与 zero 保持原状（EARS #20/#28）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app);

    // 先冻结调度器：消除"复位后作业立刻被跑掉"的竞态，使 queued 状态可被稳定观测。
    const paused = await api.post(`/api/tasks/${taskId}/control`, { action: 'pause' });
    assert.equal(paused.status, 200);

    const ids = {};
    let seq = 0;
    for (const fixture of FIXTURES) {
      seq += 1;
      const frameId = await seedFrame(app, taskId, { seq });
      ids[fixture.key] = await seedAnalysis(app, taskId, {
        frame_id: frameId,
        provider: 'bing',
        status: fixture.status,
        error_code: fixture.error_code,
        error_message: `fixture:${fixture.key}`,
      });
    }

    const res = await api.post(`/api/tasks/${taskId}/control`, { action: 'retry-failed' });
    assert.equal(res.status, 200, `期望 200，实际 ${res.status} ${res.text}`);

    const expectedRetried = FIXTURES.filter((f) => f.expectRetry).length;
    assert.equal(res.json?.data?.retried, expectedRetried,
      `期望重试 ${expectedRetried} 项，实际 ${res.json?.data?.retried}`);

    // 复位是同步完成的（control 内 await resetForRetry 后才返回），且调度器已冻结，可稳定断言。
    const after = await api.get(`/api/tasks/${taskId}/analyses`);
    const byId = new Map((after.json?.data?.items || []).map((a) => [a.id, a]));

    for (const fixture of FIXTURES) {
      const row = byId.get(ids[fixture.key]);
      assert.ok(row, `夹具 ${fixture.key} 缺失`);
      if (fixture.expectRetry) {
        assert.equal(row.status, 'queued', `${fixture.key} 应被复位入队，实际 ${row.status}`);
      } else {
        assert.equal(row.status, fixture.status,
          `${fixture.key} 不得被重试选中，期望保持 ${fixture.status}，实际 ${row.status}`);
      }
    }

    // 不得重试的行连错误码都不该被清掉（证明没有被 resetForRetry 触碰）
    assert.equal(byId.get(ids.captcha_status).error_code, 'CAPTCHA');
    assert.equal(byId.get(ids.manual).error_code, 'CAPTCHA');
    assert.equal(byId.get(ids.hit).status, 'succeeded');
    assert.equal(byId.get(ids.zero).status, 'zero_result');

    // 恢复调度并把被复位的作业跑完，避免 close() 时仍有在飞任务占用 DB
    await api.post(`/api/tasks/${taskId}/control`, { action: 'resume' });
    await waitForIdsSettled(api, taskId, FIXTURES.filter((f) => f.expectRetry).map((f) => ids[f.key]));
  });

  test('验收项2：captcha 行不进入重试集，且被重试项执行后零外发（EARS #10）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app);

    // 冻结调度器，使复位后的 queued 状态可被稳定观测
    await api.post(`/api/tasks/${taskId}/control`, { action: 'pause' });

    const captchaFrame = await seedFrame(app, taskId, { seq: 1 });
    const captchaStatusFrame = await seedFrame(app, taskId, { seq: 2 });
    const networkFrame = await seedFrame(app, taskId, { seq: 3 });

    const captchaManual = await seedAnalysis(app, taskId, {
      frame_id: captchaFrame, provider: 'bing', status: 'manual', error_code: 'CAPTCHA', error_message: '引擎要求人机验证',
    });
    const captchaStatus = await seedAnalysis(app, taskId, {
      frame_id: captchaStatusFrame, provider: 'bing', status: 'captcha', error_code: 'CAPTCHA',
    });
    const network = await seedAnalysis(app, taskId, {
      frame_id: networkFrame, provider: 'bing', status: 'failed', error_code: 'NETWORK_ERROR',
    });

    const res = await api.post(`/api/tasks/${taskId}/control`, { action: 'retry-failed' });
    assert.equal(res.status, 200);
    assert.equal(res.json?.data?.retried, 1, '仅 NETWORK_ERROR 一项可重试');

    const after = await api.get(`/api/tasks/${taskId}/analyses`);
    const byId = new Map((after.json?.data?.items || []).map((a) => [a.id, a]));
    assert.equal(byId.get(captchaManual).status, 'manual');
    assert.equal(byId.get(captchaStatus).status, 'captcha');
    assert.equal(byId.get(network).status, 'queued');

    // 恢复调度：被重试项执行完毕后离线降级 manual，全程零外发（captcha 不会被重发）
    await api.post(`/api/tasks/${taskId}/control`, { action: 'resume' });
    const settled = await waitForIdsSettled(api, taskId, [network]);
    const settledById = new Map(settled.map((a) => [a.id, a]));
    assert.equal(settledById.get(network).status, 'manual');
    assert.equal(settledById.get(network).error_code, 'NETWORK_ERROR');
    assert.equal(zeroOutbound(app), true);

    // captcha 两行原样保留，未被重跑覆盖
    const final = await api.get(`/api/tasks/${taskId}/analyses`);
    const finalById = new Map((final.json?.data?.items || []).map((a) => [a.id, a]));
    assert.equal(finalById.get(captchaManual).status, 'manual');
    assert.equal(finalById.get(captchaManual).error_code, 'CAPTCHA');
    assert.equal(finalById.get(captchaStatus).status, 'captcha');
    assert.equal(finalById.get(captchaStatus).error_code, 'CAPTCHA');
  });

  test('验收项2：仓储层 selectRetryable 与 resetForRetry 双重排除 captcha 与终态成功项', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app);
    await seedFrame(app, taskId, { seq: 1 });
    const rows = {};
    for (const fixture of FIXTURES) {
      rows[fixture.key] = await seedAnalysis(app, taskId, {
        provider: 'bing', status: fixture.status, error_code: fixture.error_code,
      });
    }

    const selected = await app.ctx.repos.analyses.selectRetryable(taskId);
    const selectedIds = new Set(selected.map((r) => r.id));
    const expected = new Set(FIXTURES.filter((f) => f.expectRetry).map((f) => rows[f.key]));

    assert.deepEqual([...selectedIds].sort(), [...expected].sort(), 'selectRetryable 选中的集合与期望不一致');
    assert.equal(selectedIds.has(rows.captcha_status), false, 'status=captcha 不得出现在重试集');
    assert.equal(selectedIds.has(rows.manual), false, 'status=manual + CAPTCHA 不得出现在重试集');
    assert.equal(selectedIds.has(rows.hit), false, 'succeeded 不得出现在重试集');
    assert.equal(selectedIds.has(rows.zero), false, 'zero_result 不得出现在重试集');

    // resetForRetry 传入全集时，也只能改掉可重试的那些行
    const changed = await app.ctx.repos.analyses.resetForRetry(
      taskId,
      FIXTURES.map((f) => rows[f.key]),
    );
    assert.equal(changed, expected.size, `期望更新 ${expected.size} 行，实际 ${changed}`);

    const after = await app.ctx.repos.analyses.listByTask(taskId, { limit: 2000 });
    const byId = new Map(after.map((r) => [r.id, r]));
    assert.equal(byId.get(rows.captcha_status).status, 'captcha');
    assert.equal(byId.get(rows.captcha_status).error_code, 'CAPTCHA');
    assert.equal(byId.get(rows.hit).status, 'succeeded');
    assert.equal(byId.get(rows.zero).status, 'zero_result');
    assert.equal(byId.get(rows.rate_limited).status, 'queued');
    assert.equal(byId.get(rows.cancelled_network).status, 'queued');
  });
});
