'use strict';
const { request } = require('./proxy-client');
const fs = require('node:fs');

const urls = [
  'https://www.bing.com/',
  'https://www.bing.com/images/search?q=test',
  'https://cn.bing.com/images/search?q=test',
  'https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl%3Ahttps%3A%2F%2Fupload.wikimedia.org%2Fwikipedia%2Fcommons%2Fthumb%2F9%2F97%2FDog_August_2010.jpg%2F320px-Dog_August_2010.jpg',
];

(async () => {
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const r = await request(url, {
        method: 'GET',
        followRedirect: false,
        timeout: 60000,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
      console.log(`[OK]  ${r.status} ${Date.now() - t0}ms bytes=${r.body.length} ct=${(r.headers['content-type'] || '').slice(0, 50)}`);
      console.log(`      ${url.slice(0, 110)}`);
      if (r.headers.location) console.log(`      location=${r.headers.location.slice(0, 140)}`);
      fs.writeFileSync(`out-bing-${urls.indexOf(url)}.html`, r.body);
    } catch (e) {
      console.log(`[FAIL] ${Date.now() - t0}ms ${url.slice(0, 110)} :: ${e.message}`);
    }
  }
})();
