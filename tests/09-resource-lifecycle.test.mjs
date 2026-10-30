// E2E 预备 A：资源生命周期——建任务→抽帧→分析→导出→删除，验证落盘资源与 DB 行被真正清理。
//
// 写测试前先跑了一遍全流程探查脚本摸真实磁盘产物，结论（都经 live 验证，非推断）：
//   frames/<taskId>/  : 抽帧产生 N 个 jpg；删除时逐文件删 + 整目录递归删 → 真正清零（本文件重点锁这条）
//   exports/          : ensureDirs 在启动时建目录，但导出是 sendBuffer 直接写 HTTP 响应，从不落盘 → 永远为空
//   thumbs/           : cfg 里根本没有 thumbsDir 字段；app.mjs 只用 path.join(dataDir,'thumbs') 喂静态路由，
//                       没有任何代码往里写文件 → 目录从不被创建（result.service 的缩略图哈希写 os.tmpdir() 且 finally 自清）
//   uploads/          : 只有 multipart 上传会产生，而 multipart 解析当前有 P0 bug（见报告），故此路径暂不可达
//   data 根目录        : 删除后残留 frames/ exports/ logs/ 三个空壳——它们是 ensureDirs 的启动脚手架，不是任务残留
//
// 因此断言按"实际行为"写，并把设计事实与疑似遗留问题分别注释，避免后人误读为测试放水。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  makeClient,
  makeOfflineConfig,
  makeTestVideo,
  requireMedia,
  seedFrame,
  seedTask,
  startApp,
  waitFor,
  waitForAnalysesSettled,
  waitForTaskStatus,
} from './helpers.mjs';

// 递归列出目录内容，返回排序后的 "[d] 名" / "[f] 名 大小B" 行；目录不存在返回 null。
function treeOf(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(`[d] ${r}`);
        walk(path.join(abs, e.name), r);
      } else {
        out.push(`[f] ${r} ${fs.statSync(path.join(abs, e.name)).size}B`);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

// 目录是否存在且至少有一个条目
function nonEmpty(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir).length > 0;
}

describe('E2E 预备 A：资源生命周期（删除后 frames/DB 真正清零）', () => {
  test('A1：全流程后删除任务，frames 落盘清零、DB 行清零、详情返 404 信封', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    const srcDir = path.join(tmp, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    // 顺序要紧：t.after 必须注册在 requireMedia 之前。
    // 跳过时函数提前 return，若清理钩子还没注册，app 永不 close ——
    // HTTP server 吊住事件循环，node --test 会挂到超时（实测 200s），
    // 而三个用例本身早已 skip，看上去像"莫名卡死"而非"清理没做"。
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    if (!(await requireMedia(t, cfg))) return;
    const video = await makeTestVideo(srcDir);

    // ---- 1. 建任务（JSON source_path：浏览器侧 multipart 另说，这里要的是可用的抽帧源）----
    const created = await api.post('/api/file-upload', {
      source_type: 'file',
      source_path: video,
      display_name: 'lifecycle.mp4',
      extract_mode: 'interval',
      max_frames: 4,
    });
    assert.equal(created.status, 201, `期望 201，实际 ${created.status} ${created.text.slice(0, 200)}`);
    const taskId = created.json?.data?.task?.id;
    assert.ok(taskId, '应返回 task_id');

    // ---- 2. 抽帧 ----
    const extract = await api.post(`/api/tasks/${taskId}/extract`, { mode: 'interval', max_frames: 4 });
    assert.equal(extract.status, 202);
    await waitForTaskStatus(api, taskId, 'frames_ready');

    const frameDir = path.join(cfg.framesDir, taskId);
    assert.ok(nonEmpty(frameDir), `删除前 frames/<taskId>/ 应非空，实际 ${JSON.stringify(treeOf(frameDir))}`);
    const jpgsBefore = fs.readdirSync(frameDir).filter((f) => f.endsWith('.jpg'));
    assert.ok(jpgsBefore.length > 0, '删除前应有 jpg 帧文件');

    const framesRes = await api.get(`/api/tasks/${taskId}/frames`);
    const frames = framesRes.json?.data?.items || [];
    assert.ok(frames.length > 0, '帧列表不应为空');
    assert.equal(frames.length, jpgsBefore.length, 'DB 帧行数应与磁盘 jpg 数一致');

    // ---- 3. 分析（离线模式落 manual，但会留下 analyses 行，用于验证 DB 清理）----
    const confirmed = await api.post(`/api/tasks/${taskId}/confirm`, { engines: true });
    assert.equal(confirmed.status, 200);
    const run = await api.post('/api/search/run-analyses', { task_id: taskId, providers: ['bing'], consent_ack: true });
    assert.equal(run.status, 202);
    const settled = await waitForAnalysesSettled(api, taskId);
    assert.ok(settled.length > 0, '应有 analysis 行');
    assert.ok(settled.every((a) => a.status === 'manual'), '离线模式应全部降级 manual');

    // ---- 4. 造结果与证据链（真实命中才有 result_hits；离线无命中，直接写仓储）----
    const result = await app.ctx.repos.results.upsert({
      url: 'https://example.com/page', title: '生命周期夹具', provider: 'bing', rank: 1,
    });
    assert.equal(result.reused, false, '应新建结果行');
    await app.ctx.repos.resultHits.insert({
      resultId: result.id,
      analysisId: settled[0].id,
      frameId: frames[0].id,
      taskId,
      provider: 'bing',
      rank: 1,
      scoreBasis: 'engine_rank',
      localHashSimilarity: null,
      sortScore: 50,
    });
    // 再造一个孤儿结果（无任何 hit），用于验证 deleteOrphans 会清掉它
    const orphan = await app.ctx.repos.results.upsert({
      url: 'https://orphan.example.com/x', title: '孤儿', provider: 'yandex', rank: 2,
    });

    // 注意：resultHits.list 返回 { items, total } 而非数组（仓储约定，与 results.list 一致）
    const hitsBefore = await app.ctx.repos.resultHits.list({ taskId, limit: 100 });
    assert.equal(hitsBefore.total, 1, '删除前应有 1 条证据链');

    // ---- 5. 导出：走 HTTP，验证是流式响应、不落盘 ----
    const csv = await api.get(`/api/export.csv?task_id=${taskId}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers['content-disposition'] || '', /attachment/);
    const js = await api.get(`/api/export.json?task_id=${taskId}`);
    assert.equal(js.status, 200);

    // ---- 6. 删除前快照 ----
    assert.ok(nonEmpty(frameDir), '删除前 frames/<taskId>/ 必须非空');
    assert.ok((await app.ctx.repos.frames.listByTask(taskId, {})).length > 0, '删除前 DB 有帧行');
    assert.ok((await app.ctx.repos.analyses.listByTask(taskId, { limit: 100 })).length > 0, '删除前 DB 有分析行');

    // ---- 7. 删除 ----
    const del = await api.del(`/api/tasks/${taskId}`);
    assert.equal(del.status, 200, `期望 200，实际 ${del.status} ${del.text.slice(0, 200)}`);
    assert.equal(del.json?.data?.deleted, true);

    // ---- 8. 删除后：磁盘清零 ----
    assert.equal(fs.existsSync(frameDir), false,
      `frames/<taskId>/ 必须被删除，实际 ${JSON.stringify(treeOf(frameDir))}`);
    assert.equal(fs.readdirSync(cfg.framesDir).length, 0,
      `frames/ 根下不应残留任务子目录，实际 ${JSON.stringify(treeOf(cfg.framesDir))}`);

    // ---- 9. 删除后：DB 行清零 ----
    assert.equal((await app.ctx.repos.frames.listByTask(taskId, {})).length, 0, '帧行应清零');
    assert.equal((await app.ctx.repos.analyses.listByTask(taskId, { limit: 100 })).length, 0, '分析行应清零');
    assert.equal((await app.ctx.repos.resultHits.list({ taskId, limit: 100 })).total, 0, '证据链应清零');
    const orphanAfter = await app.ctx.repos.results.get(orphan.id);
    assert.equal(orphanAfter, null, '无证据链的孤儿结果应被 deleteOrphans 清掉');
    const ownResultAfter = await app.ctx.repos.results.get(result.id);
    assert.equal(ownResultAfter, null, '本任务结果在证据链删除后也应成为孤儿被清掉');

    // ---- 10. 删除后：接口返 404 信封 ----
    const detail = await api.get(`/api/tasks/${taskId}`);
    assert.equal(detail.status, 404, `期望 404，实际 ${detail.status}`);
    assert.match(detail.headers['content-type'] || '', /application\/json/);
    assert.equal(detail.json?.ok, false);
    assert.equal(detail.json?.error?.code, 'NOT_FOUND');

    // ---- 11. 删除后：不再出现在列表里 ----
    const list = await api.get('/api/tasks');
    const ids = (list.json?.data?.items || []).map((x) => x.id);
    assert.equal(ids.includes(taskId), false, '已删除任务不应出现在列表');

    // ---- 12. 授权记录一并清除 ----
    const consentRow = await app.ctx.repos.settings.get(`consent:${taskId}`);
    assert.equal(consentRow, null, 'consent 设置行应被清除');
  });

  test('A2：导出不落盘、thumbs 从不被创建（设计事实，防止有人误加落盘逻辑）', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    const srcDir = path.join(tmp, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    // 顺序要紧：t.after 必须注册在 requireMedia 之前。
    // 跳过时函数提前 return，若清理钩子还没注册，app 永不 close ——
    // HTTP server 吊住事件循环，node --test 会挂到超时（实测 200s），
    // 而三个用例本身早已 skip，看上去像"莫名卡死"而非"清理没做"。
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    if (!(await requireMedia(t, cfg))) return;
    const video = await makeTestVideo(srcDir);

    const exportsDir = cfg.exportsDir;
    const thumbsDir = path.join(cfg.dataDir, 'thumbs');

    // 前置事实：exports/ 由 ensureDirs 启动时创建且为空；thumbs/ 启动时压根不存在
    assert.equal(fs.existsSync(exportsDir), true, 'exports/ 应由 ensureDirs 创建');
    assert.equal(fs.readdirSync(exportsDir).length, 0, '初始 exports/ 应为空');
    assert.equal(fs.existsSync(thumbsDir), false,
      'thumbs/ 启动时不应存在（cfg 无 thumbsDir 字段，无任何代码创建它）');

    const created = await api.post('/api/file-upload', {
      source_type: 'file', source_path: video, display_name: 'no-disk.mp4',
      extract_mode: 'interval', max_frames: 3,
    });
    const taskId = created.json?.data?.task?.id;
    await api.post(`/api/tasks/${taskId}/extract`, { mode: 'interval', max_frames: 3 });
    await waitForTaskStatus(api, taskId, 'frames_ready');

    // 反复导出（含空结果集与带结果集两种），exports/ 必须始终为空
    await api.get(`/api/export.csv?task_id=${taskId}`);
    await api.get(`/api/export.json?task_id=${taskId}`);
    await api.get('/api/export.csv');
    await api.get('/api/export.json');
    assert.equal(fs.readdirSync(exportsDir).length, 0,
      `导出是 sendBuffer 流式响应，不应在 exports/ 落盘，实际 ${JSON.stringify(treeOf(exportsDir))}`);

    // 抽帧 + 分析 + 访问帧路由，都不该凭空创建 thumbs/
    await api.post(`/api/tasks/${taskId}/confirm`, { engines: true });
    await api.post('/api/search/run-analyses', { task_id: taskId, providers: ['bing'], consent_ack: true });
    await waitForAnalysesSettled(api, taskId);
    const framesRes = await api.get(`/api/tasks/${taskId}/frames`);
    const first = (framesRes.json?.data?.items || [])[0];
    if (first?.preview_url) await api.get(first.preview_url);
    assert.equal(fs.existsSync(thumbsDir), false,
      '没有任何代码写 thumbs/，全流程后该目录仍不应存在');
  });

  test('A3：删除后 data 根目录只剩启动脚手架，无任务级残留', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    const api = makeClient(app.server.address().port);
    const srcDir = path.join(tmp, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    // 顺序要紧：t.after 必须注册在 requireMedia 之前。
    // 跳过时函数提前 return，若清理钩子还没注册，app 永不 close ——
    // HTTP server 吊住事件循环，node --test 会挂到超时（实测 200s），
    // 而三个用例本身早已 skip，看上去像"莫名卡死"而非"清理没做"。
    t.after(async () => {
      await app.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    if (!(await requireMedia(t, cfg))) return;
    const video = await makeTestVideo(srcDir);

    const created = await api.post('/api/file-upload', {
      source_type: 'file', source_path: video, display_name: 'scaffold.mp4',
      extract_mode: 'interval', max_frames: 2,
    });
    const taskId = created.json?.data?.task?.id;
    await api.post(`/api/tasks/${taskId}/extract`, { mode: 'interval', max_frames: 2 });
    await waitForTaskStatus(api, taskId, 'frames_ready');

    await api.del(`/api/tasks/${taskId}`);

    const top = fs.readdirSync(cfg.dataDir).sort();
    // 允许的残留：ensureDirs 的启动脚手架 + sqlite 三件套。不允许任何任务级产物。
    const allowed = new Set(['frames', 'exports', 'logs', 'rvs.db', 'rvs.db-shm', 'rvs.db-wal']);
    const unexpected = top.filter((n) => !allowed.has(n));
    assert.deepEqual(unexpected, [],
      `删除后 data 根不应有任务级残留，意外项：${JSON.stringify(unexpected)}（实际顶层 ${JSON.stringify(top)}）`);

    // frames/ 与 exports/ 必须为空（logs/ 有运行日志，不要求空）
    assert.equal(fs.readdirSync(cfg.framesDir).length, 0, 'frames/ 根应为空');
    assert.equal(fs.readdirSync(cfg.exportsDir).length, 0, 'exports/ 应为空');
    // uploads/ 当前不可达（multipart P0），修好后需重新评估是否应在此列黑名单
    assert.equal(fs.existsSync(path.join(cfg.dataDir, 'uploads')), false,
      '当前 multipart 不可用，不应产生 uploads/；P0 修复后需复查此断言');

    // 空壳目录本身：frames/exports/logs 是 ensureDirs 产物，删除任务不该也不能删掉它们
    // （下一个任务还要用）。这点作为已知行为记录，不做"应该被删掉"的断言。
  });
});
