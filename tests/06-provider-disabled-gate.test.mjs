// 调度层 provider 停用单点过滤（PRD EARS #30；team-lead 纠错：四个入队入口都不得发请求）。
//
// 代码事实：analysis.service.mjs 的 enqueue() 是唯一入队路径，入口共四处——
//   1) run()                批量队列（POST /api/search/run-analyses）
//   2) resumeQueued()       断点恢复（进程重启后 app.listen() 内调用）
//   3) control('retry-failed') 重试失败项
//   4) control('resume')    恢复暂停任务时重新入队
// 四处都在 runner.enqueue() 前 await gateOrManual()，停用/熔断引擎直接落 manual。
//
// 验收方式（按 team-lead 指定）：断言 app.metrics.providerRequests[provider] 保持 0——
// 出站计数点唯一，位于 providers/base.mjs 的 trackedRequest()。
//
// 另有一道纵深防御在 analysis-execute.mjs:115（执行层再判一次 isEngineRunnable），
// 因此即使调度层被绕过，停用引擎也只会落 manual + PROVIDER_DISABLED，不会发出站请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { createApp } from '../server/app.mjs';
import {
  makeClient,
  makeOfflineConfig,
  seedAnalysis,
  seedFrame,
  seedTask,
  startApp,
  waitForAnalysesSettled,
} from './helpers.mjs';

const DISABLED = 'bing';

// 停用引擎的请求计数必须为 0（键不存在或值为 0 都算零外发）。
function outboundCount(app, provider) {
  return app.metrics.providerRequests[provider] ?? 0;
}

async function disableProvider(app, provider) {
  await app.ctx.repos.engineHealth.setEnabled(provider, false);
  const row = await app.ctx.repos.engineHealth.get(provider);
  assert.equal(row.enabled, 0, `夹具失败：${provider} 未被停用`);
}

describe('调度层 provider 停用过滤：四个入队入口零外发（EARS #30）', () => {
  test('入口1 批量队列：run-analyses 时停用引擎直接 manual，零外发', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app);
    await seedFrame(app, taskId, { seq: 1 });
    const confirmed = await api.post(`/api/tasks/${taskId}/confirm`, { engines: true });
    assert.equal(confirmed.status, 200);

    await disableProvider(app, DISABLED);

    const run = await api.post('/api/search/run-analyses', {
      task_id: taskId,
      providers: [DISABLED],
      consent_ack: true,
    });
    assert.equal(run.status, 202, `期望 202，实际 ${run.status} ${run.text}`);
    assert.equal(run.json?.data?.analyses?.length, 1);

    const settled = await waitForAnalysesSettled(api, taskId);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].status, 'manual', '停用引擎必须落 manual 而不是报错或卡住');
    assert.equal(settled[0].error_code, 'PROVIDER_DISABLED');
    assert.equal(outboundCount(app, DISABLED), 0,
      `停用引擎不得发出站请求，实际 ${JSON.stringify(app.metrics.providerRequests)}`);
  });

  test('入口2 断点恢复：listen() 内的 resumeQueued 过滤停用引擎，零外发', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    // 手工分步装配：先造"进程重启前遗留的排队作业"，再 listen() 触发断点恢复。
    const app = await createApp({ config: cfg });
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app, { status: 'analyzing', phase: 'analyzing' });
    const frameId = await seedFrame(app, taskId, { seq: 1 });
    const queuedId = await seedAnalysis(app, taskId, {
      frame_id: frameId,
      provider: DISABLED,
      status: 'queued',
      error_code: null,
      error_message: null,
    });

    await disableProvider(app, DISABLED);

    await app.listen(); // 内部 await analysisService.resumeQueued()
    const api = makeClient(app.server.address().port);

    // gateOrManual 在 enqueue 循环内被同步 await，listen() 返回时已是终态
    const row = await app.ctx.repos.analyses.get(queuedId);
    assert.equal(row.status, 'manual', '断点恢复必须把停用引擎的排队项降级为 manual');
    assert.equal(row.error_code, 'PROVIDER_DISABLED');

    const settled = await waitForAnalysesSettled(api, taskId);
    assert.equal(settled.find((a) => a.id === queuedId)?.status, 'manual');
    assert.equal(outboundCount(app, DISABLED), 0,
      `断点恢复不得为停用引擎发请求，实际 ${JSON.stringify(app.metrics.providerRequests)}`);
  });

  test('入口3 重试：retry-failed 复位停用引擎的作业后仍被拦截，零外发', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app);
    // 冻结调度器，避免夹具行被其他路径提前消费
    const paused = await api.post(`/api/tasks/${taskId}/control`, { action: 'pause' });
    assert.equal(paused.status, 200);

    const frameId = await seedFrame(app, taskId, { seq: 1 });
    const failedId = await seedAnalysis(app, taskId, {
      frame_id: frameId,
      provider: DISABLED,
      status: 'failed',
      error_code: 'NETWORK_ERROR',
      error_message: 'fixture',
    });

    await disableProvider(app, DISABLED);

    const res = await api.post(`/api/tasks/${taskId}/control`, { action: 'retry-failed' });
    assert.equal(res.status, 200);
    assert.equal(res.json?.data?.retried, 1, 'NETWORK_ERROR 属可重试错误码，应被选中');

    // 复位后入队即被 gateOrManual 拦截（control 内 await enqueue 之后才返回）
    const after = await api.get(`/api/tasks/${taskId}/analyses`);
    const byId = new Map((after.json?.data?.items || []).map((a) => [a.id, a]));
    assert.equal(byId.get(failedId).status, 'manual');
    assert.equal(byId.get(failedId).error_code, 'PROVIDER_DISABLED');
    assert.equal(outboundCount(app, DISABLED), 0,
      `重试不得为停用引擎发请求，实际 ${JSON.stringify(app.metrics.providerRequests)}`);

    await api.post(`/api/tasks/${taskId}/control`, { action: 'resume' });
  });

  test('入口4 恢复：resume 重新入队停用引擎的遗留排队项，零外发', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app, { status: 'analyzing', phase: 'analyzing' });
    const paused = await api.post(`/api/tasks/${taskId}/control`, { action: 'pause' });
    assert.equal(paused.status, 200);

    const frameId = await seedFrame(app, taskId, { seq: 1 });
    const queuedId = await seedAnalysis(app, taskId, {
      frame_id: frameId,
      provider: DISABLED,
      status: 'queued',
      error_code: null,
      error_message: null,
    });

    await disableProvider(app, DISABLED);

    const res = await api.post(`/api/tasks/${taskId}/control`, { action: 'resume' });
    assert.equal(res.status, 200, `期望 200，实际 ${res.status} ${res.text}`);

    const after = await api.get(`/api/tasks/${taskId}/analyses`);
    const byId = new Map((after.json?.data?.items || []).map((a) => [a.id, a]));
    assert.equal(byId.get(queuedId).status, 'manual');
    assert.equal(byId.get(queuedId).error_code, 'PROVIDER_DISABLED');
    assert.equal(outboundCount(app, DISABLED), 0,
      `resume 不得为停用引擎发请求，实际 ${JSON.stringify(app.metrics.providerRequests)}`);

    await waitForAnalysesSettled(api, taskId);
  });

  test('反证：停用是 provider 级的，同任务其他引擎不受影响', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const taskId = await seedTask(app);
    await seedFrame(app, taskId, { seq: 1 });
    const confirmed = await api.post(`/api/tasks/${taskId}/confirm`, { engines: true });
    assert.equal(confirmed.status, 200);

    await disableProvider(app, DISABLED);

    const run = await api.post('/api/search/run-analyses', {
      task_id: taskId,
      providers: [DISABLED, 'yandex'],
      consent_ack: true,
    });
    assert.equal(run.status, 202);
    assert.equal(run.json?.data?.analyses?.length, 2, '单帧 × 双引擎 = 2 个作业');

    const settled = await waitForAnalysesSettled(api, taskId);
    const byProvider = new Map(settled.map((a) => [a.provider, a]));

    // 停用引擎：PROVIDER_DISABLED，且零外发
    assert.equal(byProvider.get(DISABLED).status, 'manual');
    assert.equal(byProvider.get(DISABLED).error_code, 'PROVIDER_DISABLED');
    assert.equal(outboundCount(app, DISABLED), 0);

    // 未停用引擎：同样落 manual，但原因是离线模式而非被停用——证明拦截是 provider 级而非全局
    assert.equal(byProvider.get('yandex').status, 'manual');
    assert.equal(byProvider.get('yandex').error_code, 'NETWORK_ERROR');
    assert.equal(outboundCount(app, 'yandex'), 0, '离线模式下任何引擎都不得外发');
  });
});
