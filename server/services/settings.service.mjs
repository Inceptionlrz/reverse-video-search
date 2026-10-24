// 设置服务：默认值 + 白名单校验 + 部分更新。
// 可写项：抽帧参数、引擎方式开关、图床开关与站点选择、相似度计算开关、导出目录。
// 只读项（来自启动环境变量，改需重启）：监听地址/端口、代理、超时预算、并发、日志级别。
import { badRequest } from '../lib/errors.mjs';
import { getConfig } from '../lib/config.mjs';

export const DEFAULT_SETTINGS = {
  extract: {
    mode: 'interval', // interval | scene | both
    max_frames: 12,
    interval_ms: 1500,
    scene_threshold: 0.25,
  },
  engines: {
    // 方式开关；启停状态在 engine_health 表，由引擎诊断页维护。
    google_lens: { deeplink: false, upload: false }, // deeplink 实测不可用，默认关且不可开
    yandex: { deeplink: true, upload: false },
    bing: { deeplink: true, upload: false },
  },
  imagehost: {
    enabled: true, // 用户决策：图床桥接默认开；但具体站点仍需显式选择
    provider: null, // 'catbox' | '0x0' | 'tmpfiles'，null = 未选择（桥接不可用）
  },
  similarity: {
    compute_thumb_hash: false, // 开启后会临时下载结果缩略图算本地哈希（不落盘）
  },
  export: {
    dir: null, // null = data/exports
  },
};

const EXTRACT_MODES = ['interval', 'scene', 'both'];
const IMAGEHOST_IDS = ['catbox', '0x0', 'tmpfiles'];

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampReal(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 深度合并：只覆盖白名单内的叶子键，未识别的键原样保留（向前兼容）。
export function mergeSettings(current, patch) {
  const next = structuredClone(current);
  const ex = patch?.extract;
  if (ex && typeof ex === 'object') {
    if (EXTRACT_MODES.includes(ex.mode)) next.extract.mode = ex.mode;
    if (ex.max_frames !== undefined) next.extract.max_frames = clampInt(ex.max_frames, 1, 60, next.extract.max_frames);
    if (ex.interval_ms !== undefined) next.extract.interval_ms = clampInt(ex.interval_ms, 200, 60000, next.extract.interval_ms);
    if (ex.scene_threshold !== undefined) {
      next.extract.scene_threshold = clampReal(ex.scene_threshold, 0.05, 0.9, next.extract.scene_threshold);
    }
  }
  const engines = patch?.engines;
  if (engines && typeof engines === 'object') {
    for (const [id, modes] of Object.entries(engines)) {
      if (!next.engines[id] || !modes || typeof modes !== 'object') continue;
      if (id === 'google_lens' && modes.deeplink === true) continue; // 不可开：实测无结果结构
      if (typeof modes.deeplink === 'boolean') next.engines[id].deeplink = modes.deeplink;
      if (typeof modes.upload === 'boolean') next.engines[id].upload = modes.upload;
    }
  }
  const host = patch?.imagehost;
  if (host && typeof host === 'object') {
    if (typeof host.enabled === 'boolean') next.imagehost.enabled = host.enabled;
    if (host.provider === null || IMAGEHOST_IDS.includes(host.provider)) next.imagehost.provider = host.provider;
  }
  const sim = patch?.similarity;
  if (sim && typeof sim === 'object' && typeof sim.compute_thumb_hash === 'boolean') {
    next.similarity.compute_thumb_hash = sim.compute_thumb_hash;
  }
  const exp = patch?.export;
  if (exp && typeof exp === 'object') {
    next.export.dir = typeof exp.dir === 'string' && exp.dir.trim() ? exp.dir.trim() : null;
  }
  return next;
}

export function validateSettings(patch) {
  if (!patch || typeof patch !== 'object') throw badRequest('设置体必须是 JSON 对象');
  const host = patch.imagehost;
  if (host && host.provider !== undefined && host.provider !== null && !IMAGEHOST_IDS.includes(host.provider)) {
    throw badRequest('未知的图床站点', { allowed: IMAGEHOST_IDS });
  }
  return true;
}

// 只读镜像：把启动环境变量整理成 UI 可展示的形态。
export function readOnlySettings(cfg = getConfig()) {
  return {
    server: { host: cfg.host, port: cfg.port },
    network: {
      proxy: cfg.proxy || null,
      proxy_note: cfg.proxy ? '出站经本地代理' : '出站为直连',
      timeouts_ms: cfg.net,
      min_interval_ms: cfg.queue.minIntervalMs,
      parallelism: {
        extract: cfg.queue.extractParallelism,
        analysis: cfg.queue.analysisParallelism,
        per_engine: cfg.queue.perEngineParallelism,
      },
    },
    media: { ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe },
    logging: { level: cfg.logLevel, dir: cfg.logsDir },
    telemetry: { enabled: cfg.telemetry.enabled, endpoint: cfg.telemetry.endpoint },
  };
}

export function createSettingsService({ settingsRepo }) {
  async function load() {
    const row = await settingsRepo.get('app');
    const stored = row && row.value && typeof row.value === 'object' ? row.value : {};
    return mergeSettings(DEFAULT_SETTINGS, stored);
  }

  async function get() {
    const cfg = getConfig();
    return { writable: await load(), read_only: readOnlySettings(cfg), defaults: DEFAULT_SETTINGS };
  }

  async function put(patch) {
    validateSettings(patch);
    const current = await load();
    const next = mergeSettings(current, patch);
    await settingsRepo.set('app', next);
    return next;
  }

  return { load, get, put, defaults: DEFAULT_SETTINGS };
}
