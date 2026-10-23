// 导出域路由：CSV（BOM + 注入防护）与 JSON（schema 版本 + 生成时间）。
// 导出遵循当前筛选参数，与 /api/results 同一套语义。
import { sendBuffer } from '../lib/server/json.mjs';

const EXPORT_LIMIT = 10000;

export function registerExportRoutes(router, ctx) {
  const { resultService, exportService } = ctx.services;

  async function collect(query) {
    const result = await resultService.list({
      task_id: query.get('task_id'),
      q: query.get('q'),
      domain: query.get('domain'),
      provider: query.get('provider'),
      min_score: query.get('min_score'),
      sort: query.get('sort'),
      order: query.get('order'),
      limit: EXPORT_LIMIT,
      offset: 0,
    });
    return result.items;
  }

  router.get('/api/export.csv', async (req, res, { query }) => {
    const items = await collect(query);
    const csv = exportService.toCsv(items);
    return sendBuffer(res, 200, Buffer.from(csv, 'utf8'), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="rvs-results.csv"',
    });
  });

  router.get('/api/export.json', async (req, res, { query }) => {
    const items = await collect(query);
    const filters = {
      task_id: query.get('task_id'),
      q: query.get('q'),
      domain: query.get('domain'),
      provider: query.get('provider'),
      min_score: query.get('min_score'),
      sort: query.get('sort') || 'sort_score',
      order: query.get('order') || 'desc',
    };
    const json = exportService.toJson(items, { filters });
    return sendBuffer(res, 200, Buffer.from(json, 'utf8'), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="rvs-results.json"',
    });
  });
}
