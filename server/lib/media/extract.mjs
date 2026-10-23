// 抽帧调度：interval（固定间隔）/ scene（场景切换）/ both（先场景后补足）。
// 所有 ffmpeg 调用走 spawnBinary（spawn + 参数数组，不经过 shell），不拼接 shell 字符串。
import fs from 'node:fs';
import path from 'node:path';
import { spawnBinary } from './probe.mjs';

function frameName(seq, timeMs) {
  return `${String(seq).padStart(3, '0')}_${timeMs}.jpg`;
}

function plannedIntervalMs(durationMs, maxFrames, requestedMs) {
  if (!durationMs || durationMs <= 0) return requestedMs;
  const estimate = Math.floor(durationMs / requestedMs) + 1;
  if (estimate <= maxFrames) return requestedMs;
  return Math.max(1, Math.floor(durationMs / maxFrames));
}

// interval：先按 plannedIntervalMs 计算等距取点，再逐点 -ss 快 seek 导出（与 extractAtTime 同一机制）。
// 不用 fps 滤镜一次成型：fps 滤镜在 concat/多段源上的取点与实际时间戳存在偏差
// （实测同一 concat 视频，fps 路径第 2 帧落到相邻段落，-ss 直取才与时间戳一致）。
export async function extractInterval(cfg, opts) {
  const { source, outDir, maxFrames, intervalMs, durationMs, width, quality, cancelToken, prefix = 'f' } = opts;
  const step = plannedIntervalMs(durationMs, maxFrames, intervalMs);
  const points = [];
  if (durationMs && durationMs > 0) {
    for (let t = 0; t < durationMs && points.length < maxFrames; t += step) points.push(t);
    if (!points.length) points.push(0);
  } else {
    // 时长未知：按步长预放 maxFrames 个点，取不到帧即止（见下方 existsSync 断路）。
    for (let i = 0; i < maxFrames; i += 1) points.push(i * step);
  }
  const truncated = Boolean(durationMs) && points.length >= maxFrames && Math.floor(durationMs / step) + 1 > maxFrames;
  const files = [];
  for (let i = 0; i < points.length; i += 1) {
    const name = `${prefix}_${String(i + 1).padStart(3, '0')}.jpg`;
    const output = path.join(outDir, name);
    await extractAtTime(cfg, { source, output, timeMs: points[i], width, quality, cancelToken });
    if (!fs.existsSync(output)) break; // 取点超出媒体实际长度：停止补点，不作为失败
    files.push({ name, timeMs: points[i] });
  }
  return { files, intervalMs: step, truncated };
}

export function parseSceneTimes(stderr) {
  const times = [];
  for (const m of String(stderr || '').matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
    const t = Math.round(Number.parseFloat(m[1]) * 1000);
    if (Number.isFinite(t)) times.push(t);
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

export async function detectScenes(cfg, { source, threshold, cancelToken }) {
  const args = [
    '-v', 'info',
    '-i', source,
    '-filter:v', `select='gt(scene,${threshold})',showinfo`,
    '-f', 'null',
    '-',
  ];
  const res = await spawnBinary(cfg.ffmpeg, args, {
    timeoutMs: cfg.media.extractTimeoutMs,
    cancelToken,
    maxBuffer: cfg.media.maxStderrBytes,
  });
  return parseSceneTimes(res.stderr);
}

export async function extractAtTime(cfg, { source, output, timeMs, width, quality, cancelToken }) {
  const seconds = (timeMs / 1000).toFixed(3);
  const args = [
    '-ss', seconds,
    '-i', source,
    '-frames:v', '1',
    '-q:v', String(quality),
    '-vf', `scale=${width}:-2`,
    output,
    '-y',
  ];
  await spawnBinary(cfg.ffmpeg, args, { timeoutMs: cfg.media.extractTimeoutMs, cancelToken });
  return output;
}

// both：先取场景帧，不足 maxFrames 时用等距抽样补足，按时间排序并去掉过近的时间点。
export function mergeTimes(sceneTimes, durationMs, maxFrames, intervalMs, minGapMs = 300) {
  const merged = [...sceneTimes];
  if (merged.length < maxFrames && durationMs > 0) {
    const step = Math.max(intervalMs, Math.floor(durationMs / maxFrames));
    for (let t = 0; t < durationMs && merged.length < maxFrames + 12; t += step) {
      merged.push(t);
    }
  }
  const sorted = [...new Set(merged)].sort((a, b) => a - b);
  const kept = [];
  for (const t of sorted) {
    if (!kept.length || t - kept[kept.length - 1] >= minGapMs) kept.push(t);
  }
  return kept.slice(0, maxFrames);
}

export async function extractByMode(cfg, opts) {
  const { source, outDir, mode, maxFrames, intervalMs, sceneThreshold, durationMs, width, quality, cancelToken } = opts;
  if (mode === 'interval') {
    const res = await extractInterval(cfg, { source, outDir, maxFrames, intervalMs, durationMs, width, quality, cancelToken });
    return { times: res.files.map((f) => f.timeMs), strategy: 'interval', notes: res.truncated ? ['duration_too_long'] : [] };
  }
  if (mode === 'scene') {
    const times = (await detectScenes(cfg, { source, threshold: sceneThreshold, cancelToken })).slice(0, maxFrames);
    if (!times.length) {
      const res = await extractInterval(cfg, { source, outDir, maxFrames, intervalMs, durationMs, width, quality, cancelToken });
      return { times: res.files.map((f) => f.timeMs), strategy: 'scene_empty_fallback_interval', notes: ['no_scene_detected'] };
    }
    return { times, strategy: 'scene', notes: [] };
  }
  const sceneTimes = await detectScenes(cfg, { source, threshold: sceneThreshold, cancelToken });
  const times = mergeTimes(sceneTimes, durationMs, maxFrames, intervalMs);
  if (!times.length) {
    const res = await extractInterval(cfg, { source, outDir, maxFrames, intervalMs, durationMs, width, quality, cancelToken });
    return { times: res.files.map((f) => f.timeMs), strategy: 'both_fallback_interval', notes: ['no_scene_detected'] };
  }
  return { times, strategy: 'scene_then_interval', notes: [] };
}

export { frameName };
