// 结果域路由：结果集（筛选/排序/分页）、单条线索证据链。
import { sendOk } from '../lib/server/json.mjs';
import { notFound } from '../lib/errors.mjs';

export function registerResultRoutes(router, ctx) {
  const { resultService } = ctx.services;

  router.get('/api/results', async (req, res, { query, requestId }) => {
    const result = await resultService.list({
      task_id: query.get('task_id'),
      q: query.get('q'),
      domain: query.get('domain'),
      provider: query.get('provider'),
      min_score: query.get('min_score'),
      sort: query.get('sort'),
      order: query.get('order'),
      limit: query.get('limit'),
      offset: query.get('offset'),
    });
    return sendOk(res, result, { requestId });
  });

  // GET /api/results/:id/hits：证据链（哪帧、哪个引擎、第几位命中）
  router.get('/api/results/:id/hits', async (req, res, { params, requestId }) => {
    const detail = await resultService.detail(params.id);
    if (!detail) throw notFound('线索不存在', { result_id: params.id });
    return sendOk(res, detail, { requestId });
  });
}
