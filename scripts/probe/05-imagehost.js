'use strict';
// 目标：免费匿名图床能否经代理上传，作为「URL 模式」桥
const { request, multipart } = require('./proxy-client');
const fs = require('node:fs');

const IMG = fs.readFileSync(__dirname + '/test-synthetic.jpg');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function probe(label, url, opts) {
  const t0 = Date.now();
  try {
    const r = await request(url, { followRedirect: false, timeout: 60000, ...opts });
    console.log(`\n=== ${label}`);
    console.log(`    ${opts.method || 'GET'} ${url.slice(0, 110)}`);
    console.log(`    -> status=${r.status} time=${Date.now() - t0}ms bytes=${r.body.length} ct=${(r.headers['content-type'] || '').slice(0, 40)}`);
    console.log(`    -> body[0:300] = ${JSON.stringify(r.body.slice(0, 300).toString('utf8'))}`);
  } catch (e) {
    console.log(`\n=== ${label}\n    -> ERROR ${Date.now() - t0}ms :: ${e.message}`);
  }
}

(async () => {
  // catbox.moe
  const c = multipart({ reqtype: 'fileupload' }, { fileToUpload: { filename: 'f.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('H1-catbox', 'https://catbox.moe/user/api.php',
    { method: 'POST', headers: { 'Content-Type': c.contentType, 'User-Agent': UA }, body: c.buffer });

  // 0x0.st
  const z = multipart({}, { file: { filename: 'f.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('H2-0x0st', 'https://0x0.st/',
    { method: 'POST', headers: { 'Content-Type': z.contentType, 'User-Agent': UA }, body: z.buffer });

  // tmpfiles.org
  const t = multipart({}, { file: { filename: 'f.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('H3-tmpfiles', 'https://tmpfiles.org/api/v1/upload',
    { method: 'POST', headers: { 'Content-Type': t.contentType, 'User-Agent': UA }, body: t.buffer });

  // litterbox (catbox 临时版)
  const l = multipart({ reqtype: 'fileupload', time: '72h' }, { fileToUpload: { filename: 'f.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('H4-litterbox', 'https://litterbox.catbox.moe/resources/internals/api.php',
    { method: 'POST', headers: { 'Content-Type': l.contentType, 'User-Agent': UA }, body: l.buffer });
})();
