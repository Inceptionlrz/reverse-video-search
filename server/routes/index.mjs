// 路由注册总入口：按领域分文件，避免单文件膨胀。
import { registerHealthRoutes } from './api-health.routes.mjs';
import { registerTaskRoutes } from './api-tasks.routes.mjs';
import { registerFrameRoutes } from './api-frames.routes.mjs';
import { registerAnalysisRoutes } from './api-analyses.routes.mjs';
import { registerResultRoutes } from './api-results.routes.mjs';
import { registerExportRoutes } from './api-export.routes.mjs';
import { registerEngineRoutes } from './api-engines.routes.mjs';
import { registerSettingsRoutes } from './api-settings.routes.mjs';
import { registerLogRoutes } from './api-logs.routes.mjs';

export function registerAllRoutes(router, ctx) {
  registerHealthRoutes(router, ctx);
  registerTaskRoutes(router, ctx);
  registerFrameRoutes(router, ctx);
  registerAnalysisRoutes(router, ctx);
  registerResultRoutes(router, ctx);
  registerExportRoutes(router, ctx);
  registerEngineRoutes(router, ctx);
  registerSettingsRoutes(router, ctx);
  registerLogRoutes(router, ctx);
  return router;
}
