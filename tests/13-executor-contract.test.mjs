// 执行层依赖契约回归：analysis-execute 调用的每个依赖都必须真实存在。
//
// 缺陷原貌：analysis-execute.mjs 调用 settingsService.loadConsent(task.id)，
// 但 settingsService 根本没有这个方法（consent 读取逻辑在 analysis.service 内部闭包，
// 且未导出）。于是每个分析作业都在 bridge 判定处抛 TypeError，被兜底收敛成
// manual + error_code='INTERNAL'——检索链路在真实运行时 100% 崩。
//
// 为何离线测试全绿也没发现：cfg.offline 为真时执行层在 [0] 前置判定就提前返回
// （NETWORK_ERROR + manual），永远走不到出错的那一行；而崩溃同样落到 manual，
// 仅 error_code 不同。因此必须用「非离线 + 网络不可达」的配置才能触达该路径。
// 代理指向 127.0.0.1:1（立即 ECONNREFUSED），全程不产生真实出站请求。
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

// 非离线（走完整执行链路），但代理不可达（任何出站立即失败）。
function makeLiveButUnroutableConfig() {
  return makeOfflineConfig({
    RVS_OFFLINE: '0',
    RVS_PROXY: 'http://127.0.0.1:1',
    RVS_ENGINE_MIN_INTERVAL_MS: '10',
  });
}

describe('执行层依赖契约（settingsService.loadConsent 缺失回归）', () => {
  test('X1：执行体跑完真实链路，不得因依赖缺失退化为 INTERNAL', async (t) => {
    const { cfg } = makeLiveButUnroutableConfig();
    assert.equal(cfg.offline, false, '本用例必须走非离线分支，否则触达不到缺陷所在行');
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });

    const api = makeClient(app.server.address().port);
    const taskId = await seedTask(app, { confirmed: 1, status: 'frames_ready' });
    await seedFrame(app, taskId, { seq: 1 });

    const conf = await api.post(`/api/tasks/${taskId}/confirm`, { engines: true });
    assert.equal(conf.json?.ok, true, `授权失败：${conf.text?.slice(0, 200)}`);

    const run = await api.post('/api/search/run-analyses', { task_id: taskId, consent_ack: true });
    assert.equal(run.json?.ok, true, `发起检索失败：${run.text?.slice(0, 200)}`);

    const items = await waitForAnalysesSettled(api, taskId);
    assert.ok(items.length > 0, '应产生分析作业');

    for (const a of items) {
      // 崩溃现场：error_code='INTERNAL' 且 message 含「is not a function」
      assert.notEqual(a.error_code, 'INTERNAL', `分析 ${a.id}（${a.provider}）因执行层异常退化：${a.error_message}`);
      assert.doesNotMatch(
        String(a.error_message || ''),
        /is not a function/,
        `分析 ${a.id}（${a.provider}）报出依赖缺失：${a.error_message}`,
      );
      // 同时确认执行体真的跑过（不是排队未执行导致的空断言）
      assert.equal(a.status, 'manual', `网络不可达时应落到 manual，实测 ${a.status}（${a.error_code}）`);
      assert.ok(a.finished_ms, `分析 ${a.id} 应有结束时间，说明执行体确实跑完了`);
    }
  });
});
