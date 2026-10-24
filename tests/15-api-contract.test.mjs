// 前后端数据契约回归：服务端 sendOk 的 data 形状 ↔ 前端 request() 返回值的用法。
//
// 缺陷原貌（用户实跑反馈）：GET /api/tasks/:id 的 data 是 { task }，而前端
// api.getTask 直接把 request() 的返回值（即 data）当任务对象用，少剥一层。
// 后果不止显示难看——任务详情页整块失能：
//   · 页头：状态「未知」、上限「undefined 帧」、创建于「—」
//   · 操作按钮集体消失（renderActions 依赖 t.status 判断该显示哪些按钮）
//   · 「尚未确认外发范围」横幅误报（t.confirmed 读到 undefined）
// 而「本地文件」这种三元的兜底分支反而把问题盖住了半边，靠肉眼很难定位。
//
// 本用例锁住的是「视图真正会读的字段必须在 data 的正确层级上」——
// 契约一错位就红，而不是等用户在浏览器里看到 undefined。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { REPO_ROOT, makeClient, makeOfflineConfig, seedTask, startApp } from './helpers.mjs';

// 任务详情页真正读取的字段（task-detail.view.js 的 renderHead / renderActions / renderDegraded）。
// 任一字段缺位或类型不对，页面就会出现 undefined / 未知 / 按钮消失。
const VIEW_TASK_FIELDS = [
  ['display_name', 'string'],
  ['source_name', 'string'],
  ['id', 'string'],
  ['status', 'string'],
  ['source_type', 'string'],
  ['extract_mode', 'string'],
  ['max_frames', 'number'],
  ['created_ms', 'number'],
  ['confirmed', 'number'],
];

describe('前后端数据契约（request() 返回值 = 信封的 data）', () => {
  test('C1：任务详情 data 是 { task }，且视图要读的字段都在 task 上', async (t) => {
    const { cfg } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });
    const api = makeClient(app.server.address().port);
    const taskId = await seedTask(app, { status: 'frames_ready', max_frames: 8 });

    const res = await api.get(`/api/tasks/${taskId}`);
    assert.equal(res.json?.ok, true, '应是成功信封');

    // 关键断言：data 必须包一层 task，而不是直接就是任务对象
    const data = res.json.data;
    assert.ok(data && typeof data === 'object', 'data 应是对象');
    assert.ok(data.task && typeof data.task === 'object', 'data.task 必须存在（前端 api.getTask 依赖这一层剥壳）');
    assert.equal(data.task.id, taskId, 'data.task 应是该任务本身');

    for (const [key, type] of VIEW_TASK_FIELDS) {
      const v = data.task[key];
      if (key === 'display_name' || key === 'source_name') {
        assert.equal(typeof v, 'string', `task.${key} 应是字符串，实测 ${typeof v}`);
        continue;
      }
      assert.equal(typeof v, type, `task.${key} 应是 ${type}，实测 ${typeof v}（视图读不到就会出现 undefined）`);
    }
    assert.ok(data.task.status.length > 0, 'status 不得为空串，否则状态显示「未知」');
    assert.ok(data.task.max_frames > 0, 'max_frames 应是正数，否则显示「上限 undefined 帧」');
  });

  test('C2：列表类端点的 data 直接带 items（前端按 data.items 取）', async (t) => {
    const { cfg } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });
    const api = makeClient(app.server.address().port);
    const taskId = await seedTask(app);

    const cases = [
      ['/api/tasks', '任务列表'],
      [`/api/tasks/${taskId}/frames`, '帧列表'],
      [`/api/tasks/${taskId}/analyses`, '分析列表'],
      ['/api/results', '结果列表'],
      ['/api/logs', '日志列表'],
    ];
    for (const [pathName, label] of cases) {
      const res = await api.get(pathName);
      assert.equal(res.json?.ok, true, `${label} 应成功：${res.text?.slice(0, 160)}`);
      assert.ok(Array.isArray(res.json.data?.items), `${label} 的 data.items 应是数组`);
      assert.equal(typeof res.json.data.total, 'number', `${label} 的 data.total 应是数字`);
    }
  });

  test('C3：其余端点的 data 形状与前端取值一致', async (t) => {
    const { cfg } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });
    const api = makeClient(app.server.address().port);

    const engines = await api.get('/api/engines');
    assert.ok(Array.isArray(engines.json.data?.engines), 'engines 列表应为数组（engines.view 读 data.engines）');

    const settings = await api.get('/api/settings');
    assert.ok(settings.json.data?.writable, 'settings 应含 writable（settings.view 读 data.writable）');
    assert.ok(settings.json.data?.read_only, 'settings 应含 read_only（settings.view 读 data.read_only）');

    const health = await api.get('/api/health');
    assert.equal(health.json.data?.status, 'ok', 'health 的 data 应直接是健康对象');
  });

  test('C4：建任务返回 data.task + data.plan（上传页读这两个键）', async (t) => {
    const { cfg } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });
    const api = makeClient(app.server.address().port);

    const created = await api.post('/api/file-upload', {
      source_type: 'url',
      source_url: 'https://example.com/clip.mp4',
      display_name: '契约校验',
    });
    assert.equal(created.json?.ok, true, `建任务应成功：${created.text?.slice(0, 200)}`);
    assert.ok(created.json.data?.task, 'data.task 必须存在');
    assert.ok(created.json.data?.plan, 'data.plan 必须存在（上传页 showPlan 读它）');
    assert.equal(created.json.data.task.display_name, '契约校验');
  });

  // 前端 api.js 是浏览器 ESM（内部用 location.origin 拼 URL），Node 里没法直接 import
  // 跑真实调用，故对「前端是否剥壳」做源码级断言——这是 C1 覆盖不到的另一半。
  test('C5：前端 api.getTask 必须剥掉 { task } 这层壳', async () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'public/assets/api.js'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('getTask:'));
    assert.ok(line, 'api.js 中应存在 getTask 定义');
    assert.match(line, /\.task\b/, 'getTask 必须返回 .task——否则视图拿到包装对象，页头/按钮/横幅全部读到 undefined');
  });
});
