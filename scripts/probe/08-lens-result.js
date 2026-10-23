'use strict';
// Lens multipart 上传 -> 跟随 303 -> 抓取结果页 -> 判断能否解析结构化结果
const { request, multipart } = require('./proxy-client');
const fs = require('node:fs');

const IMG = fs.readFileSync(__dirname + '/test-realframe.jpg');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const mp = multipart({}, { encoded_image: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  const r1 = await request('https://lens.google.com/v3/upload', {
    method: 'POST', followRedirect: false, timeout: 60000,
    headers: { 'Content-Type': mp.contentType, Origin: 'https://lens.google.com', Referer: 'https://lens.google.com/', 'User-Agent': UA },
    body: mp.buffer,
  });
  console.log(`STEP1 upload -> ${r1.status}`);
  const loc = r1.headers.location;
  console.log(`STEP1 location = ${loc ? loc.slice(0, 120) : '(none)'}`);
  if (!loc) return;

  const r2 = await request(loc, {
    method: 'GET', followRedirect: true, timeout: 60000,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
  });
  console.log(`\nSTEP2 result page -> ${r2.status} bytes=${r2.body.length} ct=${(r2.headers['content-type'] || '').slice(0, 40)}`);
  console.log(`STEP2 finalUrl = ${r2.finalUrl.slice(0, 160)}`);
  fs.writeFileSync(__dirname + '/out-google-result.html', r2.body);
  const s = r2.body.toString('utf8');
  const title = (s.match(/<title>([^<]{0,120})<\/title>/) || [])[1];
  console.log(`STEP2 title = ${JSON.stringify(title)}`);

  const pats = {
    '/url?q=': /\/url\?q=/g,
    'href="http ext': /href="https?:\/\/(?![\w.]*google|[\w.]*gstatic|policies|support|accounts)/g,
    'data-ved': /data-ved/g,
    'vsrid': /vsrid/g,
    'Gsearch': /class="[^"]*(?:g|G)search/g,
  };
  for (const [k, re] of Object.entries(pats)) {
    const m = s.match(re);
    console.log(`    ${k.padEnd(18)} = ${m ? m.length : 0}`);
  }
  const samples = s.match(/href="https?:\/\/(?![\w.]*google)[\w.\-]+[^"]{0,80}/g) || [];
  console.log(`\n  external href samples (${samples.length}):`);
  samples.slice(0, 8).forEach((x) => console.log('   ', x.slice(0, 130)));
})();
