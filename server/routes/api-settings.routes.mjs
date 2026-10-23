// 设置域路由：读取（可写项 + 只读镜像）与部分更新。
import { readBody, sendOk } from '../lib/server/json.mjs';
import { badRequest } from '../lib/errors.mjs';

export function registerSettingsRoutes(router, ctx) {
  const { settingsService } = ctx.services;

  router.get('/api/settings', async (req, res, { requestId }) => {
    return sendOk(res, await settingsService.get(), { requestId });
  });

  router.put('/api/settings', async (req, res, { requestId }) => {
    const body = await readBody(req);
    if (!Object.keys(body).length) throw badRequest('设置体不能为空');
    const next = await settingsService.put(body);
    return sendOk(res, { writable: next }, { requestId });
  });
}
