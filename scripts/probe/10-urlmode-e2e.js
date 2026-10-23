'use strict';
// 端到端：本地帧 -> 匿名图床 -> 公网 URL -> Bing / Yandex URL 模式 -> 能否解析结构化结果
const { request, multipart } = require('./proxy-client');
const fs = require('node:fs');

const IMG = fs.readFileSync(__dirname + '/test-realframe.jpg');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function uploadToLitterbox() {
  const mp = multipart({ reqtype: 'fileupload', time: '72h' },
    { fileToUpload: { filename: 'frame.jpg', buffer: IMG, contentType: 'image/jpeg' } });
  const r = await request('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST', followRedirect: false, timeout: 60000,
    headers: { 'Content-Type': mp.contentType, 'User-Agent': UA }, body: mp.buffer,
  });
  const url = r.body.toString('utf8').trim();
  console.log(`[upload] status=${r.status} url=${url}`);
  return url;
}

function extractBing(html) {
  const out = [];
  const re = /\sm="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const j = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
      if (j && j.murl) out.push({ purl: j.purl, murl: j.murl, turl: j.turl, title: j.t, cid: j.cid });
    } catch { /* 非目标 m 属性，跳过 */ }
  }
  return out;
}

async function probe(label, url, opts) {
  try {
    const r = await request(url, { followRedirect: true, timeout: 60000, ...opts });
    const s = r.body.toString('utf8');
    console.log(`\n[${label}] status=${r.status} bytes=${s.length}`);
    console.log(`  final=${r.finalUrl.slice(0, 150)}`);
    console.log(`  title=${JSON.stringify((s.match(/<title>([^<]{0,80})<\/title>/) || [])[1])}`);
    const bing = extractBing(s);
    if (bing.length) {
      console.log(`  Bing iusc items = ${bing.length}`);
      bing.slice(0, 5).forEach((b, i) => console.log(`   [${i}] t=${String(b.title).slice(0, 50)} | purl=${String(b.purl).slice(0, 70)}`));
    }
    const serpItems = (s.match(/class="[^"]*serp-item[^"]*"/g) || []).length;
    const cbir = (s.match(/cbir[a-zA-Z-]*/g) || []).length;
    console.log(`  yandex serp-item=${serpItems} cbir*=${cbir}`);
    fs.writeFileSync(__dirname + '/out-e2e-' + label.replace(/[^a-z0-9]/gi, '_') + '.html', r.body);
    return { r, s, bing };
  } catch (e) {
    console.log(`\n[${label}] ERROR ${e.message}`);
    return null;
  }
}

(async () => {
  const url = await uploadToLitterbox();
  if (!/^https?:\/\//.test(url)) { console.log('upload failed, abort'); return; }

  await probe('B1-bing-imgurl-detailv2',
    'https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&sbisrc=UrlPaste&q=imgurl:' + encodeURIComponent(url),
    { method: 'GET', headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' } });

  await probe('B2-bing-imgurl-plain',
    'https://www.bing.com/images/search?q=imgurl:' + encodeURIComponent(url) + '&form=SBIVSP',
    { method: 'GET', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });

  await probe('Y1-yandex-imageview',
    'https://yandex.com/images/search?rpt=imageview&url=' + encodeURIComponent(url),
    { method: 'GET', headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
})();
