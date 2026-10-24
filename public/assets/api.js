// api.js — 后端 HTTP 客户端。契约见 docs/SPEC.md §6 与 docs/API.md，实际实现以 server/routes/*.mjs 为准。
// 统一信封：成功 { ok:true, data }，失败 { ok:false, error:{ code, message, detail } }。
// 轮询间隔由后端在响应里下发（poll_interval_ms），前端不硬编码。

export class ApiError extends Error {
  constructor(message, { code = 'UNKNOWN', httpStatus = 0, detail = null, requestId = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.detail = detail;
    this.requestId = requestId;
  }
}

let netHealthy = true;
const listeners = new Set();

/** 订阅网络健康变化（连续失败 / 恢复）。 */
export function onNetworkChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emitNetwork(ok) {
  if (ok === netHealthy) return;
  netHealthy = ok;
  for (const fn of listeners) fn(ok);
}

/** 把响应解析成统一信封 { ok, data, error }；非 JSON / 缺 ok 字段都显式抛错，不静默。 */
async function readEnvelope(res, { method, path }) {
  const requestId = res.headers.get('X-Request-Id');
  // 防御：server/lib/server/static.mjs 的 SPA 兜底会把未命中的路径回落成 index.html（HTTP 200）。
  // 不先看 content-type 的话 res.json() 会抛 "Unexpected token '<'"，错误分支进不到统一错误 UI。
  // 后端已在 7420041 根因修复（/api/* 未命中返回 404 JSON），这层保留作纵深防御。
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    emitNetwork(false);
    throw new ApiError('接口返回的不是 JSON，可能是地址不存在或本地服务未正确启动', {
      code: 'INTERFACE_NOT_FOUND',
      httpStatus: res.status,
      requestId,
      detail: `${method} ${path} -> content-type: ${contentType || '(空)'}`,
    });
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    emitNetwork(false);
    throw new ApiError('响应不是合法 JSON', { code: 'PARSE_ERROR', httpStatus: res.status, requestId });
  }
  // 是 JSON 但不是统一信封（例如误接了第三方接口）时也要显式报错，不能静默当成失败信封。
  if (payload && typeof payload.ok !== 'boolean') {
    emitNetwork(false);
    throw new ApiError('响应缺少统一信封字段 ok', {
      code: 'PARSE_ERROR', httpStatus: res.status, requestId,
      detail: JSON.stringify(payload).slice(0, 200),
    });
  }
  return { requestId, payload };
}

async function request(path, { method = 'GET', body = null, query = null, raw = false, timeoutMs = 20000 } = {}) {
  const url = new URL(path, location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  // FormData 交给浏览器自动带 boundary，不能手动设 Content-Type
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers = body === null || isForm ? {} : { 'Content-Type': 'application/json; charset=utf-8' };
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : isForm ? body : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    emitNetwork(false);
    throw new ApiError(controller.signal.aborted ? '请求超时，本地服务未响应' : '无法连接本地服务，请确认已启动', {
      code: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      detail: String(err && err.message),
    });
  } finally {
    clearTimeout(timer);
  }
  if (raw) {
    if (!res.ok) throw new ApiError(`导出失败（HTTP ${res.status}）`, { code: 'EXPORT_FAILED', httpStatus: res.status });
    return res;
  }
  const { requestId, payload } = await readEnvelope(res, { method, path });
  if (res.ok && payload.ok) {
    emitNetwork(true);
    return payload.data;
  }
  const error = (payload && payload.error) || {};
  emitNetwork(res.status < 500);
  throw new ApiError(error.message || `请求失败（HTTP ${res.status}）`, {
    code: error.code || 'UNKNOWN',
    httpStatus: res.status,
    detail: error.detail ?? null,
    requestId,
  });
}

const q = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const api = {
  health: () => request('/api/health'),

  createTask: (body) => request('/api/file-upload', { method: 'POST', body }),
  uploadTaskFile: (file, extra = {}) => {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) form.append(k, String(v));
    return request('/api/file-upload', { method: 'POST', body: form, timeoutMs: 120000 });
  },

  listTasks: (o) => request('/api/tasks', { query: q(o) }),
  getTask: (id) => request(`/api/tasks/${encodeURIComponent(id)}`),
  deleteTask: (id) => request(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  confirmTask: (id, scope) => request(`/api/tasks/${encodeURIComponent(id)}/confirm`, { method: 'POST', body: scope }),
  extractTask: (id, body) => request(`/api/tasks/${encodeURIComponent(id)}/extract`, { method: 'POST', body: body || {} }),
  controlTask: (id, action) => request(`/api/tasks/${encodeURIComponent(id)}/control`, { method: 'POST', body: { action } }),

  listFrames: (id) => request(`/api/tasks/${encodeURIComponent(id)}/frames`),
  setFramesEnabled: (id, frameIds, enabled) =>
    request(`/api/tasks/${encodeURIComponent(id)}/frames`, { method: 'PATCH', body: { frame_ids: frameIds, enabled } }),

  runAnalyses: (body) => request('/api/search/run-analyses', { method: 'POST', body }),
  getAnalysis: (id) => request(`/api/search/analyses/${encodeURIComponent(id)}`),
  listAnalyses: (id) => request(`/api/tasks/${encodeURIComponent(id)}/analyses`),

  listResults: (o) => request('/api/results', { query: q(o) }),
  resultHits: (id) => request(`/api/results/${encodeURIComponent(id)}/hits`),

  engines: () => request('/api/engines'),
  patchEngine: (provider, body) => request(`/api/engines/${encodeURIComponent(provider)}`, { method: 'PATCH', body }),
  probeEngine: (provider) => request(`/api/engines/${encodeURIComponent(provider)}/probe`),

  settings: () => request('/api/settings'),
  putSettings: (body) => request('/api/settings', { method: 'PUT', body }),

  logs: (o) => request('/api/logs', { query: q(o) }),

  exportCsv: (o) => request('/api/export.csv', { query: q(o), raw: true }),
  exportJson: (o) => request('/api/export.json', { query: q(o), raw: true }),
};

export const errText = (err, fallback = '操作未完成') => (err instanceof Error && err.message ? err.message : fallback);
