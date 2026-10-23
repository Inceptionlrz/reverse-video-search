// 结构化日志：内存环形缓冲 + JSONL 落盘。写入前统一脱敏，第三方凭据永不落盘（PRD EARS 29）。
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_CAPACITY = 2000;

const SENSITIVE_KEY = /(key|token|secret|password|passwd|credential|authorization|cookie|signature|apikey|api_key)/i;
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi;

export function redactText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(URL_USERINFO, '$1***@');
}

export function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(redactValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactValue(v);
    }
    return out;
  }
  return value;
}

function safeStringify(value) {
  try {
    return JSON.stringify(redactValue(value));
  } catch {
    return '"[unserializable]"';
  }
}

export class Logger {
  constructor(options = {}) {
    this.level = LEVELS[options.level] || LEVELS.info;
    this.ring = [];
    this.seq = 0;
    this.logDir = options.logDir || null;
    this.sink = options.sink || null;
  }

  setLevel(level) {
    this.level = LEVELS[level] || this.level;
  }

  write(level, category, event, message, fields = {}) {
    const weight = LEVELS[level] || LEVELS.info;
    if (weight < this.level) return null;
    this.seq += 1;
    const entry = {
      seq: this.seq,
      ts: new Date().toISOString(),
      level,
      category: category || 'app',
      event: event || 'log',
      message: redactText(String(message || '')),
      fields: redactValue(fields || {}),
    };
    this.ring.push(entry);
    if (this.ring.length > RING_CAPACITY) this.ring.splice(0, this.ring.length - RING_CAPACITY);
    if (this.sink) this.sink(entry);
    if (this.logDir) this.appendFile(entry);
    return entry;
  }

  appendFile(entry) {
    try {
      const day = entry.ts.slice(0, 10).replace(/-/g, '');
      const file = path.join(this.logDir, `rvs-${day}.jsonl`);
      fs.appendFileSync(file, `${safeStringify(entry)}\n`, 'utf8');
    } catch {
      // 日志落盘失败不得影响主流程
    }
  }

  debug(category, event, message, fields) {
    return this.write('debug', category, event, message, fields);
  }

  info(category, event, message, fields) {
    return this.write('info', category, event, message, fields);
  }

  warn(category, event, message, fields) {
    return this.write('warn', category, event, message, fields);
  }

  error(category, event, message, fields) {
    return this.write('error', category, event, message, fields);
  }

  query(filter = {}) {
    const levels = filter.level ? String(filter.level).split(',').map((s) => s.trim()) : null;
    const cats = filter.category ? String(filter.category).split(',').map((s) => s.trim()) : null;
    let rows = this.ring;
    if (levels) rows = rows.filter((r) => levels.includes(r.level));
    if (cats) rows = rows.filter((r) => cats.includes(r.category));
    if (filter.since) rows = rows.filter((r) => r.ts >= filter.since);
    if (filter.until) rows = rows.filter((r) => r.ts <= filter.until);
    if (filter.q) rows = rows.filter((r) => r.message.includes(filter.q));
    if (filter.request_id) rows = rows.filter((r) => r.fields && r.fields.request_id === filter.request_id);
    if (filter.task_id) rows = rows.filter((r) => r.fields && r.fields.task_id === filter.task_id);
    if (filter.event) rows = rows.filter((r) => r.event === filter.event);
    return rows;
  }
}

let instance = null;

export function initLogger(options) {
  instance = new Logger(options);
  return instance;
}

export function getLogger() {
  if (!instance) instance = new Logger({ level: 'info', logDir: null });
  return instance;
}
