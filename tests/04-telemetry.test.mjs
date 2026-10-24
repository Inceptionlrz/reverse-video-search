// SPEC §14 验收项 9：遥测默认关闭，关闭态零外发遥测请求（PRD EARS #23）。
// 出站只有一个计数点：providers/base.mjs 的 trackedRequest（引擎）与图床上传；
// 因此"零外发"用 app.metrics 的 providerRequests / imagehostRequests 全零来证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import {
  makeClient,
  makeOfflineConfig,
  seedFrame,
  seedTask,
  startApp,
  waitForIdsSettled,
  zeroOutbound,
} from './helpers.mjs';
import { DEFAULT_SETTINGS, readOnlySettings } from '../server/services/settings.service.mjs';
import { loadConfig } from '../server/lib/config.mjs';
import { REPO_ROOT } from './helpers.mjs';

describe('SPEC §14 验收项 9：遥测默认关闭且关闭态零外发', () => {
  test('验收项9：默认配置遥测为关，且运行期无法被默认打开（EARS #23）', () => {
    // 不传任何 RVS_TELEMETRY 时的默认值
    const plain = loadConfig({}, REPO_ROOT);
    assert.equal(plain.telemetry.enabled, false, '遥测必须默认关闭');

    // 默认设置对象里不存在任何"开启遥测"的入口（不可被 settings API 默认勾选）
    assert.equal(DEFAULT_SETTINGS.telemetry, undefined);
    assert.equal(readOnlySettings(plain).telemetry.enabled, false);

    // 各布尔开关字面量均为 false / 显式关
    const { cfg } = makeOfflineConfig();
    assert.equal(cfg.telemetry.enabled, false);
  });

  test('验收项9：关闭态下完整离线工作流零外发请求（EARS #23）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // 遥测状态在设置接口中可见且为关
    const settings = await api.get('/api/settings');
    assert.equal(settings.status, 200);
    assert.equal(settings.json?.data?.read_only?.telemetry?.enabled, false);

    // 尝试通过设置接口打开遥测：不得生效（遥测只由启动环境变量决定，无默认勾选）
    await api.put('/api/settings', { telemetry: { enabled: true } });
    const after = await api.get('/api/settings');
    assert.equal(after.json?.data?.read_only?.telemetry?.enabled, false,
      '关闭态不得被运行时设置静默改为开启');

    // 跑完整工作流：建任务 → 抽帧（夹具帧）→ 确认 → 分析 → 查询 → 导出
    const taskId = await seedTask(app);
    await seedFrame(app, taskId, { seq: 1 });
    await api.post(`/api/tasks/${taskId}/confirm`, { engines: true });
    const run = await api.post('/api/search/run-analyses', {
      task_id: taskId,
      providers: ['bing', 'yandex', 'google_lens'],
      consent_ack: true,
    });
    assert.equal(run.status, 202);

    const ids = (run.json?.data?.analyses || []).map((a) => a.id);
    await waitForIdsSettled(api, taskId, ids);

    await api.get(`/api/tasks/${taskId}/analyses`);
    await api.get(`/api/tasks/${taskId}/frames`);
    await api.get('/api/engines');
    await api.get('/api/results');
    await api.get(`/api/export.csv?task_id=${taskId}`);
    await api.get(`/api/export.json?task_id=${taskId}`);

    // 零外发：引擎与图床两个计数点都必须为 0 / 不存在
    assert.deepEqual(app.metrics.providerRequests, {}, '离线关闭遥测态不得产生任何引擎出站请求');
    assert.deepEqual(app.metrics.imagehostRequests, {}, '不得产生任何图床上传请求');
    assert.equal(zeroOutbound(app), true);

    // 日志里不得出现遥测相关外发记录
    const logs = await api.get('/api/logs?limit=200');
    const events = (logs.json?.data?.items || []).map((l) => l.event);
    assert.equal(events.includes('telemetry_send'), false, '关闭态不得有遥测发送事件');
    assert.equal(events.includes('telemetry_flush'), false, '关闭态不得有遥测上报事件');
  });
});
