'use strict';
// 目标：Yandex 是否只支持 URL 模式；是否存在 multipart 直传
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
  await probe('Y1-GET-imageview-url',
    'https://yandex.com/images/search?rpt=imageview&url=' + encodeURIComponent(IMG_URL),
    { method: 'GET', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });

  await probe('Y2-GET-imageview-url-nrpt',
    'https://yandex.com/images/search?url=' + encodeURIComponent(IMG_URL) + '&rpt=imageview&lr=10418',
    { method: 'GET', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });

  // multipart 直传尝试
  const y3 = multipart({ rpt: 'imageview', format: 'json' }, { upfile: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('Y3-POST-multipart-upfile',
    'https://yandex.com/images/search',
    { method: 'POST', headers: { 'Content-Type': y3.contentType, Origin: 'https://yandex.com', Referer: 'https://yandex.com/images/', 'User-Agent': UA }, body: y3.buffer });

  const y4 = multipart({ rpt: 'imageview' }, { upfile: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('Y4-POST-cbir-upfile',
    'https://yandex.com/images/touch/search',
    { method: 'POST', headers: { 'Content-Type': y4.contentType, Origin: 'https://yandex.com', Referer: 'https://yandex.com/images/', 'User-Agent': UA }, body: y4.buffer });
})();
