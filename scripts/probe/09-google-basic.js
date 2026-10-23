'use strict';
// Google 结果页是否需要 JS？试 gbv=1 / noscript 通道 / 简易 UA
const { request, multipart } = require('./proxy-client');
const fs = require('node:fs');

const IMG = fs.readFileSync(__dirname + '/test-realframe.jpg');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function go(label, url, opts) {
  try {
    const r = await request(url, { followRedirect: true, timeout: 60000, ...opts });
    const s = r.body.toString('utf8');
    const ext = (s.match(/href="https?:\/\/(?![\w.]*google|[\w.]*gstatic|[\w.]*youtube|policies|support|accounts|maps)[\w.\-]+[^"]{0,60}/g) || []);
    console.log(`\n[${label}] status=${r.status} bytes=${r.body.length}`);
    console.log(`  final=${r.finalUrl.slice(0, 130)}`);
    console.log(`  title=${JSON.stringify((s.match(/<title>([^<]{0,80})<\/title>/) || [])[1])}`);
    console.log(`  external href = ${ext.length}`);
    ext.slice(0, 6).forEach((x) => console.log('    ', x.slice(0, 120)));
    console.log(`  enablejs marker = ${/httpservice\/retry\/enablejs/.test(s)}`);
    fs.writeFileSync(__dirname + '/out-g-' + label.replace(/[^a-z0-9]/gi, '_') + '.html', r.body);
  } catch (e) {
    console.log(`\n[${label}] ERROR ${e.message}`);
  }
}

(async () => {
  const mp = multipart({}, { encoded_image: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  const r1 = await request('https://lens.google.com/v3/upload', {
    method: 'POST', followRedirect: false, timeout: 60000,
    headers: { 'Content-Type': mp.contentType, Origin: 'https://lens.google.com', Referer: 'https://lens.google.com/', 'User-Agent': UA },
    body: mp.buffer,
  });
  const loc = r1.headers.location;
  console.log(`upload -> ${r1.status}, loc=${loc.slice(0, 100)}`);

  await go('A-plain', loc, { method: 'GET', headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
  await go('B-gbv1', loc + '&gbv=1', { method: 'GET', headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
  await go('C-noscriptUA', loc, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } });
  await go('D-lynx', loc, { method: 'GET', headers: { 'User-Agent': 'Lynx/2.9.0dev.libwww-FM/2.14', Accept: 'text/html' } });
  await go('E-udm26', loc.replace('vsrid=', 'udm=26&vsrid='), { method: 'GET', headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } });
})();
