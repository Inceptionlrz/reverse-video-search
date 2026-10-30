// 图床桥接实测：三家内置匿名图床到底还能不能用。
//
// 为什么必须有这个探针：三家适配器写好后从未对真实服务发过一个字节，
// 文件头一律标着「证据 E-17/18/19（形态存在，未验证返回值）」、verified:false，
// 却在设置与授权弹窗里当作可选项提供给用户——用户勾了桥接、选了站点，
// 结果 24/36 组合全降到手动，理由还被写成"页面结构无法解析"。
// 「未验证」不等于「可用」，把没验过的东西摆成选项是这个缺陷的根。
//
// 用法：node scripts/probe/19-imagehost.mjs [代理URL]
// 产物：scripts/probe/out-19-imagehost.json（每家的状态、耗时、响应片段）

import fs from 'node:fs';
import path from 'node:path';
import { buildMultipart } from '../../server/lib/http/multipart.mjs';
import { request } from '../../server/lib/http/request.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const PROXY = process.argv[2] ?? (process.env.RVS_PROXY === undefined ? 'http://127.0.0.1:7897' : process.env.RVS_PROXY);

// 一张真 JPEG：用仓库内既有夹具，避免为探针引入 ffmpeg 依赖
const IMG = path.join(HERE, 'test-realframe.jpg');
const buf = fs.readFileSync(IMG);

const HOSTS = [
  {
    id: 'catbox',
    endpoint: 'https://catbox.moe/user/api.php',
    fields: [{ name: 'reqtype', value: 'fileupload' }],
    fileField: 'fileToUpload',
  },
  {
    id: '0x0',
    endpoint: 'https://0x0.st/',
    fields: [],
    fileField: 'file',
  },
  {
    id: 'tmpfiles',
    endpoint: 'https://tmpfiles.org/api/v1/upload',
    fields: [],
    fileField: 'file',
  },
];

const cfg = { proxy: PROXY, connectTimeoutMs: 5000, tlsTimeoutMs: 12000, ttfbTimeoutMs: 15000, totalTimeoutMs: 40000 };

const results = [];
for (const host of HOSTS) {
  const mp = buildMultipart({
    fields: host.fields,
    files: [{ field: host.fileField, filename: 'frame.jpg', contentType: 'image/jpeg', content: buf }],
  });
  const res = await request(host.endpoint, {
    config: cfg,
    proxy: PROXY,
    method: 'POST',
    headers: { 'Content-Type': mp.contentType },
    body: mp.body,
  });
  const snippet = String(res.body || '').trim().slice(0, 160);
  // 成功判据沿用生产逻辑：2xx 且响应体能解析出 http(s) 链接
  const url = res.ok && /^https?:\/\/\S+$/i.test(snippet) ? snippet.split(/\s+/)[0] : null;
  let parsed = null;
  try { parsed = JSON.parse(String(res.body || '')); } catch { /* 非 JSON */ }
  const jsonUrl = parsed?.data?.url || parsed?.url || null;

  results.push({
    id: host.id,
    endpoint: host.endpoint,
    ok: res.ok,
    usable: Boolean(url || jsonUrl),
    status: res.status ?? null,
    errorCode: res.errorCode ?? null,
    errorMessage: res.errorMessage ?? null,
    latencyMs: res.latencyMs ?? null,
    returnedUrl: url || jsonUrl || null,
    bodySnippet: snippet,
  });
  console.log(
    `${host.id.padEnd(9)} status=${String(res.status ?? '-').padEnd(4)} ` +
    `usable=${String(Boolean(url || jsonUrl)).padEnd(5)} ${res.latencyMs ?? '-'}ms  ${snippet.slice(0, 70) || res.errorMessage || ''}`
  );
}

const out = path.join(HERE, 'out-19-imagehost.json');
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), proxy: PROXY, image: path.basename(IMG), results }, null, 2));
console.log(`\n产物：${out}`);
