// 应用内真实端到端：对**正在运行的服务**跑完整链路，验收「不再一律降级为手动」。
//
// 与 20 号探针的区别：20 号直接调 provider 模块，证明「引擎 + 图床」这对组合能跑通；
// 本支走 HTTP API，把建任务、抽帧、授权、执行器、编排层、降级链全部带上——
// 只有这里出现 succeeded，才能说用户在界面上真的能拿到结果。
//
// 前置：服务需带 RVS_GITHUB_TOKEN / RVS_GITHUB_REPO 启动（图床要用）。
// 用法：node scripts/probe/23-app-e2e-bridge.mjs [baseURL] [视频路径]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnBinary } from '../../server/lib/media/probe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://127.0.0.1:4173';
const FFMPEG = process.env.RVS_FFMPEG || 'ffmpeg';

const api = async (method, urlPath, body) => {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
};

async function makeVideo(file) {
  await spawnBinary(FFMPEG, [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'smptehdbars=s=320x180:d=2:r=10',
    '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=2:r=10',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-pix_fmt', 'yuv420p', '-t', '4', file, '-y',
  ], { timeoutMs: 60000 });
  return file;
}

const video = process.argv[3] || path.join(os.tmpdir(), `rvs-e2e-${Date.now()}.mp4`);
if (!fs.existsSync(video)) await makeVideo(video);
console.log(`服务: ${BASE}`);
console.log(`视频: ${video}`);

// 0) 确认图床设置已指向 github
const settings = await api('GET', '/api/settings');
const ih = settings.json?.data?.writable?.imagehost;
console.log(`图床设置: enabled=${ih?.enabled} provider=${ih?.provider}`);
if (ih?.provider !== 'github') {
  const put = await api('PUT', '/api/settings', { imagehost: { enabled: true, provider: 'github' } });
  console.log(`  已改为 github: ${put.status} -> ${put.json?.data?.writable?.imagehost?.provider}`);
}

// 1) 建任务
const created = await api('POST', '/api/file-upload', {
  source_type: 'file', source_path: video, display_name: 'e2e.mp4',
  extract_mode: 'interval', max_frames: 2,
});
if (created.status !== 201) { console.log('建任务失败:', created.status, created.text.slice(0, 300)); process.exit(1); }
const taskId = created.json.data.task.id;
console.log(`任务: ${taskId}`);

// 2) 抽帧
await api('POST', `/api/tasks/${taskId}/extract`, { mode: 'interval', max_frames: 2 });
for (let i = 0; i < 80; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  const d = await api('GET', `/api/tasks/${taskId}`);
  const st = d.json?.data?.task?.status;
  if (st === 'frames_ready' || st === 'failed') break;
}
const framesRes = await api('GET', `/api/tasks/${taskId}/frames`);
const frames = framesRes.json?.data?.items || [];
console.log(`抽帧: ${frames.length} 帧`);

// 3) 授权：engines + bridge（站点 github）
const confirmed = await api('POST', `/api/tasks/${taskId}/confirm`, {
  engines: true, bridge: true, imagehost: 'github',
});
console.log(`授权: ${confirmed.status} consent=${JSON.stringify(confirmed.json?.data?.consent)}`);
if (confirmed.status !== 200) { console.log(confirmed.text.slice(0, 300)); process.exit(1); }

// 4) 只跑 Bing（省时，且 Bing 是唯一实测可用的引擎）
const run = await api('POST', '/api/search/run-analyses', { task_id: taskId, consent_ack: true, providers: ['bing'] });
console.log(`下发: ${run.status} 作业数=${run.json?.data?.analyses?.length ?? 0}`);

// 5) 等终态
let items = [];
for (let i = 0; i < 120; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const list = await api('GET', `/api/tasks/${taskId}/analyses`);
  items = list.json?.data?.items || [];
  if (items.length && items.every((a) => ['succeeded', 'zero_result', 'manual', 'failed', 'cancelled'].includes(a.status))) break;
}

// 结果数在 /api/results 上（analyses 表不存命中数，只存 status / attempt_mode）。
const results = await api('GET', `/api/results?task_id=${taskId}`);
const hits = results.json?.data?.items || [];

console.log('');
for (const a of items) {
  const log = Array.isArray(a.degradation_log) ? a.degradation_log : [];
  const last = log[log.length - 1];
  console.log(`${a.provider}: ${a.status} 方式=${a.attempt_mode ?? '-'} 来源=${a.hit_source ?? '-'} http=${a.http_status ?? '-'} ${a.latency_ms ?? '-'}ms`);
  if (a.error_code) console.log(`   末级: ${a.error_code} — ${a.error_message ?? '-'}`);
  if (last) console.log(`   日志末条: ${last.step} ok=${last.ok} ${last.code ?? ''} ${(last.message ?? '').slice(0, 120)}`);
  if (a.request_url) console.log(`   request_url: ${a.request_url}`);
}

console.log('');
console.log(`结果条目: ${hits.length}`);
for (const r of hits.slice(0, 5)) console.log(`  ${r.title || '(无标题)'} -> ${r.url}`);

const succeeded = items.filter((a) => a.status === 'succeeded');
console.log('');
console.log(`作业: ${succeeded.length}/${items.length} 条成功，结果 ${hits.length} 条`);
process.exit(succeeded.length && hits.length ? 0 : 1);
