'use strict';
// 分析落盘的 HTML，判断能否解析出结构化结果（标题/URL/缩略图）
const fs = require('node:fs');
const path = require('node:path');

const markers = {
  yandex: {
    'serp-item': /serp-item[_\s"']/g,
    'CbirItem': /CbirItem/g,
    'cbir-section': /cbir-section/g,
    'serp-item__link': /serp-item__link/g,
    'b-serp-item': /class="[^"]*serp-item/g,
    'CbirSites': /CbirSites|cbir-sites/g,
    'image_link': /"image"[^{]{0,40}"url"/g,
  },
  bing: {
    'm=" JSON': /\sm="\{/g,
    'mimg': /mimg/g,
    'iusc': /class="iusc"/g,
    'murl': /"murl"/g,
    'imgurl:': /imgurl/g,
  },
  google: {
    '/url?q=': /\/url\?q=/g,
    'href="http': /href="https?:\/\/(?!www\.google|policies|support|accounts)/g,
    'vsrid': /vsrid/g,
  },
};

function count(str, re) {
  const m = str.match(re);
  return m ? m.length : 0;
}

const files = process.argv.slice(2);
for (const f of files) {
  const p = path.resolve(f);
  if (!fs.existsSync(p)) { console.log(`MISSING ${f}`); continue; }
  const s = fs.readFileSync(p, 'utf8');
  console.log(`\n--- ${path.basename(p)}  (${s.length} chars)`);
  const kind = /bing/.test(f) ? 'bing' : /^out-Y/.test(path.basename(p)) || /yandex/i.test(f) ? 'yandex' : 'google';
  const set = markers[kind] || markers.google;
  for (const [name, re] of Object.entries(set)) {
    const c = count(s, re);
    if (c > 0) console.log(`    ${name.padEnd(20)} = ${c}`);
  }
  const title = (s.match(/<title>([^<]{0,120})<\/title>/) || [])[1];
  console.log(`    title = ${JSON.stringify(title)}`);
}
