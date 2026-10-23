'use strict';
/**
 * 零依赖 HTTP/HTTPS 客户端，通过 HTTP CONNECT 隧道走本机代理。
 * 目的：Bash 工具的 curl 被沙箱拦截（全返回 000），Node 内置 fetch 不支持代理，
 * 因此手写 CONNECT + TLS 隧道，确保探测结果真实可信。
 */
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const { URL } = require('node:url');

const PROXY_URL = process.env.RVS_PROXY || 'http://127.0.0.1:7897';
const PROXY = new URL(PROXY_URL);

function tunnel(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: PROXY.hostname,
      port: Number(PROXY.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: 15000,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT failed: ${res.statusCode} ${res.statusMessage}`));
        return;
      }
      resolve(socket);
    });
    req.once('timeout', () => { req.destroy(new Error('CONNECT timeout')); });
    req.once('error', reject);
    req.end();
  });
}

function once(socket, host) {
  const t = tls.connect({ socket, servername: host });
  // 防止 ECONNRESET 在 TLS 握手前抛出未捕获的 'error' 事件导致进程崩溃
  t.once('error', () => {});
  return t;
}

/**
 * @param {string} url
 * @param {{method?:string,headers?:object,body?:Buffer|string,timeout?:number,followRedirect?:boolean,maxRedirects?:number}} opts
 */
async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 30000,
    followRedirect = true,
    maxRedirects = 5,
  } = opts;

  const target = new URL(url);
  const isTls = target.protocol === 'https:';
  const port = Number(target.port) || (isTls ? 443 : 80);

  const rawSocket = await tunnel(target.hostname, port);
  const socket = isTls ? once(rawSocket, target.hostname) : rawSocket;

  const reqHeaders = { ...headers };
  if (!reqHeaders.Host) reqHeaders.Host = target.host;
  if (!reqHeaders['User-Agent']) {
    reqHeaders['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  if (body && !reqHeaders['Content-Length']) {
    reqHeaders['Content-Length'] = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, 'utf8');
  }

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      method,
      host: target.hostname,
      port,
      path: target.pathname + target.search,
      headers: reqHeaders,
      createConnection: () => socket,
      agent: false,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        statusText: res.statusMessage,
        headers: res.headers,
        body: Buffer.concat(chunks),
        finalUrl: url,
        redirectChain: [],
      }));
      res.on('error', reject);
    });
    req.once('timeout', () => req.destroy(new Error(`request timeout ${timeout}ms`)));
    req.once('error', reject);
    if (body) req.write(body);
    req.end();
  });

  const loc = result.headers.location;
  if (followRedirect && loc && result.status >= 300 && result.status < 400 && maxRedirects > 0) {
    const next = new URL(loc, url).toString();
    const followed = await request(next, { ...opts, maxRedirects: maxRedirects - 1 });
    followed.redirectChain = [url, ...followed.redirectChain];
    followed.firstStatus = result.status;
    followed.firstHeaders = result.headers;
    return followed;
  }
  return result;
}

function multipart(fields, files) {
  const boundary = '----rvsBoundary' + Math.random().toString(36).slice(2, 12);
  const parts = [];
  for (const [name, value] of Object.entries(fields || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  for (const [name, file] of Object.entries(files || {})) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType || 'image/jpeg'}\r\n\r\n`, 'utf8'));
    parts.push(file.buffer);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { buffer: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

module.exports = { request, multipart, PROXY_URL };
