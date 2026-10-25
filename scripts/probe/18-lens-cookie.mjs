// 复测 Google Lens 直传：带上 cookie jar 跟进 303。
//
// 为什么复测：此前 08-lens-result.js 跟进 303 后拿到 title="Google Search" 的空页面
// （/url?q= 0 命中、data-ved 0 命中），据此把 upload 留成 unverified、deeplink 判
// unavailable。但 proxy-client.js 没有 cookie jar——第 1 步 303 响应里的
// Set-Cookie: NID=... 没有带到第 2 步。浏览器会带，Google 对无 cookie 的请求
// 返回降级页。所以「跟进拿到空页」不等于「上传不被接受」，结论不成立，必须复测。
//
// 本脚本逐字节手写请求，通过 HTTP CONNECT 隧道走本机代理，与 proxy-client 同源。
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY_URL = process.env.RVS_PROXY || 'http://127.0.0.1:7897';
const PROXY = new URL(PROXY_URL);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 简易 cookie jar：按域名存取，只保留 name=value。 */
const jar = new Map();
function captureCookies(headers) {
  const set = headers['set-cookie'] || [];
  for (const raw of set) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function tunnel(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY.hostname, port: Number(PROXY.port) || 80,
      method: 'CONNECT', path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` }, timeout: 15000,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`CONNECT ${res.statusCode}`)); return; }
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(new Error('CONNECT timeout')));
    req.once('error', reject);
    req.end();
  });
}

function send(socket, url, method, headers, body) {
  const t = new URL(url);
  const port = Number(t.port) || 443;
  const isTls = t.protocol === 'https:';
  const sock = isTls ? tls.connect({ socket, servername: t.hostname }) : socket;
  if (isTls) sock.once('error', () => {});
  const h = { ...headers, Host: t.host, 'User-Agent': UA };
  const cookie = cookieHeader();
  if (cookie) h.Cookie = cookie;
  if (body && !h['Content-Length']) h['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const req = (isTls ? https : http).request({
      method, host: t.hostname, port, path: t.pathname + t.search,
      headers: h, createConnection: () => sock, agent: false, timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipart(fields, files) {
  const b = '----rvsBoundary' + Math.random().toString(36).slice(2, 12);
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  for (const [k, f] of Object.entries(files || {})) {
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType || 'image/jpeg'}\r\n\r\n`, 'utf8'));
    parts.push(f.buffer);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${b}--\r\n`, 'utf8'));
  return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${b}` };
}

const MARKERS = {
  '/url?q=': /\/url\?q=/g,
  'ext href': /href="https?:\/\/(?![\w.-]*google|[\w.-]*gstatic|policies|support|accounts)/g,
  data_ved: /data-ved/g,
  vsrid: /vsrid/g,
  lns_surface: /lns_surface/g,
  kb_focus: /data-lp-/g,
  script_AF: /AF_initDataCallback/g,
};

function report(label, s) {
  const out = { label };
  for (const [k, re] of Object.entries(MARKERS)) {
    const m = s.match(re);
    out[k] = m ? m.length : 0;
  }
  const title = (s.match(/<title>([^<]{0,140})<\/title>/) || [])[1] || '(none)';
  out.title = title;
  const samples = s.match(/href="https?:\/\/(?![\w.-]*google)[\w.-]+[^"]{0,70}/g) || [];
  out.samples = samples.slice(0, 6);
  return out;
}

async function run(label, uploadUrl, img) {
  console.log(`\n===== ${label}`);
  console.log(`  upload: POST ${uploadUrl.slice(0, 110)}`);
  const s1 = await tunnel('lens.google.com', 443);
  const mp = multipart({}, { encoded_image: { filename: 'frame.jpg', buffer: img, contentType: 'image/jpeg' } });
  const r1 = await send(s1, uploadUrl, 'POST', {
    'Content-Type': mp.contentType, Origin: 'https://lens.google.com',
    Referer: 'https://lens.google.com/', Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9',
  }, mp.buffer);
  s1.destroy();
  captureCookies(r1.headers);
  const loc = r1.headers.location || null;
  console.log(`  step1 -> status=${r1.status} bytes=${r1.body.length} cookies=[${[...jar.keys()].join(',')}]`);
  console.log(`  step1 -> location=${loc ? loc.slice(0, 130) : '(none)'}`);
  if (!loc) return { label, step1Status: r1.status, noLocation: true };

  const s2 = await tunnel('www.google.com', 443);
  const r2 = await send(s2, loc, 'GET', {
    Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://lens.google.com/',
  });
  s2.destroy();
  captureCookies(r2.headers);
  console.log(`  step2 -> status=${r2.status} bytes=${r2.body.length} ct=${(r2.headers['content-type'] || '').slice(0, 40)}`);
  const html = r2.body.toString('utf8');
  const rep = report(label, html);
  console.log(`  step2 -> title=${JSON.stringify(rep.title)}`);
  for (const [k, v] of Object.entries(rep)) {
    if (['label', 'title', 'samples'].includes(k)) continue;
    console.log(`    ${k.padEnd(12)} = ${v}`);
  }
  (rep.samples || []).forEach((x) => console.log('     sample:', x.slice(0, 120)));
  fs.writeFileSync(path.join(HERE, `out-H-${label.replace(/[^a-z0-9]/gi, '_')}.html`), r2.body);
  return { label, step1Status: r1.status, step2Status: r2.status, ...rep };
}

const IMG = fs.readFileSync(path.join(HERE, 'test-realframe.jpg'));
console.log(`代理 ${PROXY_URL}，测试图 ${IMG.length} 字节`);

const results = [];
results.push(await run('H1-v3-upload-plain', 'https://lens.google.com/v3/upload', IMG));
results.push(await run('H2-v3-upload-hl', 'https://lens.google.com/v3/upload?hl=zh-CN', IMG));

// 汇总判定：外部链接 + /url?q= 同时 > 0 才算「结果页可解析」
console.log('\n===== 汇总判定');
for (const r of results) {
  const parseable = (r['ext href'] || 0) > 0 && (r['/url?q='] || 0) > 0;
  console.log(`  ${r.label}: step1=${r.step1Status} step2=${r.step2Status} title=${JSON.stringify(r.title)} ext=${r['ext href'] || 0} urlq=${r['/url?q='] || 0} => ${parseable ? '可解析' : '不可解析'}`);
}
fs.writeFileSync(path.join(HERE, 'out-H-summary.json'), JSON.stringify(results, null, 2));
