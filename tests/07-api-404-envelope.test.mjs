// 回归测试（commit 7420041）：未知 /api/ 路径必须返回 404 JSON 信封，不得被 SPA 兜底吞成 HTML。
//
// 背景：修复前 server/lib/server/static.mjs 的 SPA 兜底不排除 /api/ 前缀，
// 任何未命中路由的路径都回落 index.html 返回 200 + text/html。
// 前端 fetch 到拼错的端点会拿到 HTML，res.json() 抛 "Unexpected token '<'"，
// 错误分支进不到统一错误 UI；且判断"接口不存在"不能只靠 res.ok（全是 200）。
//
// 两个方向都要锁：
//   A. /api/ 未命中 → 404 JSON 信封（P1 修复本身）
//   B. 非 API 未知路径 → 仍 200 + text/html（防未来有人把排除改成全局 404，即防过度矫正；
//      SPA 依赖未知路径回落 index.html 才能让前端路由接管）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import { makeClient, makeOfflineConfig, startApp } from './helpers.mjs';

// SPA 兜底依赖 public/index.html 存在；缺失时兜底会走 404 'Not Found'，
// 届时 B 组断言会失败——那是夹具问题而非产品问题，显式前置检查给出可读原因。
function assertSpaIndexPresent() {
  const indexPath = new URL('../public/index.html', import.meta.url);
  assert.ok(fs.existsSync(indexPath), '夹具缺失：public/index.html 不存在，SPA 兜底无法被验证');
}

describe('API 未知路径返回 404 JSON 信封，非 API 路径保留 SPA 兜底', () => {
  test('A1：/api/ 深层未知路径返回 404 JSON 信封，不是 SPA HTML', async (t) => {
    assertSpaIndexPresent();
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const res = await api.get('/api/no-such-endpoint');

    assert.equal(res.status, 404, `期望 404，实际 ${res.status}：${res.text.slice(0, 120)}`);
    // content-type 必须是 JSON——这是前端 res.json() 的前提
    assert.match(res.headers['content-type'] || '', /application\/json/,
      `content-type 应为 application/json，实际 ${res.headers['content-type']}`);
    // 信封结构
    assert.ok(res.json, '响应体必须可解析为 JSON');
    assert.equal(res.json.ok, false, '失败信封 ok 必须为 false');
    assert.equal(res.json.error?.code, 'NOT_FOUND');
    assert.ok(res.json.error?.message, '失败信封必须带 message');
    // 不得是 SPA HTML
    assert.ok(!/^<!doctype html/i.test(res.text.trim()),
      '未知 /api/ 路径不得回落到 SPA index.html');
    assert.ok(!res.text.includes('<html'), '响应体不得含 HTML 标签');
  });

  test('A2：裸 /api（无斜杠）同样返回 404 JSON 信封', async (t) => {
    assertSpaIndexPresent();
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // static.mjs 的排除条件是 pathname === '/api' || startsWith('/api/')，两条分支都要锁
    const res = await api.get('/api');
    assert.equal(res.status, 404, `期望 404，实际 ${res.status}：${res.text.slice(0, 120)}`);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.error?.code, 'NOT_FOUND');
    assert.ok(!/^<!doctype html/i.test(res.text.trim()));
  });

  test('A3：POST 到未注册的 /api/ 路径也返回 404 JSON 信封', async (t) => {
    assertSpaIndexPresent();
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // 建任务的正确路径是 POST /api/file-upload；POST /api/tasks 未注册。
    // 这正是 live 验证时撞上 SPA 兜底的那个形态（方法无关，路径前缀判定）。
    const res = await api.post('/api/tasks', { title: 'x' });
    assert.equal(res.status, 404, `期望 404，实际 ${res.status}：${res.text.slice(0, 120)}`);
    assert.match(res.headers['content-type'] || '', /application\/json/);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.error?.code, 'NOT_FOUND');
    assert.ok(!/^<!doctype html/i.test(res.text.trim()));
  });

  test('B：非 API 未知路径仍回落 SPA index.html（200 + text/html），防过度矫正', async (t) => {
    assertSpaIndexPresent();
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // 前端单页应用依赖未知路径回落 index.html，由前端路由接管（如 /tasks/abc 详情页）
    const res = await api.get('/tasks/x/frames/y');

    assert.equal(res.status, 200, `未知非 API 路径应回落 SPA，实际 ${res.status}`);
    assert.match(res.headers['content-type'] || '', /text\/html/,
      `SPA 兜底 content-type 应为 text/html，实际 ${res.headers['content-type']}`);
    assert.match(res.text, /^<!doctype html/i, '必须真的是 index.html 而不是别的内容');
    assert.ok(res.json === null, 'SPA HTML 不应被误判为 JSON');

    // 根路径同样必须是 SPA（回归：排除 /api/ 不能顺带破坏首页）
    const root = await api.get('/');
    assert.equal(root.status, 200);
    assert.match(root.headers['content-type'] || '', /text\/html/);
    assert.match(root.text, /^<!doctype html/i);
  });

  test('C：真实端点不受影响——排除 /api/ 没有破坏路由匹配', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    // 静态资源与真实 API 都要照旧工作，证明修复只收窄了"未命中"分支
    const health = await api.get('/api/health');
    assert.equal(health.status, 200);
    assert.match(health.headers['content-type'] || '', /application\/json/);
    assert.equal(health.json?.ok, true);

    const tasks = await api.get('/api/tasks');
    assert.equal(tasks.status, 200);
    assert.equal(tasks.json?.ok, true);

    // 已注册路由但资源不存在：仍是 404 JSON（这条路径修复前就正确，锁住不回退）
    const missing = await api.get('/api/tasks/nope/frames');
    assert.equal(missing.status, 404);
    assert.equal(missing.json?.error?.code, 'NOT_FOUND');
  });
});
