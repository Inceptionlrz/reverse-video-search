// 帧域路由：帧列表（含去重分组与启用态）、批量启停。
import { readBody, sendOk } from '../lib/server/json.mjs';

export function registerFrameRoutes(router, ctx) {
  const { frameService } = ctx.services;

  router.get('/api/tasks/:id/frames', async (req, res, { params, query, requestId }) => {
    const includeDuplicates = query.get('include_duplicates') !== '0';
    const items = await frameService.list(params.id, { includeDuplicates });
    return sendOk(res, { items, total: items.length }, { requestId });
  });

  router.patch('/api/tasks/:id/frames', async (req, res, { params, requestId }) => {
    const body = await readBody(req);
    const frameIds = Array.isArray(body.frame_ids) ? body.frame_ids : null;
    const result = await frameService.setEnabled(params.id, { frameIds, enabled: body.enabled === true });
    return sendOk(res, result, { requestId });
  });
}
