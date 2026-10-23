'use strict';
// Yandex 完整链路：借道图床公网 URL -> cbir_page=similar -> 反转义 -> 解析结构化结果
const { request, multipart } = require('./proxy-client');
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IMG = fs.readFileSync(__dirname + '/test-realframe.jpg');

function unesc(x) {
  return x.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

(async () => {
  // 1. 图床借道
  const mp = multipart({ reqtype: 'fileupload', time: '72h' },
    { fileToUpload: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  const up = await request('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST', followRedirect: false, timeout: 60000,
    headers: { 'Content-Type': mp.contentType, 'User-Agent': UA }, body: mp.buffer });
  const imgUrl = up.body.toString('utf8').trim();
  console.log(`[1] image host -> ${imgUrl}`);

  // 2. Yandex similar
  const u = `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(imgUrl)}&cbir_page=similar`;
  const r = await request(u, { method: 'GET', followRedirect: true, timeout: 60000,
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'en-US,en;q=0.9' } });
  const raw = r.body.toString('utf8');
  fs.writeFileSync(__dirname + '/out-yandex-full.html', raw);
  console.log(`[2] yandex similar -> ${r.status} bytes=${raw.length}`);

  const s = unesc(raw);
  const count = (re) => (s.match(re) || []).length;
  console.log(`    img_href=${count(/"img_href"/g)}  alt=${count(/"alt"/g)}  cbir_id=${(s.match(/cbir_id=[^"&]{4,60}/g) || []).length}`);

  // 解析每个结果项：img_href(缩略图) / alt(标题) / href(来源页)
  const items = [];
  const re = /\{"[^{}]*?"img_href":"([^"]+)"[^{}]*?\}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const blob = m[0];
    const g = (k) => { const q = new RegExp(`"${k}":"([^"]*)"`).exec(blob); return q ? q[1] : null; };
    items.push({ thumb: g('img_href'), title: g('alt'), href: g('href'), source: g('domain') || g('source') });
  }
  console.log(`\n[3] parsed items = ${items.length}`);
  items.slice(0, 10).forEach((it, i) => {
    console.log(`  [${i}] title=${String(it.title).slice(0, 55)}`);
    console.log(`       thumb=${String(it.thumb).slice(0, 95)}`);
    console.log(`       href =${String(it.href).slice(0, 95)}`);
  });

  // 单独看页面里的外链
  const ext = [...new Set((s.match(/"href":"(https?:\/\/[^"]{5,120})"/g) || []).map((x) => x.slice(9, -1)))];
  console.log(`\n[4] external href sample (${ext.length}):`);
  ext.slice(0, 10).forEach((x) => console.log('   ', x.slice(0, 120)));
})();
