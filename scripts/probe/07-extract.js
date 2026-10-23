'use strict';
// 从落盘 HTML 中提取真实可解析结构的样本
const fs = require('node:fs');

const f = process.argv[2];
const s = fs.readFileSync(f, 'utf8');

function show(label, re, max = 3, cut = 400) {
  console.log(`\n### ${label}`);
  let n = 0;
  let m;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(s)) !== null && n < max) {
    console.log(`  [${n}] ${m[0].slice(0, cut)}`);
    n++;
  }
  if (n === 0) console.log('  (no match)');
}

console.log(`FILE ${f} len=${s.length}`);

// Bing: <a class="iusc" ... m="{&quot;murl&quot;:...}"
show('Bing iusc m=', /\sm="[^"]{0,600}/, 2, 600);
show('Bing murl raw', /murl&quot;:&quot;[^&]{0,120}/, 3, 200);
show('Bing purl raw', /purl&quot;:&quot;[^&]{0,120}/, 3, 200);
show('Bing t(title)', /&quot;t&quot;:&quot;[^&]{0,100}/, 3, 200);

// Yandex
show('Yandex cbir_id', /cbir[_i][a-zA-Z_]*["'&:=]{1,4}[0-9A-Za-z_\-]{6,60}/g, 6, 200);
show('Yandex serpid', /serpid["'&:=]{1,4}[0-9A-Za-z_\-]{6,60}/g, 5, 200);
show('Yandex format=json', /[?&]format=json[^"'&]{0,80}/g, 3, 200);
show('Yandex blocks', /"blocks"[^}]{0,200}/g, 2, 300);
show('Yandex serp-item ctx', /class="[^"]*serp-item[^"]*"[^>]{0,200}/g, 3, 300);
show('Yandex data-bem', /data-bem='[^']{0,300}/g, 2, 300);
show('Yandex CbirSites ctx', /CbirSites[^,]{0,200}/g, 3, 300);
