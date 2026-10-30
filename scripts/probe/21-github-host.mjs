// GitHub 图床端到端实测：上传帧 → 拿直链 → 确认是图片 → 喂 Bing deep link → 数结果。
//
// 这是"桥接这条路到底活不活"的判据。19 号探针只测到上传，20 号暴露了
// tmpfiles 上传成功但链接是 HTML 预览页的假成功。本支对 github 图床跑完整链路。

import fs from 'node:fs';
import path from 'node:path';
import { request } from '../../server/lib/http/request.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PROXY = process.argv[2] ?? 'http://127.0.0.1:7897';
const TOKEN = process.env.RVS_GITHUB_TOKEN;
const REPO = process.env.RVS_GITHUB_REPO;
const BRANCH = process.env.RVS_GITHUB_BRANCH || 'frames';
if (!TOKEN || !REPO) {
  console.error('需要 RVS_GITHUB_TOKEN 与 RVS_GITHUB_REPO');
  process.exit(2);
}

const cfg = { proxy: PROXY, connectTimeoutMs: 5000, tlsTimeoutMs: 12000, ttfbTimeoutMs: 15000, totalTimeoutMs: 40000 };
const buf = fs.readFileSync(path.join(HERE, 'test-realframe.jpg'));

const relPath = `probe/${Date.now()}.jpg`;
const endpoint = `https://api.github.com/repos/${REPO}/contents/${relPath}`;
const up = await request(endpoint, {
  config: cfg, proxy: PROXY, method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${TOKEN}`,
    'User-Agent': 'reverse-video-search',
  },
  body: JSON.stringify({ message: `probe ${relPath}`, content: buf.toString('base64'), branch: BRANCH }),
});
console.log('上传:', up.status);
if (!up.ok) { console.log('失败:', up.errorCode, up.errorMessage); process.exit(1); }

const url = JSON.parse(String(up.body)).content?.download_url;
console.log('直链:', url);

const img = await request(url, { config: cfg, proxy: PROXY, method: 'GET', maxBodyBytes: 1024 });
const ct = String(img.headers?.['content-type'] || '');
console.log(`取图: status=${img.status} content-type=${ct}`);
if (!ct.startsWith('image/')) {
  console.log('链接不是图片本体，桥接不可用');
  process.exit(1);
}

// 与 bing.mjs 一致：request 不自动跟随 3xx，这里最多跟 2 跳取结果页
let target = `https://www.bing.com/images/searchbyimage/upload?imgurl=${encodeURIComponent(url)}&cbir=sbi`;
let res = null;
let iusc = [];
const hops = [];
for (let hop = 0; hop < 3; hop += 1) {
  res = await request(target, { config: cfg, proxy: PROXY, method: 'GET' });
  hops.push({ url: target, status: res.status });
  if (!res.ok) break;
  const loc = res.headers?.location;
  if (res.status >= 300 && res.status < 400 && loc) {
    target = new URL(loc, target).href;
    continue;
  }
  iusc = String(res.body || '').match(/class="[^"]*\biusc\b[^"]*"/gi) || [];
  break;
}
console.log('跳转链:', hops.map((h) => `${h.status}`).join(' -> '));
console.log(`Bing 结果页: status=${res.status} iusc 结果项=${iusc.length}`);
if (!res.ok) console.log('失败:', res.errorCode, res.errorMessage);

fs.writeFileSync(
  path.join(HERE, 'out-21-github-host.json'),
  JSON.stringify({ at: new Date().toISOString(), uploadStatus: up.status, url,
    contentType: ct, hops, bingStatus: res.status, iuscCount: iusc.length }, null, 2)
);
