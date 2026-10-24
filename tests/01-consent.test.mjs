// SPEC §14 验收项 3：服务端校验 consentAck，拒绝未确认的 run-analyses（PRD EARS #7 / #8）。
// 关键断言：授权缺失时**不得**触发任何出站请求——即失败必须发生在服务端编排层，而不是把请求发出去再报错。
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
  waitForAnalysesSettled,
  zeroOutbound,
} from './helpers.mjs';

describe('SPEC §14 验收项 3：consentAck 服务端校验', () => {
  test('验收项3：缺少 consentAck 时 run-analyses 返回 400 且零外发（EARS #7/#8）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app, { confirmed: 0 });
    await seedFrame(app, taskId, { seq: 1 });

    // 1) 完全不带 consent_ack
    const noAck = await api.post('/api/search/run-analyses', { task_id: taskId, providers: ['bing'] });
    assert.equal(noAck.status, 400, `期望 400，实际 ${noAck.status} ${noAck.text}`);
    assert.equal(noAck.json?.error?.code, 'CONSENT_REQUIRED');
    assert.match(noAck.json?.error?.message || '', /consentAck|确认/);

    // 2) consent_ack 显式为 false
    const ackFalse = await api.post('/api/search/run-analyses', { task_id: taskId, providers: ['bing'], consent_ack: false });
    assert.equal(ackFalse.status, 400);
    assert.equal(ackFalse.json?.error?.code, 'CONSENT_REQUIRED');

    // 3) consent_ack 为真但任务未确认（tasks.confirmed = 0 且无授权记录）
    const ackOnly = await api.post('/api/search/run-analyses', { task_id: taskId, providers: ['bing'], consent_ack: true });
    assert.equal(ackOnly.status, 400, `期望 400，实际 ${ackOnly.status} ${ackOnly.text}`);
    assert.equal(ackOnly.json?.error?.code, 'CONSENT_REQUIRED');

    // 三次被拒都必须零外发（EARS #8：未确认不得发起任何搜索引擎网络请求）
    assert.equal(zeroOutbound(app), true, JSON.stringify(app.metrics.providerRequests));

    // 4) 确认后 consent_ack 仍必须显式提供（服务端不因已确认就免检）
    const confirmed = await api.post(`/api/tasks/${taskId}/confirm`, { engines: true });
    assert.equal(confirmed.status, 200);
    const stillNeedsAck = await api.post('/api/search/run-analyses', { task_id: taskId, providers: ['bing'] });
    assert.equal(stillNeedsAck.status, 400);
    assert.equal(stillNeedsAck.json?.error?.code, 'CONSENT_REQUIRED');

    // 5) 授权齐备 → 202，且离线模式下最终全部降级 manual（不外发）
    const ok = await api.post('/api/search/run-analyses', { task_id: taskId, providers: ['bing'], consent_ack: true });
    assert.equal(ok.status, 202, `期望 202，实际 ${ok.status} ${ok.text}`);
    assert.equal(ok.json?.data?.analyses?.length, 1, '单帧 × 单引擎 = 1 个作业');

    const settled = await waitForAnalysesSettled(api, taskId);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].status, 'manual', '离线模式必须降级为手工检索指引，而不是报错');
    assert.ok(settled[0].error_code, 'manual 态 error_code 永不为空');
    assert.equal(zeroOutbound(app), true, '离线降级全程零外发');
  });

  test('验收项3：图床桥接未经本任务确认时拒绝（EARS #7）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app);
    await seedFrame(app, taskId, { seq: 1 });
    await seedAnalysis(app, taskId, { status: 'succeeded', error_code: null });

    // 只授权引擎、未授权图床桥接
    await api.post(`/api/tasks/${taskId}/confirm`, { engines: true });
    const bridged = await api.post('/api/search/run-analyses', {
      task_id: taskId,
      providers: ['bing'],
      consent_ack: true,
      options: { allow_bridge: true },
    });
    assert.equal(bridged.status, 400, `期望 400，实际 ${bridged.status} ${bridged.text}`);
    assert.equal(bridged.json?.error?.code, 'CONSENT_REQUIRED');
    assert.equal(zeroOutbound(app), true);
  });
});
