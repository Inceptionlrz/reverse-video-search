'use strict';
// Bing：抓取视觉搜索页面，找 IID/IG 与真实上传端点
const { request } = require('./proxy-client');
const fs = require('node:fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  for (const [label, url] of [
    ['visualsearch', 'https://www.bing.com/visualsearch'],
    ['images', 'https://www.bing.com/images'],
  ]) {
    try {
      const r = await request(url, { method: 'GET', followRedirect: true, timeout: 60000,
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' } });
      const s = r.body.toString('utf8');
      console.log(`\n[${label}] status=${r.status} bytes=${s.length} final=${r.finalUrl.slice(0, 100)}`);
      const iid = (s.match(/IID["'=:\s]{1,4}([A-Za-z0-9._]{4,40})/g) || []).slice(0, 5);
      const ig = (s.match(/["']?IG["']?["'=:\s]{1,4}([A-Za-z0-9._]{4,40})/g) || []).slice(0, 5);
      const eps = [...new Set((s.match(/["'](\/images\/[a-zA-Z0-9_\-\/\.]*(?:searchbyimage|upload|kvapi|visualsearch)[a-zA-Z0-9_\-\/\.]*)["']/g) || []))].slice(0, 10);
      console.log(`  IID=${JSON.stringify(iid)}`);
      console.log(`  IG=${JSON.stringify(ig)}`);
      console.log(`  endpoints=${JSON.stringify(eps)}`);
      fs.writeFileSync(__dirname + `/out-bing-${label}.html`, s);
    } catch (e) { console.log(`\n[${label}] ERROR ${e.message}`); }
  }
})();
