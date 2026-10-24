// 应用装配：DB → 仓储 → 服务 → 路由 → HTTP 服务器。入口只做装配，不写业务。
// 合规红线（SPEC §0.5）：仅绑定回环地址；启动自检失败直接退出，不 fallback 到 0.0.0.0。
import http from 'node:http';
import path from 'node:path';
import { getConfig, ensureDirs, assertLoopback, setConfig } from './lib/config.mjs';
import { openDb } from './lib/db/client.mjs';
import { migrate } from './lib/db/migrate.mjs';
import { createTasksRepo } from './lib/db/repo/tasks.repo.mjs';
import { createFramesRepo } from './lib/db/repo/frames.repo.mjs';
import { createAnalysesRepo } from './lib/db/repo/analyses.repo.mjs';
import { createResultsRepo } from './lib/db/repo/results.repo.mjs';
import { createResultHitsRepo } from './lib/db/repo/result-hits.repo.mjs';
import { createEngineHealthRepo } from './lib/db/repo/engine-health.repo.mjs';
import { createSettingsRepo } from './lib/db/repo/settings.repo.mjs';
import { initLogger } from './lib/logger.mjs';
import { createRouter } from './lib/server/router.mjs';
import { createStaticHandler } from './lib/server/static.mjs';
import { attachRequestId, sendFail, sendJson } from './lib/server/json.mjs';
import { toRvsError } from './lib/errors.mjs';
import { CancelToken } from './lib/queue/token.mjs';
import { createRunner } from './lib/queue/runner.mjs';
import { createEngineRegistry } from './providers/registry.mjs';
import { createImageHostRegistry } from './providers/imagehost/registry.mjs';
import { createMetrics } from './providers/base.mjs';
import { createSettingsService } from './services/settings.service.mjs';
import { createEngineHealthService } from './services/engine-health.service.mjs';
import { createTaskService } from './services/task.service.mjs';
import { createFrameService } from './services/frame.service.mjs';
import { createResultService } from './services/result.service.mjs';
import { createAnalysisService } from './services/analysis.service.mjs';
import { createExportService } from './services/export.service.mjs';
import { createLogsService } from './services/logs.service.mjs';
import { registerAllRoutes } from './routes/index.mjs';

export async function createApp(options = {}) {
  const cfg = options.config || getConfig();
  // 调用方传入自定义 config 时同步到全局缓存，使各服务内的 getConfig() 取到同一份配置
  // （测试与冒烟脚本用临时数据目录 + 离线模式装配应用）。
  if (options.config) setConfig(options.config);
  ensureDirs(cfg);

  const db = openDb(options.dbPath || cfg.dbPath);
  await migrate(db);

  const logger = initLogger({ level: cfg.logLevel, logDir: cfg.logsDir });
  const repos = {
    tasks: createTasksRepo(db),
    frames: createFramesRepo(db),
    analyses: createAnalysesRepo(db),
    results: createResultsRepo(db),
    resultHits: createResultHitsRepo(db),
    engineHealth: createEngineHealthRepo(db),
    settings: createSettingsRepo(db),
  };

  const engines = createEngineRegistry();
  const imageHosts = createImageHostRegistry();
  const runner = createRunner({
    concurrency: cfg.queue.analysisParallelism,
    perKeyConcurrency: cfg.queue.perEngineParallelism,
    minIntervalMs: cfg.queue.minIntervalMs,
    jitter: cfg.queue.intervalJitter,
  });
  const metrics = createMetrics();
  const cancelTokens = new Map();

  const settingsService = createSettingsService({ settingsRepo: repos.settings });
  const health = createEngineHealthService({ engineHealthRepo: repos.engineHealth, logger });
  const repoDeps = {
    tasksRepo: repos.tasks,
    framesRepo: repos.frames,
    analysesRepo: repos.analyses,
    resultsRepo: repos.results,
    resultHitsRepo: repos.resultHits,
    engineHealthRepo: repos.engineHealth,
    settingsRepo: repos.settings,
  };
  const taskService = createTaskService({ ...repoDeps, logger });
  // cancelTokens 由帧服务与分析服务共享：取消必须同时能中断抽帧的 ffmpeg
  // 与检索的在飞 HTTP，否则 control{cancel} 只是改数据库状态。
  const frameService = createFrameService({ tasksRepo: repos.tasks, framesRepo: repos.frames, logger, cancelTokens });
  const resultService = createResultService({ ...repoDeps, db, logger, settingsService });
  const exportService = createExportService();
  const logsService = createLogsService();
  const analysisService = createAnalysisService({
    ...repoDeps,
    engines,
    imageHosts,
    resultService,
    logger,
    runner,
    health,
    settingsService,
    metrics,
    cancelTokens,
  });

  const staticHandler = createStaticHandler({
    staticDir: cfg.staticDir,
    framesDir: cfg.framesDir,
    thumbsDir: path.join(cfg.dataDir, 'thumbs'),
  });

  const router = createRouter();
  const ctx = { cfg, db, repos, logger, engines, imageHosts, runner, metrics, cancelTokens, services: { settingsService, health, taskService, frameService, resultService, exportService, logsService, analysisService } };
  registerAllRoutes(router, ctx);

  const startedAt = Date.now();
  const server = http.createServer((req, res) => {
    const requestId = attachRequestId(req, res);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let pathname = req.url || '/';
    try {
      pathname = decodeURI(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      sendFail(res, toRvsError(new Error('bad url')), requestId);
      return;
    }
    const hit = router.match(req.method || 'GET', pathname);
    if (hit) {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      Promise.resolve()
        .then(() => hit.route.handler(req, res, { params: hit.params, query, requestId, ctx }))
        .catch((err) => sendFail(res, err, requestId));
      return;
    }
    if (staticHandler(req, res, pathname)) return;
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口或资源不存在', detail: null } }, { 'X-Request-Id': requestId });
  });

  return {
    cfg,
    db,
    router,
    server,
    ctx,
    services: ctx.services,
    metrics,
    startedAt,
    // 启动自检：回环绑定是硬约束（SPEC §0.5 / §14 验收项 7）。
    assertBindAddress() {
      if (!assertLoopback(cfg.host)) {
        throw new Error(`RVS_HOST=${cfg.host} 不是回环地址；本服务只允许绑定 127.0.0.1 / localhost / ::1，拒绝启动`);
      }
      return true;
    },
    async listen() {
      this.assertBindAddress();
      await analysisService.resumeQueued(); // 断点恢复：重启后拾起排队项（调度层过滤停用引擎）
      await analysisService.settleStalledTasks(); // 启动自愈：收敛修复前遗留的「 analyzing 但无未完成作业」任务
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => {
          server.removeListener('error', reject);
          logger.info('app', 'ready', `RVS ready on http://${cfg.host}:${cfg.port}`, { port: cfg.port, host: cfg.host, pid: process.pid });
          resolve(server);
        });
      });
    },
    async close() {
      runner.cancelPending('shutdown');
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

export { CancelToken };
