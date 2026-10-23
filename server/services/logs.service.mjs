// 日志服务：内存环形缓冲查询（logger.query 的薄封装 + 脱敏保证）。
import { getLogger } from '../lib/logger.mjs';

export function createLogsService() {
  const logger = getLogger();

  function query(params = {}) {
    const rows = logger.query({
      level: params.level || null,
      category: params.category || null,
      since: params.since || null,
      until: params.until || null,
      q: params.q || null,
      request_id: params.request_id || null,
      task_id: params.task_id || null,
      event: params.event || null,
    });
    const limit = Math.min(500, Math.max(1, Number.parseInt(params.limit, 10) || 100));
    const offset = Math.max(0, Number.parseInt(params.offset, 10) || 0);
    const items = rows.slice().reverse().slice(offset, offset + limit);
    return { items, total: rows.length, limit, offset };
  }

  function write(level, category, event, message, fields) {
    return logger[level] ? logger[level](category, event, message, fields) : logger.info(category, event, message, fields);
  }

  return { query, write, logger };
}
