// 出站 HTTP 客户端：隧道 / TLS / 首字节 / 整体 四类超时分别计时并分别归类。
// 一律走 https.request + TunnelAgent，本文件是唯一出站入口，禁止在别处出现 fetch(。
import https from 'node:https';
import { RvsError } from '../errors.mjs';
import { createAgent } from './proxy-agent.mjs';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CAPTCHA_MARKERS = [
  'recaptcha',
  'g-recaptcha',
  'hcaptcha',
  'cf-turnstile',
  'unusual traffic',
  'verify you are human',
  'are you a robot',
  'captcha',
];

export function detectCaptcha(status, body) {
  if (status !== 200 && status !== 403 && status !== 429) return false;
  if (!body) return false;
  const needle = String(body).slice(0, 200000).toLowerCase();
  return CAPTCHA_MARKERS.some((m) => needle.includes(m));
}

function classifyNetworkError(err) {
  const code = err && err.code ? String(err.code) : '';
  const name = err && err.name ? String(err.name) : '';
  if (name === 'ProxyConnectError') return 'PROXY_UNREACHABLE';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'NETWORK_ERROR';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') return 'NETWORK_ERROR';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'NETWORK_ERROR';
  return 'NETWORK_ERROR';
}

// 导出供测试：分类是纯函数，但只有它能证明"412 不再被说成解析失败"。
// 不导出就只能靠端到端打真实服务，回归成本高到事实上不会有人跑。
export function statusToCode(status, body) {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'FORBIDDEN';
  // 412 必须显式归到 UPLOAD_REJECTED：否则会落到末尾的 PARSE_ERROR，
  // 界面上写成"页面结构无法解析"，把"图床拒收"说成"解析失败"，排障方向被带偏
  // （实测 catbox.moe 匿名上传返回 412 Invalid uploader，就曾被说成解析问题）。
  // UPLOAD_REJECTED 不在可重试集合里，顺带避免对注定失败的请求空转重试。
  if (status === 400 || status === 412 || status === 413 || status === 415) return 'UPLOAD_REJECTED';
  if (status >= 500) return 'NETWORK_ERROR';
  if (detectCaptcha(status, body)) return 'CAPTCHA';
  return 'PARSE_ERROR';
}

function failure(errorCode, message, extra = {}) {
  return {
    ok: false,
    status: extra.status ?? null,
    headers: extra.headers ?? {},
    body: extra.body ?? '',
    latencyMs: extra.latencyMs ?? null,
    errorCode,
    errorMessage: message,
    error: new RvsError(errorCode, message, { detail: extra.detail ?? null }),
  };
}

// 超时解析。config.mjs 把超时放在 cfg.net 下，而早期调用方（探针脚本、测试）
// 传的是平铺的 { connectTimeoutMs, ... }。两边都要认，否则会出现
// "配置里改成了 30s，实际仍按 15s 超时"——配置值被静默无视，排障时极难定位。
export function resolveTimeouts(cfg, options = {}) {
  const net = cfg?.net || cfg || {};
  return {
    connect: options.connectTimeoutMs ?? net.connectTimeoutMs ?? 1000,
    tls: options.tlsTimeoutMs ?? net.tlsTimeoutMs ?? 3000,
    ttfb: options.ttfbTimeoutMs ?? net.ttfbTimeoutMs ?? 5000,
    total: options.totalTimeoutMs ?? net.totalTimeoutMs ?? 15000,
  };
}

export function request(targetUrl, options = {}) {
  const cfg = options.config || {};
  const timeouts = resolveTimeouts(cfg, options);
  const maxBody = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const agent = options.agent || createAgent(options.proxy ?? cfg.proxy ?? '', {
    connectTimeoutMs: timeouts.connect,
    tlsTimeoutMs: timeouts.tls,
  });

  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(targetUrl);
    } catch {
      resolve(failure('BAD_REQUEST', '目标 URL 无法解析', { detail: String(targetUrl) }));
      return;
    }
    const method = (options.method || 'GET').toUpperCase();
    const headers = {
      Host: u.host,
      'User-Agent': options.userAgent || DEFAULT_UA,
      Accept: options.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'identity',
      Connection: 'close',
      ...(options.headers || {}),
    };
    if (options.body && method !== 'GET') headers['Content-Length'] = Buffer.byteLength(options.body);

    const started = Date.now();
    let ttfbTimer = null;
    let totalTimer = null;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      if (ttfbTimer) clearTimeout(ttfbTimer);
      if (totalTimer) clearTimeout(totalTimer);
      resolve(result);
    };

    const req = https.request(
      {
        agent,
        method,
        host: u.hostname,
        port: Number(u.port) || 443,
        path: `${u.pathname}${u.search}`,
        headers,
      },
      (res) => {
        if (ttfbTimer) clearTimeout(ttfbTimer);
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size <= maxBody) chunks.push(chunk);
        });
        res.on('end', () => {
          const latencyMs = Date.now() - started;
          const body = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            if (detectCaptcha(status, body)) {
              finish(failure('CAPTCHA', '引擎要求人机验证，无法自动完成', { status, headers: res.headers, body, latencyMs }));
              return;
            }
            finish({ ok: true, status, headers: res.headers, body, latencyMs, errorCode: null, errorMessage: null, error: null });
            return;
          }
          const code = statusToCode(status, body);
          finish(failure(code, `引擎返回 HTTP ${status}`, { status, headers: res.headers, body, latencyMs }));
        });
        res.on('error', (err) => {
          finish(failure(classifyNetworkError(err), err.message, { latencyMs: Date.now() - started }));
        });
      },
    );

    ttfbTimer = setTimeout(() => {
      req.destroy(new Error('ttfb timeout'));
      finish(failure('TIMEOUT', '等待首字节超时', { latencyMs: Date.now() - started }));
    }, timeouts.ttfb);

    totalTimer = setTimeout(() => {
      req.destroy(new Error('total timeout'));
      finish(failure('TIMEOUT', '请求整体超时', { latencyMs: Date.now() - started }));
    }, timeouts.total);

    req.on('error', (err) => {
      const code = /timeout/i.test(err.message || '') ? 'TIMEOUT' : classifyNetworkError(err);
      finish(failure(code, err.message || '网络不可达', { latencyMs: Date.now() - started, detail: err.code || null }));
    });

    if (options.cancelToken) {
      options.cancelToken.onAbort(() => {
        req.destroy(new Error('cancelled'));
        finish(failure('NETWORK_ERROR', '请求已被取消', { latencyMs: Date.now() - started }));
      });
    }

    if (options.body && method !== 'GET') req.write(options.body);
    req.end();
  });
}

const RETRY_PLAN = { NETWORK_ERROR: 2, TIMEOUT: 1, RATE_LIMITED: 2 };

function backoffFor(code, attempt) {
  const base = code === 'RATE_LIMITED' ? 3000 : code === 'TIMEOUT' ? 1000 : 500;
  const grew = base * (code === 'NETWORK_ERROR' ? 2 ** attempt : attempt === 0 ? 1 : 3);
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  return Math.round(grew * jitter);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 带退避的重试包装。CAPTCHA / FORBIDDEN / UPLOAD_REJECTED 等不在此重试。
export async function requestWithRetry(targetUrl, options = {}) {
  const maxBase = RETRY_PLAN[options.errorCodeHint] ?? 0;
  let last = null;
  for (let attempt = 0; attempt <= maxBase; attempt += 1) {
    if (attempt > 0) await sleep(backoffFor(last.errorCode, attempt - 1));
    const res = await request(targetUrl, options);
    last = res;
    if (res.ok) return res;
  }
  return last;
}

export async function retryOnErrorCode(fn, tries = 2) {
  let last = null;
  for (let i = 0; i <= tries; i += 1) {
    if (i > 0) await sleep(backoffFor('NETWORK_ERROR', i - 1));
    last = await fn();
    if (last.ok) return last;
    if (!(last.errorCode in RETRY_PLAN)) return last;
  }
  return last;
}
