// 分析域路由：启动分析、单条状态与降级日志、任务分析矩阵。
import { readBody, sendOk } from '../lib/server/json.mjs';
import { badRequest } from '../lib/errors.mjs';

export function registerAnalysisRoutes(router, ctx) {
  const { analysisService } = ctx.services;

  // POST /api/search/run-analyses：服务端强制校验 consentAck 与任务确认（SPEC §14 验收项 3）
  router.post('/api/search/run-analyses', async (req, res, { requestId }) => {
    const body = await readBody(req);
    if (!body.task_id) throw badRequest('缺少 task_id');
    const result = await analysisService.run(body.task_id, {
      frame_ids: body.frame_ids,
      providers: body.providers,
      options: body.options || {},
      consent_ack: body.consent_ack === true,
    });
    return sendOk(res, result, { status: 202, requestId });
  });

  router.get('/api/search/analyses/:id', async (req, res, { params, requestId }) => {
    return sendOk(res, { analysis: await analysisService.get(params.id) }, { requestId });
  });

  router.get('/api/tasks/:id/analyses', async (req, res, { params, requestId }) => {
    const items = await analysisService.listByTask(params.id);
    return sendOk(res, { items, total: items.length }, { requestId });
  });
}
