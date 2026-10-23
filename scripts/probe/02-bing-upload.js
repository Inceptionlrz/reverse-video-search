'use strict';
// 目标：验证 Bing 视觉搜索是否存在可用的「直传 multipart」端点
const { request, multipart } = require('./proxy-client');
const fs = require('node:fs');

const IMG = fs.readFileSync(__dirname + '/test-realframe.jpg');
const IMG_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/Dog_August_2010.jpg/320px-Dog_August_2010.jpg';

async function probe(label, url, opts) {
  const t0 = Date.now();
  try {
    const r = await request(url, { followRedirect: false, timeout: 60000, ...opts });
    const ct = (r.headers['content-type'] || '').slice(0, 45);
    console.log(`\n=== ${label}`);
    console.log(`    ${opts.method || 'GET'} ${url.slice(0, 120)}`);
    console.log(`    -> status=${r.status} time=${Date.now() - t0}ms bytes=${r.body.length} ct=${ct}`);
    if (r.headers.location) console.log(`    -> location=${r.headers.location.slice(0, 160)}`);
    console.log(`    -> body[0:500] = ${JSON.stringify(r.body.slice(0, 500).toString('utf8'))}`);
    fs.writeFileSync(__dirname + '/out-' + label.replace(/[^a-z0-9]/gi, '_') + '.txt',
      `STATUS ${r.status}\nHEADERS ${JSON.stringify(r.headers, null, 1)}\n\n${r.body.toString('utf8')}`);
    return r;
  } catch (e) {
    console.log(`\n=== ${label}\n    ${opts.method || 'GET'} ${url.slice(0, 120)}\n    -> ERROR ${Date.now() - t0}ms :: ${e.message}`);
    return null;
  }
}

(async () => {
  const bin = multipart({ cbir: 'sbi' }, { imageBin: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('A1-POST-/images/api/v3/searchbyimage',
    'https://www.bing.com/images/api/v3/searchbyimage',
    { method: 'POST', headers: { 'Content-Type': bin.contentType, Origin: 'https://www.bing.com', Referer: 'https://www.bing.com/images/search' }, body: bin.buffer });

  const b2 = multipart({ cbir: 'sbi' }, { imageBin: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  await probe('A2-POST-/images/visualsearch',
    'https://www.bing.com/images/visualsearch',
    { method: 'POST', headers: { 'Content-Type': b2.contentType, Origin: 'https://www.bing.com', Referer: 'https://www.bing.com/images/search' }, body: b2.buffer });

  const b3 = multipart({ imageBin: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } }, {});
  await probe('A3-POST-/images/async/searchbyimage',
    'https://www.bing.com/images/async/searchbyimage',
    { method: 'POST', headers: { 'Content-Type': b3.contentType, Origin: 'https://www.bing.com', Referer: 'https://www.bing.com/images/search' }, body: b3.buffer });

  await probe('A4-GET-detailv2-imgurl',
    'https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:' + encodeURIComponent(IMG_URL),
    { method: 'GET', headers: { Accept: 'text/html,*/*', Referer: 'https://www.bing.com/images' } });
})();
