// 错误码字典与统一异常类型。错误码与 HTTP 状态的唯一映射处。
export const ERROR_CODES = {
  RATE_LIMITED: 429,
  FORBIDDEN: 403,
  CAPTCHA: 400,
  NETWORK_ERROR: 502,
  TIMEOUT: 504,
  PARSE_ERROR: 422,
  // 与 PARSE_ERROR 同状态但语义不同：不是"解析失败"，
  // 而是"该引擎的结果只能在浏览器里渲染，HTTP 层根本取不到数据"（Google Lens 实测如此）。
  // 混用 PARSE_ERROR 会把用户引向"改解析规则"的错误排障方向。
  ENGINE_NO_HTTP_RESULT: 422,
  UPLOAD_REJECTED: 413,
  PROXY_UNREACHABLE: 502,
  PROVIDER_DISABLED: 503,
  // ZERO_RESULT 是成功零命中，不视为错误，不使用本表抛出
  ZERO_RESULT: 200,
  BAD_REQUEST: 400,
  CONSENT_REQUIRED: 400,
  MEDIA_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
};

export function httpStatusFor(code) {
  return ERROR_CODES[code] || 500;
}

// 可自动重试的错误码（PRD EARS 28）：限频 / 网络错误 / 解析异常 / 凭据错误 / 超时。
// 显式排除 CAPTCHA（EARS 10 与 Spec 14-2）与 UPLOAD_REJECTED、PROVIDER_DISABLED。
export const RETRYABLE_ERROR_CODES = Object.freeze([
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'PARSE_ERROR',
  'TIMEOUT',
  'FORBIDDEN',
]);

// 命中 / 零命中 / 手工态永不被重试选中（Spec 14-1、EARS 28）。
export const NON_RETRYABLE_STATUSES = Object.freeze([
  'succeeded',
  'zero_result',
  'manual',
  'running',
  'queued',
]);

export function isRetryableErrorCode(code) {
  return typeof code === 'string' && RETRYABLE_ERROR_CODES.includes(code);
}

export class RvsError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'RvsError';
    this.code = code;
    this.detail = options.detail ?? null;
    this.httpStatus = options.httpStatus ?? httpStatusFor(code);
    this.retryable = false;
    this.fields = options.fields ?? null;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      fields: this.fields,
    };
  }
}

export function badRequest(message, detail) {
  return new RvsError('BAD_REQUEST', message, { detail });
}

export function notFound(message, detail) {
  return new RvsError('NOT_FOUND', message, { detail });
}

export function conflict(message, detail) {
  return new RvsError('CONFLICT', message, { detail });
}

export function mediaError(message, detail) {
  return new RvsError('MEDIA_ERROR', message, { detail });
}

export function consentRequired(message, detail) {
  return new RvsError('CONSENT_REQUIRED', message, { detail });
}

// 把底层异常归一为 RvsError。未知异常一律 INTERNAL，不向客户端泄漏细节。
export function toRvsError(err) {
  if (err instanceof RvsError) return err;
  const message = err && err.message ? err.message : String(err);
  return new RvsError('INTERNAL', '服务内部错误', { detail: message });
}
