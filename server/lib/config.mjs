// 配置集中处：环境变量 + 默认值。零依赖，只 import Node 内置模块。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

// 合规红线：只允许回环地址。任何非回环值一律强制回落到 127.0.0.1。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertLoopback(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(h)) return false;
  return true;
}

function readInt(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readReal(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return fallback;
}

export function loadConfig(env = process.env, root = REPO_ROOT) {
  const hostRaw = env.RVS_HOST || '127.0.0.1';
  const host = assertLoopback(hostRaw) ? hostRaw : '127.0.0.1';
  const dataDir = path.resolve(env.RVS_DATA_DIR || path.join(root, 'data'));

  const cfg = {
    root,
    host,
    hostOverridden: host !== hostRaw,
    port: readInt(env, 'RVS_PORT', 4173),
    proxy: (env.RVS_PROXY === undefined ? 'http://127.0.0.1:7897' : env.RVS_PROXY).trim(),
    dataDir,
    framesDir: path.join(dataDir, 'frames'),
    exportsDir: path.join(dataDir, 'exports'),
    logsDir: path.join(dataDir, 'logs'),
    cacheDir: path.join(root, 'cache'),
    htmlCacheDir: path.join(root, 'cache', 'html'),
    dbPath: path.join(dataDir, 'rvs.db'),
    staticDir: path.join(root, 'public'),
    ffmpeg: env.RVS_FFMPEG || 'ffmpeg',
    ffprobe: env.RVS_FFPROBE || 'ffprobe',
    logLevel: (env.RVS_LOG_LEVEL || 'info').toLowerCase(),
    nodeVersion: process.version,
    // SPEC 11 超时预算：1s 隧道 / 3s TLS / 5s 首字节 / 15s 整体
    net: {
      connectTimeoutMs: readInt(env, 'RVS_NET_CONNECT_TIMEOUT_MS', 1000),
      tlsTimeoutMs: readInt(env, 'RVS_NET_TLS_TIMEOUT_MS', 3000),
      ttfbTimeoutMs: readInt(env, 'RVS_NET_TTFB_TIMEOUT_MS', 5000),
      totalTimeoutMs: readInt(env, 'RVS_NET_TOTAL_TIMEOUT_MS', 15000),
    },
    media: {
      probeTimeoutMs: readInt(env, 'RVS_MEDIA_PROBE_TIMEOUT_MS', 20000),
      extractTimeoutMs: readInt(env, 'RVS_MEDIA_EXTRACT_TIMEOUT_MS', 120000),
      maxStderrBytes: 8 * 1024 * 1024,
    },
    queue: {
      extractParallelism: readInt(env, 'RVS_EXTRACT_PARALLELISM', 1),
      analysisParallelism: readInt(env, 'RVS_ANALYSIS_PARALLELISM', 2),
      perEngineParallelism: readInt(env, 'RVS_PER_ENGINE_PARALLELISM', 1),
      minIntervalMs: readInt(env, 'RVS_ENGINE_MIN_INTERVAL_MS', 1200),
      intervalJitter: 0.2,
    },
    extract: {
      defaultMode: 'interval',
      defaultMaxFrames: 12,
      maxFramesCeiling: 60,
      defaultIntervalMs: 1500,
      defaultSceneThreshold: 0.25,
      targetWidth: 320,
      jpegQuality: 3,
    },
    hash: {
      hammingThreshold: readInt(env, 'RVS_HASH_HAMMING_THRESHOLD', 6),
    },
    bridge: {
      maxEdge: 640,
      jpegQuality: 3,
    },
    // 遥测默认关闭，关闭态零外发（PRD EARS 23）
    telemetry: {
      enabled: readBool(env, 'RVS_TELEMETRY', false),
      endpoint: env.RVS_TELEMETRY_ENDPOINT || '',
    },
    retentionDays: readInt(env, 'RVS_RETENTION_DAYS', 30),
    debugRetainRawHtml: readBool(env, 'RVS_DEBUG_RETAIN_RAW_HTML', false),
  };

  cfg.offline = readBool(env, 'RVS_OFFLINE', false);
  return cfg;
}

export function ensureDirs(cfg) {
  for (const dir of [cfg.dataDir, cfg.framesDir, cfg.exportsDir, cfg.logsDir, cfg.htmlCacheDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return cfg;
}

let cached = null;
export function getConfig() {
  if (!cached) cached = ensureDirs(loadConfig());
  return cached;
}

export function setConfig(cfg) {
  cached = cfg;
  return cached;
}
