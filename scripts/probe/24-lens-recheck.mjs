// Google Lens / Google 以图搜图 深链复测。
//
// 上一轮结论（2026-10-25）是「Lens 结果页由 JS 渲染，HTTP 层拿不到」，
// 据此把 deeplink/bridge 都标成 unavailable，编排层直接跳到 manual——
// 用户看到的就是「谷歌只能手动上传」。
//
// 但上一轮只测了 Lens 的两个端点（v3/upload 的 303 落地页、uploadbyurl）。
// 漏测的是经典端点 https://www.google.com/searchbyimage?image_url=...：
// 它 302 到 /search?tbs=sbi:... 的结果页，历史上是**服务端渲染**的。
// 本支把它和其余候选一起实测，拿响应体说话。
//
// 用法：node scripts/probe/24-lens-recheck.mjs [图片公网URL]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/lib/config.mjs';
import { request } from '../../server/lib/http/request.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const cfg = loadConfig(process.env);
const PROXY = cfg.proxy;
const IMG = process.argv[2] || 'https://raw.githubusercontent.com/Inceptionlrz/reverse-video-search/frames/2026-10-30/probe-1793378970208.jpg';
const enc = encodeURIComponent(IMG);

const CANDIDATES = {
  'G1-classic-searchbyimage': `https://www.google.com/searchbyimage?image_url=${enc}&hl=zh-CN`,
  'G2-searchbyimage-no-hl': `https://www.google.com/searchbyimage?image_url=${enc}`,
  'G3-lens-uploadbyurl': `https://lens.google.com/uploadbyurl?url=${enc}&hl=zh-CN`,
  'G4-search-tbs-sbi': `https://www.google.com/search?tbs=sbi%3A${enc}&hl=zh-CN&safe=off`,
  'G5-lens-uploadbyurl-plain': `https://lens.google.com/uploadbyurl?url=${enc}`,
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 结果页里"有数据"的判据（与项目现有解析策略对齐的粗判）：
// 只要有可提取的候选锚点或已知结构标记，就说明服务端给了内容。
function score(body) {
  const t = String(body || '');
  return {
    bytes: t.length,
    '/url?q=': (t.match(/\/url\?q=/g) || []).length,
    'data-ved': (t.match(/data-ved=/g) || []).length,
    'AF_initDataCallback': (t.match(/AF_initDataCallback/g) || []).length,
    '<a href="http': (t.match(/<a href="http/g) || []).length,
    'enablejs': t.includes('/httpservice/retry/enablejs') ? 1 : 0,
    'sbi/视觉匹配标记': (t.match(/视觉匹配|Visual match|sbi:/g) || []).length,
    '通用锚点': (t.match(/<a\b[^>]+href="https?:\/\/[^"]+"/g) || []).length,
  };
}

for (const [name, start] of Object.entries(CANDIDATES)) {
  let target = start;
  const hops = [];
  let last = null;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await request(target, {
      config: cfg, proxy: PROXY, method: 'GET',
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    hops.push(`${new URL(target).host}:${res.status}`);
    last = res;
    const loc = res.headers?.location;
    if (res.status >= 300 && res.status < 400 && loc) { target = new URL(loc, target).href; continue; }
    break;
  }
  const s = score(last?.body);
  console.log(`\n${name}`);
  console.log(`  链: ${hops.join(' -> ')}`);
  console.log(`  ok=${last?.ok} bytes=${s.bytes}`);
  console.log(`  判据: ${JSON.stringify(s)}`);
  if (!last?.ok) console.log(`  失败: ${last?.errorCode} — ${last?.errorMessage}`);
  fs.writeFileSync(
    path.join(HERE, `out-24-${name}.html`),
    `<!-- ${start} -->\n${String(last?.body || '')}`,
  );
}
console.log('\n产物：scripts/probe/out-24-*.html');
