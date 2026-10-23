// 引擎域路由：状态聚合、启停与方式开关、连通性自测。
import { readBody, sendOk } from '../lib/server/json.mjs';
import { badRequest, notFound } from '../lib/errors.mjs';

export function registerEngineRoutes(router, ctx) {
  const { health, settingsService } = ctx.services;

  router.get('/api/engines', async (req, res, { requestId }) => {
    const engines = await health.list(ctx.engines);
    const settings = await settingsService.load();
    return sendOk(
      res,
      {
        engines: engines.map((e) => ({
          ...e,
          modes: settings.engines[e.id] || { deeplink: false, upload: false },
        })),
        imagehost: {
          ...settings.imagehost,
          hosts: [...ctx.imageHosts.values()].map((h) => ({ id: h.id, label: h.label, retention: h.retention, verified: h.verified })),
        },
      },
      { requestId },
    );
  });

  // PATCH /api/engines/:provider：{enabled} 或 {deeplink} / {upload}
  router.patch('/api/engines/:provider', async (req, res, { params, requestId }) => {
    if (!ctx.engines.has(params.provider)) throw notFound('引擎不存在', { provider: params.provider });
    const body = await readBody(req);
    let result = { provider: params.provider };
    if (typeof body.enabled === 'boolean') {
      result = { ...result, ...(await health.setEnabled(params.provider, body.enabled)) };
    }
    if (body.deeplink !== undefined || body.upload !== undefined) {
      const patch = { engines: { [params.provider]: {} } };
      if (typeof body.deeplink === 'boolean') patch.engines[params.provider].deeplink = body.deeplink;
      if (typeof body.upload === 'boolean') patch.engines[params.provider].upload = body.upload;
      const next = await settingsService.put(patch);
      result = { ...result, modes: next.engines[params.provider] };
    }
    if (Object.keys(result).length === 1) throw badRequest('没有可应用的字段（enabled / deeplink / upload）');
    const engines = await health.list(ctx.engines);
    return sendOk(res, { ...result, engine: engines.find((e) => e.id === params.provider) }, { requestId });
  });

  // GET /api/engines/:provider/probe：连通性自测，HTTP 恒 200，可达性在 data 中表达
  router.get('/api/engines/:provider/probe', async (req, res, { params, requestId }) => {
    if (!ctx.engines.has(params.provider)) throw notFound('引擎不存在', { provider: params.provider });
    const result = await health.probe(ctx.engines, params.provider, ctx.metrics);
    return sendOk(res, result, { requestId });
  });
}
