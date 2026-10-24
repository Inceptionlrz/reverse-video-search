// 帧服务：抽帧编排（异步）、帧查询、批量启停、帧内去重分组。
// 抽帧为异步过程：startExtract 立即返回，状态经 tasks.status 轮询（created→extracting→frames_ready/failed）。
import fs from 'node:fs';
import path from 'node:path';
import { newFrameId } from '../lib/ids.mjs';
import { getConfig } from '../lib/config.mjs';
import { conflict, notFound } from '../lib/errors.mjs';
import { probeMedia } from '../lib/media/probe.mjs';
import {
  detectScenes,
  extractAtTime,
  extractInterval,
  frameName,
  mergeTimes,
} from '../lib/media/extract.mjs';
import { dhashOfFile, groupByHamming } from '../lib/media/hash.mjs';
import { createCancelToken } from '../lib/queue/token.mjs';

// JPEG SOF 维度读取：避免每帧多调一次 ffprobe。
export function jpegSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height };
    }
    offset += 2 + length;
  }
  return null;
}

export function createFrameService({ tasksRepo, framesRepo, logger, cancelTokens }) {
  // 取消令牌表由 app.mjs 统一持有并与分析服务共享：抽帧与分析都靠它中断 ffmpeg / HTTP。
  // 缺省给一个私有 Map，便于单测与冒烟脚本独立构造帧服务。
  const tokens = cancelTokens || new Map();
  const cfg = getConfig();

  function frameDirOf(taskId) {
    return path.join(cfg.framesDir, taskId);
  }

  async function list(taskId, { includeDuplicates = true } = {}) {
    const task = await tasksRepo.get(taskId);
    if (!task || task.deleted_at) throw notFound('任务不存在', { task_id: taskId });
    const frames = await framesRepo.listByTask(taskId, { includeDuplicates });
    return frames.map((f) => ({
      ...f,
      preview_url: `/frames/${taskId}/${f.file_name}`,
    }));
  }

  async function setEnabled(taskId, { frameIds, enabled }) {
    const task = await tasksRepo.get(taskId);
    if (!task || task.deleted_at) throw notFound('任务不存在', { task_id: taskId });
    const changes = await framesRepo.setEnabled(taskId, frameIds || [], Boolean(enabled));
    return { updated: changes };
  }

  async function runExtract(taskId, opts = {}) {
    const task = await tasksRepo.get(taskId);
    if (!task || task.deleted_at) throw notFound('任务不存在', { task_id: taskId });
    if (['extracting', 'analyzing'].includes(task.status)) {
      throw conflict('任务正在执行中，不能重复抽帧', { status: task.status });
    }
    const source = task.source_path || task.source_url;
    if (!source) throw conflict('任务缺少可用的输入源');

    const mode = ['interval', 'scene', 'both'].includes(opts.mode) ? opts.mode : task.extract_mode;
    const maxFrames = Math.min(60, Math.max(1, Number.parseInt(opts.max_frames, 10) || task.max_frames || cfg.extract.defaultMaxFrames));
    const intervalMs = Number.parseInt(opts.frame_interval_ms, 10) || cfg.extract.defaultIntervalMs;
    const sceneThreshold = Number.parseFloat(opts.scene_threshold) || task.scene_threshold || cfg.extract.defaultSceneThreshold;

    await tasksRepo.update(taskId, { status: 'extracting', phase: 'extracting', ffmpeg_error: null });
    const outDir = frameDirOf(taskId);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    await framesRepo.deleteByTask(taskId);

    // 注册本次抽帧的取消令牌：没有它，control{cancel} 只能改数据库状态，
    // ffmpeg 会继续跑完并把状态翻回 frames_ready——用户点了取消却拿到满帧。
    const token = createCancelToken();
    tokens.set(taskId, token);

    try {
      const meta = await probeMedia(cfg, source);
      const entries = await produceFrames(taskId, source, outDir, {
        mode,
        maxFrames,
        intervalMs,
        sceneThreshold,
        durationMs: meta.duration_ms,
        cancelToken: token,
      });

      // 抽帧过程本身被中断时 spawnBinary 会抛错，但为防竞态（取消恰好落在最后一帧之后），
      // 这里再判一次：已取消就不落库、不改 frames_ready，保持 cancelled。
      if (token.isCancelled) {
        // 取消就该什么都不留：ffmpeg 被杀时可能已写出半成品 JPEG，一并清除，
        // 否则帧目录里躺着用户从没确认过的残留文件（下次抽帧才会被覆盖）。
        fs.rmSync(outDir, { recursive: true, force: true });
        await tasksRepo.update(taskId, { status: 'cancelled', phase: 'cancelled', ffmpeg_error: '用户取消' });
        logger.info('frame', 'extract_cancelled', '抽帧被用户取消，丢弃已产出帧', { task_id: taskId, discarded: entries.length });
        return { frames: 0, mode, cancelled: true };
      }

      const rows = [];
      for (const entry of entries) {
        const buffer = fs.readFileSync(entry.filePath);
        const size = jpegSize(buffer);
        const dhash = await dhashOfFile(cfg, entry.filePath);
        rows.push({
          id: newFrameId(),
          task_id: taskId,
          seq: entry.seq,
          file_name: path.basename(entry.filePath),
          file_path: entry.filePath,
          url_path: `/frames/${taskId}/${path.basename(entry.filePath)}`,
          time_ms: entry.timeMs,
          width: size?.width ?? null,
          height: size?.height ?? null,
          dhash,
          dup_group: null,
          is_duplicate: 0,
          enabled: 1,
        });
      }
      await framesRepo.insertMany(rows);

      // 帧内去重：相邻帧汉明距离 ≤ 阈值归组，组内非首帧标记重复（默认仍启用，用户可关）。
      const threshold = cfg.hash.hammingThreshold;
      const assignments = groupByHamming(rows, threshold);
      await framesRepo.updateDupGroups(taskId, assignments);

      await tasksRepo.update(taskId, {
        status: 'frames_ready',
        phase: 'frames_ready',
        frames_done: rows.length,
        duration_ms: meta.duration_ms ?? task.duration_ms,
        width: meta.width ?? task.width,
        height: meta.height ?? task.height,
        codec: meta.codec ?? task.codec,
        extract_mode: mode,
        max_frames: maxFrames,
      });
      logger.info('frame', 'extracted', `抽帧完成：${rows.length} 帧（${mode}）`, { task_id: taskId, frames: rows.length });
      return { frames: rows.length, mode };
    } catch (err) {
      const message = String(err.stderr || err.message || err).slice(-2000);
      // 取消引发的中断不是失败：状态必须是 cancelled，否则用户看到「失败」却没做错任何事。
      if (token.isCancelled) {
        fs.rmSync(outDir, { recursive: true, force: true });
        await tasksRepo.update(taskId, { status: 'cancelled', phase: 'cancelled', ffmpeg_error: '用户取消' });
        logger.info('frame', 'extract_cancelled', '抽帧被用户取消，ffmpeg 已终止', { task_id: taskId });
        return { frames: 0, mode, cancelled: true };
      }
      await tasksRepo.update(taskId, { status: 'failed', phase: 'failed', ffmpeg_error: message });
      logger.error('frame', 'extract_failed', `抽帧失败：${err.message}`, { task_id: taskId });
      return { frames: 0, mode, error: message };
    } finally {
      if (tokens.get(taskId) === token) tokens.delete(taskId);
    }
  }

  // 同步执行版（供冒烟脚本与测试直接调用，不走 HTTP 队列）。
  async function extractNow(taskId, opts = {}) {
    return runExtract(taskId, opts);
  }

  async function produceFrames(taskId, source, outDir, { mode, maxFrames, intervalMs, sceneThreshold, durationMs, cancelToken }) {
    const entries = [];
    if (mode === 'interval') {
      const res = await extractInterval(cfg, {
        source,
        outDir,
        maxFrames,
        intervalMs,
        durationMs,
        width: cfg.extract.targetWidth,
        quality: cfg.extract.jpegQuality,
        cancelToken,
      });
      res.files.forEach((file, index) => {
        const seq = index + 1;
        const target = path.join(outDir, frameName(seq, file.timeMs));
        fs.renameSync(path.join(outDir, file.name), target);
        entries.push({ seq, timeMs: file.timeMs, filePath: target });
      });
      return entries;
    }

    let times = [];
    let strategy = mode;
    if (mode === 'scene') {
      times = (await detectScenes(cfg, { source, threshold: sceneThreshold, cancelToken })).slice(0, maxFrames);
    } else {
      const sceneTimes = await detectScenes(cfg, { source, threshold: sceneThreshold, cancelToken });
      times = mergeTimes(sceneTimes, durationMs || 0, maxFrames, intervalMs);
    }
    if (!times.length) {
      strategy = `${mode}_fallback_interval`;
      const res = await extractInterval(cfg, {
        source,
        outDir,
        maxFrames,
        intervalMs,
        durationMs,
        width: cfg.extract.targetWidth,
        quality: cfg.extract.jpegQuality,
        cancelToken,
      });
      res.files.forEach((file, index) => {
        const seq = index + 1;
        const target = path.join(outDir, frameName(seq, file.timeMs));
        fs.renameSync(path.join(outDir, file.name), target);
        entries.push({ seq, timeMs: file.timeMs, filePath: target });
      });
      logger.info('frame', 'strategy_fallback', `未检测到场景切换，回退固定间隔（${strategy}）`, { task_id: taskId });
      return entries;
    }

    let seq = 0;
    for (const timeMs of times) {
      seq += 1;
      const filePath = path.join(outDir, frameName(seq, timeMs));
      await extractAtTime(cfg, {
        source,
        output: filePath,
        timeMs,
        width: cfg.extract.targetWidth,
        quality: cfg.extract.jpegQuality,
        cancelToken,
      });
      entries.push({ seq, timeMs, filePath });
    }
    logger.info('frame', 'strategy', `抽帧策略：${strategy}`, { task_id: taskId, times: times.length });
    return entries;
  }

  return { list, setEnabled, runExtract, extractNow, frameDirOf };
}
