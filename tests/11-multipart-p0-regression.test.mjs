// 回归测试（commit 0f6494f / adb98f9）：multipart 上传解析与上传源文件的删除清理。
//
// 背景：浏览器 FormData 是前端唯一上传通道（浏览器拿不到本地文件绝对路径），
// 但 POST /api/file-upload 的 multipart 分支此前 100% 失败，而 smoke 与既有测试
// 一直走 JSON source_path，所以从未暴露。修复时查明两处 bug：
//   bug 1（off-by-2）：part-head 头部从字节 4 起切（应为 2），首行头部被削掉前 2 字节，
//        Content-Disposition → ntent-Disposition，name/filename 正则失配 → 400。
//   bug 2（delimiter 搜索起点错误）：body 状态机用 searchFrom = buf.length - D - 4
//        做尾部优化，同一 chunk 里 delimiter 后还跟着后续 part 时真正的边界被跳过、
//        改配更后面的 delimiter，中间 part 的头与值全被吞进当前 part 本体
//        ——表现为字段全部回退默认值、文件落盘体积大于原文件（被污染）。
// 本文件把两处 bug 连同删除清理的边界一起锁住：解析器层（纯离线）+ HTTP 层（真实链路）。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { makeClient, makeOfflineConfig, startApp } from './helpers.mjs';
import { readMultipart } from '../server/lib/http/multipart-read.mjs';
import { spawnBinary } from '../server/lib/media/probe.mjs';

const BOUNDARY = '----rvsTestBoundary0f6494f';

// 手工拼装 multipart body：parts = [{name, filename?, contentType?, body:Buffer|string}]
// 注意：整体作为一个 Buffer 一次性写入——这正是触发 bug 2 的形态（delimiter 后跟 >4 字节）。
function buildMultipart(parts, boundary = BOUNDARY) {
  const chunks = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`
      : `Content-Disposition: form-data; name="${part.name}"`;
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    chunks.push(Buffer.from(`${disposition}\r\n`, 'utf8'));
    if (part.contentType) chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`, 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(String(part.body), 'utf8'));
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function toReq(buffer, contentType) {
  return Readable.from([buffer], { objectMode: false });
}

async function readParsed(parts, { boundary = BOUNDARY, uploadDir } = {}) {
  const buffer = buildMultipart(parts, boundary);
  const req = toReq(buffer);
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return readMultipart(req, { uploadDir: uploadDir || fs.mkdtempSync(path.join(os.tmpdir(), 'rvs-mp-')) });
}

// node:http 裸请求（全仓库禁 fetch，multipart 不能用 httpCall 的 JSON 通道）
function postRaw(port, pathName, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: pathName,
        headers: { 'content-type': contentType, 'content-length': buffer.length, Connection: 'close' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON 保持原文 */ }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function makeTinyVideo(dir, name = 'tiny.mp4') {
  const file = path.join(dir, name);
  await spawnBinary('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=128x96:d=1:r=5', '-pix_fmt', 'yuv420p', file, '-y'], { timeoutMs: 60000 });
  return file;
}

describe('multipart 解析回归（bug 1 off-by-2 / bug 2 delimiter 搜索起点）', () => {
  test('P1：文件在前 + 字段在后——字段全部解析且文件字节精确相等（无污染）', async () => {
    // 4 个字段跟随文件 part：bug 2 修复前这些字段的头与值会被吞进文件本体
    const payload = Buffer.alloc(4096);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const { fields, files } = await readParsed([
      { name: 'file', filename: 'clip.mp4', contentType: 'video/mp4', body: payload },
      { name: 'title', body: '显式标题' },
      { name: 'extract_mode', body: 'scene' },
      { name: 'max_frames', body: '3' },
      { name: 'scene_threshold', body: '0.4' },
    ]);

    assert.equal(files.length, 1, '应解析出 1 个文件 part');
    assert.equal(files[0].field, 'file', '文件字段名（bug 1 回归：name 解析）');
    assert.equal(files[0].filename, 'clip.mp4', '原始文件名（bug 1 回归：filename 解析）');
    assert.equal(files[0].contentType, 'video/mp4', 'Content-Type 解析');
    // bug 2 的核心断言：落盘文件必须与源字节完全一致，多一个字节就是被后续 part 污染
    const onDisk = fs.readFileSync(files[0].path);
    assert.equal(onDisk.length, payload.length, `落盘文件字节数应等于源文件（污染回归）：期望 ${payload.length}，实际 ${onDisk.length}`);
    assert.ok(onDisk.equals(payload), '落盘文件内容应与源字节完全一致');
    assert.ok(!onDisk.toString('latin1').includes('--' + BOUNDARY), '文件体内不得混入 boundary');

    assert.equal(fields.title, '显式标题', 'title 字段（bug 2 回归）');
    assert.equal(fields.extract_mode, 'scene', 'extract_mode 字段（bug 2 回归）');
    assert.equal(fields.max_frames, '3', 'max_frames 字段（bug 2 回归）');
    assert.equal(fields.scene_threshold, '0.4', 'scene_threshold 字段（bug 2 回归）');
  });

  test('P2：字段在前 + 文件在后——顺序无关，同样不污染', async () => {
    const payload = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0x2d, 0x2d, 0xff, 0xfe]); // 内含 \r\n-- 的刁钻字节
    const { fields, files } = await readParsed([
      { name: 'title', body: '前置字段' },
      { name: 'file', filename: 'a.mp4', contentType: 'video/mp4', body: payload },
      { name: 'max_frames', body: '7' },
    ]);

    assert.equal(files.length, 1);
    assert.ok(fs.readFileSync(files[0].path).equals(payload), '文件字节应精确相等（含类边界字节）');
    assert.equal(fields.title, '前置字段');
    assert.equal(fields.max_frames, '7');
  });

  test('P3：空字段值与多字段连续——空值不过界、后续 part 不受影响', async () => {
    const payload = Buffer.from('body-bytes');
    const { fields, files } = await readParsed([
      { name: 'empty', body: '' },
      { name: 'file', filename: 'b.mp4', body: payload },
      { name: 'tail', body: '尾部字段' },
    ]);

    assert.equal(fields.empty, '', '空字段应为空字符串而非 undefined（不能吃掉后面的 part）');
    assert.equal(fields.tail, '尾部字段');
    assert.ok(fs.readFileSync(files[0].path).equals(payload), '空字段不得导致文件被污染');
  });
});

describe('multipart 上传端到端与删除清理（commit 0f6494f / adb98f9）', () => {
  test('E1：真实上传——字段生效、落盘字节等于源文件、任务可创建', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });

    const dir = fs.mkdtempSync(path.join(tmp, 'src-'));
    const source = await makeTinyVideo(dir);
    const sourceBytes = fs.readFileSync(source);

    const body = buildMultipart([
      { name: 'file', filename: 'tiny.mp4', contentType: 'video/mp4', body: sourceBytes },
      { name: 'title', body: 'E1 显式标题' },
      { name: 'extract_mode', body: 'scene' },
      { name: 'max_frames', body: '3' },
      { name: 'scene_threshold', body: '0.4' },
    ]);
    const res = await postRaw(app.server.address().port, '/api/file-upload', body, `multipart/form-data; boundary=${BOUNDARY}`);

    assert.equal(res.status, 201, `上传应返回 201，实际 ${res.status}：${res.text.slice(0, 200)}`);
    const task = res.json?.data?.task;
    assert.ok(task, '响应应含 task');
    assert.equal(task.display_name, 'E1 显式标题', 'title 字段应生效（bug 1+2 联合回归）');
    assert.equal(task.extract_mode, 'scene', 'extract_mode 应生效');
    assert.equal(task.max_frames, 3, 'max_frames 应生效');
    assert.equal(task.scene_threshold, 0.4, 'scene_threshold 应生效');

    const uploaded = task.source_path;
    assert.ok(fs.existsSync(uploaded), '上传文件应落盘');
    assert.equal(fs.readFileSync(uploaded).length, sourceBytes.length, '落盘字节数应等于源文件（污染回归）');
    assert.ok(fs.readFileSync(uploaded).equals(sourceBytes), '落盘内容应与源字节完全一致');
  });

  test('E2：删除任务清理 uploads 暂存区——文件与暂存目录一并清除', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });

    const dir = fs.mkdtempSync(path.join(tmp, 'src-'));
    const source = await makeTinyVideo(dir);
    const body = buildMultipart([
      { name: 'file', filename: 'tiny.mp4', contentType: 'video/mp4', body: fs.readFileSync(source) },
    ]);
    const created = await postRaw(app.server.address().port, '/api/file-upload', body, `multipart/form-data; boundary=${BOUNDARY}`);
    assert.equal(created.status, 201, created.text.slice(0, 200));

    const taskId = created.json.data.task.id;
    const stagingDir = path.dirname(created.json.data.task.source_path);
    assert.ok(fs.existsSync(stagingDir), '删除前暂存目录应存在');

    const api = makeClient(app.server.address().port);
    const del = await api.del(`/api/tasks/${taskId}`);
    assert.equal(del.json?.ok, true, '删除应成功');

    assert.equal(fs.existsSync(created.json.data.task.source_path), false, '删除后源文件应被清除（EARS #20 补全）');
    assert.equal(fs.existsSync(stagingDir), false, '删除后暂存目录应被清除（非递归移除，仅空目录成功）');

    const detail = await api.get(`/api/tasks/${taskId}`);
    assert.equal(detail.status, 404, '删除后详情应 404');
    assert.equal(detail.json?.ok, false, '删除后详情应为错误信封');
    assert.equal(detail.json?.error?.code, 'NOT_FOUND', '错误码应为 NOT_FOUND');
  });

  test('E3：JSON 建任务——source_path 在 uploads 之外时删除任务不得删源文件', async (t) => {
    const { cfg, tmp } = makeOfflineConfig();
    const app = await startApp(cfg);
    t.after(async () => { await app.close().catch(() => {}); });

    // 关键边界：JSON 建任务时 source_path 指向用户磁盘上的原始文件，
    // 删除任务只能清 uploads 暂存区内的副本，绝不能删用户的源视频。
    const dir = fs.mkdtempSync(path.join(tmp, 'user-'));
    const userVideo = await makeTinyVideo(dir, 'user-clip.mp4');

    const api = makeClient(app.server.address().port);
    const created = await api.post('/api/file-upload', { source_type: 'file', source_path: userVideo, display_name: '用户原文件' });
    assert.equal(created.json?.ok, true, `建任务应成功：${created.text.slice(0, 200)}`);

    const taskId = created.json.data.task.id;
    await api.del(`/api/tasks/${taskId}`);
    assert.ok(fs.existsSync(userVideo), '删除任务不得删除 uploads 之外的用户源视频（路径前缀守卫）');
  });
});
