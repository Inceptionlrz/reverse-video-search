// 日志域路由：结构化日志查询（内存环形缓冲，已脱敏）。
import { sendOk } from '../lib/server/json.mjs';

export function registerLogRoutes(router, ctx) {
  const { logsService } = ctx.services;

  router.get('/api/logs', async (req, res, { query, requestId }) => {
    const result = logsService.query({
      level: query.get('level'),
      category: query.get('category'),
      since: query.get('since'),
      until: query.get('until'),
      q: query.get('q'),
      request_id: query.get('request_id'),
      task_id: query.get('task_id'),
      event: query.get('event'),
      limit: query.get('limit'),
      offset: query.get('offset'),
    });
    return sendOk(res, result, { requestId });
  });
}
