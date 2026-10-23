'use strict';
// 深挖 Yandex：找出 cbir_id / serpid 与后续结果请求形态
const fs = require('node:fs');
const f = process.argv[2] || 'out-e2e-Y1-yandex-imageview.html';
const s = fs.readFileSync(f, 'utf8');
console.log(`FILE ${f} len=${s.length}`);

function show(label, re, max = 8, cut = 260) {
  console.log(`\n### ${label}`);
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m, n = 0;
  while ((m = r.exec(s)) !== null && n < max) { console.log(`  [${n}] ${m[0].slice(0, cut)}`); n++; }
  if (!n) console.log('  (no match)');
}

show('cbir_id variants', /cbir[_I][a-zA-Z]*[=:"']{1,3}[A-Za-z0-9_\-]{4,60}/g, 10);
show('serpid', /serpid[=:"']{1,3}[A-Za-z0-9_\-]{4,60}/g, 5);
show('rpt=imageview occurrences', /rpt=imageview[^"'\s]{0,120}/g, 6);
show('images/search? http', /https?:\/\/[^"'\s]*images\/search[^"'\s]{0,140}/g, 8);
show('uploadi / upload url', /https?:\/\/[^"'\s]*upload[^"'\s]{0,120}/g, 6);
show('"cbir" json blocks', /"cbir[^"]{0,60}"\s*:/g, 10);
show('format=json', /[?&]format=json[^"'\s]{0,100}/g, 4);
show('data-bem cbir', /data-bem='[^']{0,400}'/g, 3, 400);
show('similar/sites block', /"(?:similar|sites|tags)":\s*\[/g, 6);
show('img_href / olink', /"(?:img_href|olink|url)":\s*"[^"]{0,110}/g, 6);
