// 图床桥接契约回归：确认弹窗里选的站点必须真正生效（单任务授权 > 设置默认）。
//
// 缺陷原貌（用户实跑「21 个组合全手动」）：执行层 hostId 只读 settings.imagehost
// .provider，完全无视 consent.imagehost——用户在确认弹窗勾了桥接、选了站点，
// 也会被无声跳过（skip 理由「未选择图床站点」），四级链路全断，21/21 落 manual。
// 叠加因素：设置允许 enabled=true + provider=null 的死状态（用户当时正是这个状态），
// 且确认弹窗不反映设置现状，勾选前无从知道自己会白勾。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  makeClient,
  makeOfflineConfig,
  seedFrame,
  seedTask,
  startApp,
  waitForAnalysesSettled,
} from './helpers.mjs';

// 非离线（走完整执行链路），代理指向 127.0.0.1:1：出站立即拒绝，不产生真实外发。
function makeLiveButUnroutableConfig() {
  return makeOfflineConfig({
    RVS_OFFLINE: '0',
    RVS_PROXY: 'http://127.0.0.1:1',
    RVS_ENGINE_MIN_INTERVAL_MS: '10',
  });
}

async function seedAndRun(app, { confirmScope }) {
  const api = makeClient(app.server.address().port);
  const taskId = await seedTask(app, { confirmed: 1, status: 'frames_ready' });
  await seedFrame(app, taskId, { seq: 1 });
  const conf = await api.post(`/api/tasks/${taskId}/confirm`, confirmScope);
  assert.equal(conf.json?.ok, true, `确认失败：${conf.text?.slice(0, 200)}`);
  const run = await api.post('/api/search/run-analyses', {
    task_id: taskId,
    options: { allow_bridge: confirmScope.bridge === true },
    consent_ack: true,
  });
  assert.equal(run.json?.ok, true, `发起检索失败：${run.text?.slice(0, 200)}`);
  const items = await waitForAnalysesSettled(api, taskId);
  assert.ok(items.length > 0, '应产生分析作业');
  return items;
}

function bridgeStep(analysis) {
  const log = Array.isArray(analysis.degradation_log) ? analysis.degradation_log : [];
  return log.find((s) => s.step === 'bridge') || null;
}

describe('图床桥接契约（consent.imagehost 曾被无视）', () => {
  test('B1：弹窗授权的站点优先生效——设置未选默认站点也应尝试桥接', async (t) => {
    const { cfg } = makeLiveButUnroutableConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });

    // 默认设置即「enabled=true 但 provider=null」（用户当时的死状态）
    const api = makeClient(app.server.address().port);
    const settings = await api.get('/api/settings');
    assert.equal(settings.json.data.writable.imagehost.enabled, true, '前置：默认应开启图床');
    assert.equal(settings.json.data.writable.imagehost.provider, null, '前置：默认未选站点');

    const items = await seedAndRun(app, {
      confirmScope: { engines: true, bridge: true, imagehost: 'catbox' },
    });

    // 引擎能力差异要尊重：bridge='unavailable' 的引擎跳过桥接是正确行为，
    // 只有「能力上可桥接」的引擎才必须真的尝试。
    const engines = (await api.get('/api/engines')).json.data.engines;
    const bridgeCapable = new Set(engines.filter((e) => e.availability.bridge !== 'unavailable').map((e) => e.id));
    assert.ok(bridgeCapable.size > 0, '前置：至少应有一个引擎具备桥接能力');

    for (const a of items) {
      const step = bridgeStep(a);
      assert.ok(step, `分析 ${a.id} 的降级日志应包含 bridge 步骤：${JSON.stringify(a.degradation_log)}`);
      if (bridgeCapable.has(a.provider)) {
        assert.notEqual(step.skipped, true, `可桥接引擎 ${a.provider} 应真的尝试桥接，实际：${step.reason}`);
      } else {
        assert.equal(step.skipped, true, `不可桥接引擎 ${a.provider} 跳过是正确行为`);
      }
      // 代理不可达：上传必然失败，但失败发生在「真的尝试过」之后
      assert.equal(a.status, 'manual', `上传失败后应落到 manual，实测 ${a.status}`);
      assert.notEqual(a.error_code, 'INTERNAL', `不得因内部异常退化：${a.error_message}`);
    }
  });

  test('B2：设置里关闭总开关——桥接必须跳过，且理由能区分「关闭」与「未选站点」', async (t) => {
    const { cfg } = makeLiveButUnroutableConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });

    const api = makeClient(app.server.address().port);
    const put = await api.put('/api/settings', { imagehost: { enabled: false, provider: null } });
    assert.equal(put.json?.ok, true, `关闭图床应成功：${put.text?.slice(0, 200)}`);

    const items = await seedAndRun(app, {
      confirmScope: { engines: true, bridge: true, imagehost: 'catbox' },
    });

    for (const a of items) {
      const step = bridgeStep(a);
      assert.ok(step, '降级日志应包含 bridge 步骤');
      assert.equal(step.skipped, true, '总开关关闭时桥接必须跳过（单任务授权不能越过设置开关）');
      assert.match(String(step.reason), /设置页关闭/, `跳过理由应指向设置开关，实际：${step.reason}`);
    }
  });

  test('B3：确认时勾了桥接但没选站点——后端必须拒绝，不允许空授权入库', async (t) => {
    const { cfg } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });

    const api = makeClient(app.server.address().port);
    const taskId = await seedTask(app);
    const conf = await api.post(`/api/tasks/${taskId}/confirm`, { engines: true, bridge: true, imagehost: null });
    assert.equal(conf.json?.ok, false, 'bridge=true 且未选站点必须被拒绝');
    assert.equal(conf.json?.error?.code, 'BAD_REQUEST', `错误码应为 BAD_REQUEST，实测 ${conf.json?.error?.code}`);
  });
});
