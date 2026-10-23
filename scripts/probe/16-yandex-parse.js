'use strict';
// 验证：Yandex cbir_page=similar 页面能否被服务端解析出 标题/来源页/缩略图
const fs = require('node:fs');
const s = fs.readFileSync(process.argv[2], 'utf8');

// 先看 serp-item 长什么样
const idxs = [];
let i = -1;
while ((i = s.indexOf('serp-item', i + 1)) !== -1 && idxs.length < 3) idxs.push(i);
console.log(`serp-item occurrences idx=${idxs}`);
idxs.forEach((k, n) => console.log(`\n[ctx ${n}] ${s.slice(Math.max(0, k - 300), k + 900)}`));

console.log('\n\n=========== 统计关键字段 ===========');
const c = (re) => (s.match(re) || []).length;
console.log('img_href        =', c(/"img_href"/g));
console.log('alt             =', c(/"alt"/g));
console.log('"href"          =', c(/"href"/g));
console.log('serp-item       =', c(/serp-item/g));
console.log('snippet/title   =', c(/"title"/g));
console.log('\n--- img_href 样本');
(s.match(/"img_href":"[^"]{0,140}"/g) || []).slice(0, 6).forEach((x) => console.log('  ', x.slice(0, 150)));
console.log('\n--- alt 样本');
(s.match(/"alt":"[^"]{0,140}"/g) || []).slice(0, 6).forEach((x) => console.log('  ', x.slice(0, 150)));
console.log('\n--- href 样本');
(s.match(/"href":"[^"]{0,140}"/g) || []).slice(0, 8).forEach((x) => console.log('  ', x.slice(0, 150)));
