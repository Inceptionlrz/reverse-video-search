'use strict';
// 目标：Google Lens multipart 上传 vs uploadbyurl
const { request, multipart } = require('./proxy-client');
const fs = require('node:fs');

const IMG = fs.readFileSync(__dirname + '/test-realframe.jpg');
const IMG_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/Dog_August_2010.jpg/320px-Dog_August_2010.jpg';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function probe(label, url, opts) {
  const t0 = Date.now();
  try {
    const r = await request(url, { followRedirect: false, timeout: 60000, ...opts });
    console.log(`\n=== ${label}`);
    console.log(`    ${opts.method || 'GET'} ${url.slice(0, 130)}`);
    console.log(`    -> status=${r.status} time=${Date.now() - t0}ms bytes=${r.body.length} ct=${(r.headers['content-type'] || '').slice(0, 45)}`);
    if (r.headers.location) console.log(`    -> location=${r.headers.location.slice(0, 200)}`);
    console.log(`    -> body[0:400] = ${JSON.stringify(r.body.slice(0, 400).toString('utf8'))}`);
    fs.writeFileSync(__dirname + '/out-' + label.replace(/[^a-z0-9]/gi, '_') + '.txt',
      `STATUS ${r.status}\nHEADERS ${JSON.stringify(r.headers, null, 1)}\n\n${r.body.toString('utf8')}`);
  } catch (e) {
    console.log(`\n=== ${label}\n    -> ERROR ${Date.now() - t0}ms :: ${e.message}`);
  }
}

(async () => {
  // G1: v3/upload multipart, 字段名 encoded_image
  const g1 = multipart({}, { encoded_image: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('G1-POST-lens-v3-upload-multipart', 'https://lens.google.com/v3/upload',
    { method: 'POST', headers: { 'Content-Type': g1.contentType, Origin: 'https://lens.google.com', Referer: 'https://lens.google.com/', 'User-Agent': UA }, body: g1.buffer });

  // G2: uploadbyurl（URL 模式，团队已实测 200，这里复测并看 location）
  await probe('G2-GET-lens-uploadbyurl',
    'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(IMG_URL) + '&hl=zh-CN',
    { method: 'GET', headers: { 'User-Agent': UA, Referer: 'https://lens.google.com/' } });

  // G3: 另一个已知形态 /v3/upload?hl=zh-CN&re=df&st=
  const g3 = multipart({ hl: 'zh-CN' }, { encoded_image: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('G3-POST-lens-v3-upload-hl', 'https://lens.google.com/v3/upload?hl=zh-CN&re=df',
    { method: 'POST', headers: { 'Content-Type': g3.contentType, Origin: 'https://lens.google.com', Referer: 'https://lens.google.com/', 'User-Agent': UA }, body: g3.buffer });
})();
