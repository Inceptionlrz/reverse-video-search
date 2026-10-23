'use strict';
// 定位 Yandex 内嵌状态 JSON 中的结果块
const fs = require('node:fs');
const s = fs.readFileSync(process.argv[2], 'utf8');

function ctx(label, needle, before = 600, after = 2500) {
  const i = s.indexOf(needle);
  console.log(`\n===== ${label} @${i}`);
  if (i < 0) { console.log('  (not found)'); return; }
  console.log(s.slice(Math.max(0, i - before), i + after));
}

ctx('isCbirEmpty', 'isCbirEmpty', 1200, 1500);
ctx('cbir_neuro_tab', 'cbir_neuro_tab', 400, 1200);
ctx('cbir_page=similar', 'cbir_page=similar', 300, 800);
