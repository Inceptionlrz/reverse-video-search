// 桥接端到端实测：上传帧到图床 → 拿公网 URL → 喂引擎 deep link → 看有没有结果。
//
// 单测"上传成功"没意义：图床返回的常是 HTML 预览页而非图片本体，
// 引擎拿这种 URL 去以图搜图会拿到空结果甚至报错。只有把整条链路跑通，
// 才能说"桥接这条路是活的"。19 号探针只测到上传，这一支测到结果。
//
// 用法：node scripts/probe/20-bridge-e2e.mjs [代理URL]

import fs from 'node:fs';
import path from 'node:path';
import { buildMultipart } from '../../server/lib/http/multipart.mjs';
import { request } from '../../server/lib/http/request.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PROXY = process.argv[2] ?? (process.env.RVS_PROXY === undefined ? 'http://127.0.0.1:7897' : process.env.RVS_PROXY);
const buf = fs.readFileSync(path.join(HERE, 'test-realframe.jpg'));

const cfg = { proxy: PROXY, connectTimeoutMs: 5000, tlsTimeoutMs: 12000, ttfbTimeoutMs: 15000, totalTimeoutMs: 40000 };

// 1) 上传
const mp = buildMultipart({
  fields: [],
  files: [{ field: 'file', filename: 'frame.jpg', contentType: 'image/jpeg', content: buf }],
});
const up = await request('https://tmpfiles.org/api/v1/upload', {
  config: cfg, proxy: PROXY, method: 'POST',
  headers: { 'Content-Type': mp.contentType }, body: mp.body,
});
console.log('上传:', up.status, String(up.body || '').slice(0, 120));
if (!up.ok) process.exit(1);

let url = null;
try {
  const j = JSON.parse(String(up.body || ''));
  url = j?.data?.url || j?.url || null;
} catch { /* 非 JSON */ }
if (!url) { console.log('无法从响应解析 URL'); process.exit(1); }
console.log('图床 URL:', url);

// 2) 该 URL 是否真返回图片（引擎要能直接取到图）
const img = await request(url, { config: cfg, proxy: PROXY, method: 'GET' });
const ct = String(img.headers?.['content-type'] || '');
console.log(`取图: status=${img.status} content-type=${ct} bytes=${String(img.body || '').length}`);
const isImage = ct.startsWith('image/');

// 3) 若不是图片，试 tmpfiles 的直连形态
let publicUrl = url;
if (!isImage) {
  const m = /tmpfiles\.org\/([A-Za-z0-9]+)\//.exec(url);
  if (m) {
    for (const cand of [`https://tmpfiles.org/dl/${m[1]}`, `https://tmpfiles.org/${m[1]}/frame.jpg`]) {
      const r = await request(cand, { config: cfg, proxy: PROXY, method: 'GET' });
      const c2 = String(r.headers?.['content-type'] || '');
      console.log(`  候选 ${cand}: status=${r.status} type=${c2}`);
      if (r.ok && c2.startsWith('image/')) { publicUrl = cand; break; }
    }
  }
}

// 4) 喂给 Bing deep link
const target = `https://www.bing.com/images/searchbyimage/upload?imgurl=${encodeURIComponent(publicUrl)}&cbir=sbi`;
const res = await request(target, { config: cfg, proxy: PROXY, method: 'GET' });
const iusc = String(res.body || '').match(/class="[^"]*\biusc\b[^"]*"/gi) || [];
console.log(`Bing deep link: status=${res.status} iusc 结果项=${iusc.length} latency=${res.latencyMs}ms`);
if (!res.ok) console.log('失败:', res.errorCode, res.errorMessage);

fs.writeFileSync(
  path.join(HERE, 'out-20-bridge-e2e.json'),
  JSON.stringify({ at: new Date().toISOString(), uploadStatus: up.status, imageHostUrl: url,
    fetchContentType: ct, usedUrl: publicUrl, bingStatus: res.status, iuscCount: iusc.length,
    bingError: res.errorCode ? { code: res.errorCode, message: res.errorMessage } : null }, null, 2)
);
