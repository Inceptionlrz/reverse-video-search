'use strict';
// 冒烟：验证 CONNECT 隧道 + TLS 是否真的通
const { request, PROXY_URL } = require('./proxy-client');

(async () => {
  console.log('proxy =', PROXY_URL);
  for (const url of [
    'https://www.bing.com/images/search?q=test',
    'https://yandex.com/images/',
    'https://lens.google.com/',
  ]) {
    try {
      const r = await request(url, { method: 'GET', followRedirect: false });
      console.log(`[OK]   ${r.status}  ${url}  bytes=${r.body.length} ct=${(r.headers['content-type'] || '').slice(0, 60)}`);
    } catch (e) {
      console.log(`[FAIL] ${url}  ${e.message}`);
    }
  }
})();
