'use strict';
// Yandex 第二阶段：是否提供 format=json 结果接口
const { request } = require('./proxy-client');
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IMG_URL = 'https://litter.catbox.moe/uy38kf.jpg';

async function go(label, url) {
  try {
    const r = await request(url, { method: 'GET', followRedirect: true, timeout: 60000,
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' } });
    const s = r.body.toString('utf8');
    const looksJson = /^\s*[{[]/.test(s.trim());
    console.log(`\n[${label}] status=${r.status} bytes=${s.length} ct=${(r.headers['content-type'] || '').slice(0, 40)} json=${looksJson}`);
    console.log(`  head=${JSON.stringify(s.slice(0, 300))}`);
    const items = (s.match(/"(?:cbir|serp)-?item/gi) || []).length;
    console.log(`  item-ish keys=${items}`);
    fs.writeFileSync(__dirname + '/out-yj-' + label.replace(/[^a-z0-9]/gi, '_') + '.txt', s.slice(0, 200000));
  } catch (e) { console.log(`\n[${label}] ERROR ${e.message}`); }
}

const enc = encodeURIComponent(IMG_URL);
(async () => {
  await go('J1-format-json', `https://yandex.com/images/search?rpt=imageview&format=json&url=${enc}`);
  await go('J2-request-blocks', `https://yandex.com/images/search?rpt=imageview&format=json&url=${enc}&request=${encodeURIComponent(JSON.stringify({ blocks: [{ block: 'cbir-search-by-image' }] }))}`);
  await go('J3-similar-page', `https://yandex.com/images/search?rpt=imageview&url=${enc}&cbir_page=similar`);
})();
