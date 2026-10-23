// CONNECT 隧道 Agent：继承 https.Agent，只重写 createConnection。
// RVS_PROXY 为空时退化为原生直连 https.Agent，调用方代码不变。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';

export function parseProxy(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const host = u.hostname;
  if (!host) return null;
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const auth = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null;
  return { host, port, auth, raw };
}

export class ProxyConnectError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ProxyConnectError';
    this.detail = detail;
  }
}

export class TunnelAgent extends https.Agent {
  constructor(proxy, options = {}) {
    super({ keepAlive: false, maxSockets: 8, ...options });
    this.proxy = typeof proxy === 'string' ? parseProxy(proxy) : proxy;
    this.connectTimeoutMs = options.connectTimeoutMs || 1000;
    this.tlsTimeoutMs = options.tlsTimeoutMs || 3000;
  }

  createConnection(options, callback) {
    const target = options.host || options.hostname;
    const port = Number(options.port) || 443;
    if (!this.proxy) {
      return super.createConnection(options, callback);
    }
    const headers = { Host: `${target}:${port}` };
    if (this.proxy.auth) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(this.proxy.auth).toString('base64')}`;
    }
    const req = http.request({
      host: this.proxy.host,
      port: this.proxy.port,
      method: 'CONNECT',
      path: `${target}:${port}`,
      headers,
      agent: false,
    });

    let settled = false;
    const finish = (err, socket) => {
      if (settled) return;
      settled = true;
      callback(err, socket);
    };

    req.setTimeout(this.connectTimeoutMs, () => {
      req.destroy(new ProxyConnectError('CONNECT 隧道建立超时', { target, port }));
    });

    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        finish(new ProxyConnectError(`CONNECT 被拒绝，状态码 ${res.statusCode}`, { statusCode: res.statusCode }));
        return;
      }
      const head = res.headers || {};
      void head;
      const tlsSocket = tls.connect({
        socket,
        servername: target,
        host: target,
        port,
        ALPNProtocols: ['http/1.1'],
      });
      tlsSocket.setTimeout(this.tlsTimeoutMs, () => {
        tlsSocket.destroy(new ProxyConnectError('TLS 握手超时', { target, port }));
      });
      tlsSocket.once('secureConnect', () => {
        tlsSocket.setTimeout(0);
        finish(null, tlsSocket);
      });
      tlsSocket.once('error', (err) => finish(err));
    });

    req.once('error', (err) => finish(err));
    req.end();
    return undefined;
  }
}

export function createAgent(proxyUrl, options = {}) {
  const proxy = parseProxy(proxyUrl);
  if (!proxy) return new https.Agent({ keepAlive: false, maxSockets: 8 });
  return new TunnelAgent(proxy, options);
}

export function isLoopbackTarget(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

export { net, tls, https, http };
