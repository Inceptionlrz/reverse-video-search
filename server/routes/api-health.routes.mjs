// GET /api/health：进程状态、ffmpeg 可用性、DB 状态、代理配置与可达性（缓存 30s）。
import { readBody, sendOk } from '../lib/server/json.mjs';
import { spawnBinary } from '../lib/media/probe.mjs';
import { request } from '../lib/http/request.mjs';

let ffmpegCache = null;
let proxyCache = { at: 0, value: null };

async function ffmpegStatus(ctx) {
  if (ffmpegCache) return ffmpegCache;
  try {
    const res = await spawnBinary(ctx.cfg.ffmpeg, ['-version'], { timeoutMs: 5000 });
    const first = String(res.stderr || res.stdout || '').split(/\r?\n/)[0] || '';
    ffmpegCache = { available: true, version_line: first.slice(0, 120), binary: ctx.cfg.ffmpeg };
  } catch (err) {
    ffmpegCache = { available: false, version_line: null, binary: ctx.cfg.ffmpeg, error: String(err.message).slice(0, 200) };
  }
  return ffmpegCache;
}

async function proxyStatus(ctx) {
  const now = Date.now();
  if (proxyCache.value && now - proxyCache.at < 30000) return proxyCache.value;
  if (!ctx.cfg.proxy) {
    proxyCache = { at: now, value: { configured: false, reachable: null, note: '未配置代理，出站为直连' } };
    return proxyCache.value;
  }
  const res = await request('https://www.bing.com/', { config: ctx.cfg, proxy: ctx.cfg.proxy, method: 'GET', totalTimeoutMs: 4000, ttfbTimeoutMs: 3000 });
  proxyCache = {
    at: now,
    value: {
      configured: true,
      reachable: res.ok,
      note: res.ok ? '代理隧道可达' : `代理不可达：${res.errorMessage}`,
      latency_ms: res.latencyMs ?? null,
    },
  };
  return proxyCache.value;
}

export function registerHealthRoutes(router, ctx) {
  router.get('/api/health', async (req, res, { requestId }) => {
    const engines = await ctx.services.health.list(ctx.engines);
    const dbOk = Boolean(ctx.db && ctx.db.path);
    void readBody;
    return sendOk(
      res,
      {
        status: 'ok',
        pid: process.pid,
        uptime_ms: Date.now() - ctx.startedAt,
        node_version: process.version,
        sqlite: 'node:sqlite',
        db: { path: ctx.cfg.dbPath, ok: dbOk },
        ffmpeg: await ffmpegStatus(ctx),
        proxy: await proxyStatus(ctx),
        offline: ctx.cfg.offline,
        host: ctx.cfg.host,
        port: ctx.cfg.port,
        engines: engines.map((e) => ({ id: e.id, label: e.label, enabled: e.enabled, circuit_open: e.circuit_open })),
      },
      { requestId },
    );
  });
}
