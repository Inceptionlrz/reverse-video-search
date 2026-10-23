'use strict';
const fs = require('node:fs');
const s = fs.readFileSync(process.argv[2], 'utf8');
const uniq = (a) => [...new Set(a)].slice(0, 60);

console.log('--- "block":"X" values');
console.log(uniq((s.match(/"block":"([^"]{1,60})"/g) || []).map((x) => x.slice(9, -1))));
console.log('\n--- keys starting with cbir');
console.log(uniq((s.match(/"cbir[A-Za-z_]{0,40}"/g) || [])));
console.log('\n--- keys containing serp');
console.log(uniq((s.match(/"[a-z-]*serp[a-zA-Z_-]{0,40}"/g) || [])));
console.log('\n--- "type":"..." near serp');
console.log(uniq((s.match(/"type":"(?:serp|cbir)[^"]{0,40}"/g) || [])));
console.log('\n--- cbir_id contexts');
(s.match(/.{80}cbir_id.{120}/g) || []).slice(0, 4).forEach((x, i) => console.log(` [${i}] ${x}`));
