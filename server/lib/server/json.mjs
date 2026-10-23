// 请求体解析与响应序列化。统一信封：成功 {ok:true,data}，失败 {ok:false,error:{code,message,detail}}。
import { badRequest, httpStatusFor, toRvsError } from '../errors.mjs';
import { newRequestId } from '../ids.mjs';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('请求体过大', { limit_bytes: MAX_BODY_BYTES }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(badRequest('请求体必须是 JSON 对象'));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(badRequest('请求体不是合法 JSON', { detail: err.message }));
      }
    });
    req.on('error', (err) => reject(badRequest('读取请求体失败', { detail: err.message })));
  });
}

export function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendOk(res, data, { status = 200, requestId } = {}) {
  return sendJson(res, status, { ok: true, data }, requestId ? { 'X-Request-Id': requestId } : {});
}

export function sendFail(res, err, requestId) {
  const e = toRvsError(err);
  const status = e.httpStatus || httpStatusFor(e.code);
  return sendJson(
    res,
    status,
    { ok: false, error: { code: e.code, message: e.message, detail: e.detail ?? null } },
    requestId ? { 'X-Request-Id': requestId } : {},
  );
}

export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...headers });
  res.end(body);
}

export function sendBuffer(res, status, buffer, headers = {}) {
  res.writeHead(status, { 'Content-Length': buffer.length, ...headers });
  res.end(buffer);
}

export function attachRequestId(req, res) {
  const existing = req.headers['x-request-id'];
  const id = typeof existing === 'string' && existing ? existing : newRequestId();
  res.setHeader('X-Request-Id', id);
  return id;
}

export function queryOf(url) {
  return new URL(url, 'http://127.0.0.1').searchParams;
}

export function intParam(searchParams, key, fallback, min = null, max = null) {
  const raw = searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== null && n < min) return min;
  if (max !== null && n > max) return max;
  return n;
}

export function boolParam(searchParams, key, fallback = false) {
  const raw = searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'on';
}

export function listParam(searchParams, key) {
  const raw = searchParams.get(key);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
