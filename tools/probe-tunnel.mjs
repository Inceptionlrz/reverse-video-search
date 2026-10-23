// 零依赖验证：通过 HTTP CONNECT 隧道访问 HTTPS，绕过沙箱直连限制
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';

const PROXY = { host: '127.0.0.1', port: 7897 };

function tunnel(targetHost, targetPort = 443) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PROXY.port, PROXY.host, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.removeListener('data', onData);
      const head = buf.split('\r\n')[0];
      if (!/ 2\d\d /.test(head)) { sock.destroy(); return reject(new Error('CONNECT 失败: ' + head)); }
      resolve(tls.connect({ socket: sock, servername: targetHost }));
    };
    sock.on('data', onData);
    sock.on('error', reject);
    sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('CONNECT 超时')); });
  });
}

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    tunnel(u.hostname, Number(u.port) || 443).then((tlsSock) => {
      const req = http.request({
        socket: tlsSock,
        agent: false,
        method: 'GET',
        path: u.pathname + u.search,
        headers: {
          Host: u.hostname,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'max-age=0',
          Connection: 'close',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(new Error('请求超时')); });
      req.end();
    }).catch(reject);
  });
}

const targets = [
  'https://www.bing.com/images/search?q=test',
  'https://yandex.com/images/',
  'https://lens.google.com/',
  'https://example.com/',
  'https://www.google.com/',
  'https://github.com/',
  'https://www.bing.com/',
];

for (const t of targets) {
  try {
    const r = await httpsGet(t);
    console.log(`OK   ${r.status}  len=${r.body.length}  ${t}`);
    if (r.status !== 200 || r.body.length < 5000) {
      console.log('     headers:', JSON.stringify(r.headers));
      console.log('     body:', r.body.slice(0, 700).toString('utf8').replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log(`FAIL ${e.message}  ${t}`);
  }
}
