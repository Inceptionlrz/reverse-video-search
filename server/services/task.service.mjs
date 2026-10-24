// 任务服务：建任务（本地文件 / 本地路径 / 远程 URL）、预检、查询、重命名、删除清理。
// 远程 URL 只做轻量探测（Content-Type），不实现下载器；抽帧交给 ffmpeg 自行处理。
import fs from 'node:fs';
import path from 'node:path';
import { newTaskId } from '../lib/ids.mjs';
import { getConfig } from '../lib/config.mjs';
import { badRequest, mediaError, notFound } from '../lib/errors.mjs';
import { probeMedia } from '../lib/media/probe.mjs';
import { request } from '../lib/http/request.mjs';

const COMMON_CODECS = new Set(['h264', 'hevc', 'h265', 'vp8', 'vp9', 'av1', 'mpeg4', 'vp09', 'av01']);

function now() {
  return Date.now();
}

function isPrivateHost(hostname) {
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost|0\.0\.0\.0|\[?::1\]?$)/i.test(hostname)) return true;
  return false;
}

// 抽帧方案预估与告警（PRD：plan.warnings）。
export function buildPlan(meta, extract, sourceUrl) {
  const warnings = [];
  const durationMs = meta?.duration_ms ?? null;
  const maxFrames = extract.max_frames;
  let estimated = maxFrames;
  if (extract.mode === 'interval') {
    estimated = durationMs ? Math.min(maxFrames, Math.floor(durationMs / extract.interval_ms) + 1) : maxFrames;
    if (durationMs && Math.floor(durationMs / extract.interval_ms) + 1 > maxFrames) warnings.push('duration_too_long');
  } else {
    estimated = durationMs ? Math.min(maxFrames, Math.max(1, Math.floor(durationMs / 3000))) : maxFrames;
  }
  if (meta?.width && meta.width < 240) warnings.push('low_resolution');
  if (meta?.codec && !COMMON_CODECS.has(String(meta.codec).toLowerCase())) warnings.push('codec_unusual');
  if (sourceUrl && isPrivateHost(new URL(sourceUrl).hostname)) warnings.push('remote_url_not_public');
  return { estimated_frames: estimated, strategy: `${extract.mode}_plan`, warnings };
}

export function createTaskService({ tasksRepo, framesRepo, analysesRepo, resultHitsRepo, resultsRepo, settingsRepo, logger }) {
  const cfg = getConfig();

  async function assertTask(id) {
    const task = await tasksRepo.get(id);
    if (!task || task.deleted_at) throw notFound('任务不存在', { task_id: id });
    return task;
  }

  async function create(input) {
    const sourceType = input.source_type === 'url' ? 'url' : 'file';
    const sourcePath = sourceType === 'file' ? input.source_path : null;
    const sourceUrl = sourceType === 'url' ? input.source_url : null;
    if (sourceType === 'file' && !sourcePath) throw badRequest('本地文件任务必须提供 source_path');
    if (sourceType === 'url' && !sourceUrl) throw badRequest('URL 任务必须提供 source_url');

    const extract = {
      mode: ['interval', 'scene', 'both'].includes(input.extract_mode) ? input.extract_mode : cfg.extract.defaultMode,
      max_frames: Math.min(60, Math.max(1, Number.parseInt(input.max_frames, 10) || cfg.extract.defaultMaxFrames)),
      interval_ms: Number.parseInt(input.frame_interval_ms, 10) || cfg.extract.defaultIntervalMs,
      scene_threshold: Number.parseFloat(input.scene_threshold) || cfg.extract.defaultSceneThreshold,
    };
    const displayName = input.display_name || (sourceType === 'file' ? path.basename(sourcePath) : sourceUrl);

    const id = newTaskId();
    const row = {
      id,
      created_at: now(),
      source_type: sourceType,
      source_name: sourceType === 'file' ? path.basename(sourcePath) : sourceUrl,
      display_name: displayName,
      source_path: sourcePath,
      source_url: sourceUrl,
      status: 'created',
      phase: 'created',
      extract_mode: extract.mode,
      max_frames: extract.max_frames,
      scene_threshold: extract.scene_threshold,
      created_ms: now(),
      updated_ms: now(),
    };
    await tasksRepo.insert(row);

    // 预检：ffprobe（本地路径或 ffmpeg 可直连的 URL）。
    let meta = null;
    let mediaFailed = null;
    try {
      meta = await probeMedia(cfg, sourcePath || sourceUrl);
    } catch (err) {
      mediaFailed = err;
      logger.warn('task', 'probe_failed', `预检失败：${err.message}`, { task_id: id });
    }

    const patch = { phase: 'probed' };
    if (meta) {
      patch.duration_ms = meta.duration_ms;
      patch.width = meta.width;
      patch.height = meta.height;
      patch.codec = meta.codec;
    }
    if (mediaFailed && sourceType === 'file') {
      patch.status = 'failed';
      patch.ffmpeg_error = String(mediaFailed.stderr || mediaFailed.message).slice(-2000);
      await tasksRepo.update(id, patch);
      const task = await assertTask(id);
      return { task, plan: null, error: mediaError('无法解析该文件（可能不是视频或已损坏）', { ffmpeg: tail(mediaFailed.stderr) }) };
    }
    patch.status = 'ready';
    await tasksRepo.update(id, patch);

    const task = await assertTask(id);
    const plan = buildPlan(meta, extract, sourceUrl);
    logger.info('task', 'created', `任务已创建：${displayName}`, { task_id: id, source_type: sourceType });
    return { task, plan, error: null };
  }

  async function get(id) {
    const task = await assertTask(id);
    const framesDone = await framesRepo.countByTask(id);
    const analysesDone = await analysesRepo.countDoneByTask(id);
    const analysesTotal = await analysesRepo.countByTask(id);
    return {
      ...task,
      frames_done: framesDone,
      analyses_done: analysesDone,
      analyses_total: analysesTotal,
      poll_interval_ms: task.status === 'analyzing' || task.status === 'extracting' ? 1000 : 3000,
    };
  }

  async function list(query = {}) {
    const { items, total } = await tasksRepo.list({
      status: query.status || null,
      q: query.q || null,
      limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20)),
      offset: Math.max(0, Number.parseInt(query.offset, 10) || 0),
    });
    const enriched = [];
    for (const item of items) {
      enriched.push({
        ...item,
        frames_done: await framesRepo.countByTask(item.id),
        analyses_done: await analysesRepo.countDoneByTask(item.id),
        analyses_total: await analysesRepo.countByTask(item.id),
      });
    }
    return { items: enriched, total };
  }

  async function rename(id, displayName) {
    await assertTask(id);
    const name = String(displayName || '').trim();
    if (!name) throw badRequest('显示名称不能为空');
    if (name.length > 120) throw badRequest('显示名称过长（≤ 120 字符）');
    await tasksRepo.update(id, { display_name: name });
    return assertTask(id);
  }

  // 删除：软删除任务行，并清理自产帧文件、分析、命中与孤儿结果。
  async function remove(id) {
    const task = await assertTask(id);
    const frames = await framesRepo.listByTask(id, {});
    for (const frame of frames) {
      if (frame.file_path) {
        try {
          fs.rmSync(frame.file_path, { force: true });
        } catch {
          // 单帧文件删除失败不阻塞任务删除
        }
      }
    }
    const frameDir = path.join(cfg.framesDir, id);
    try {
      fs.rmSync(frameDir, { recursive: true, force: true });
    } catch {
      // 目录不存在或删除失败均忽略
    }
    // EARS #20：删除任务时清理本应用生成的帧、结果、导出临时文件和日志索引。
    // 上传的源视频副本（data/uploads/u_*/…）同样在此清理：抽帧完成后它不再被引用
    // （无重新抽帧入口），用户的原始文件也不在本目录，留着即永久泄漏整段视频。
    // ⚠️ 仅删 uploads 暂存区内的文件：JSON 建任务时 source_path 指向用户磁盘原文件，
    // 删那个等于删用户的源视频，边界必须按路径前缀判定，不能凭 source_path 非空就删。
    if (task.source_path) {
      const uploadsRoot = path.join(cfg.dataDir, 'uploads') + path.sep;
      if (path.resolve(task.source_path).startsWith(uploadsRoot)) {
        try {
          const stagingDir = path.dirname(task.source_path);
          fs.rmSync(task.source_path, { force: true });
          // 暂存目录非递归移除：仅当已空才成功，误遇共享目录时不伤他人文件
          try { fs.rmdirSync(stagingDir); } catch { /* 非空或不存在即保留 */ }
        } catch {
          // 源文件删除失败不阻塞任务删除
        }
      }
    }
    await resultHitsRepo.deleteByTask(id);
    await analysesRepo.deleteByTask(id);
    await framesRepo.deleteByTask(id);
    await resultsRepo.deleteOrphans();
    await settingsRepo.remove(`consent:${id}`);
    await tasksRepo.softDelete(id);
    logger.info('task', 'deleted', `任务已删除：${task.display_name || id}`, { task_id: id });
    return { id, deleted: true };
  }

  async function setStatus(id, patch) {
    await assertTask(id);
    await tasksRepo.update(id, patch);
    return assertTask(id);
  }

  return { create, get, list, rename, remove, setStatus, assertTask, buildPlan, isPrivateHost };
}

function tail(text, n = 800) {
  const s = String(text || '');
  return s.length > n ? s.slice(-n) : s;
}
