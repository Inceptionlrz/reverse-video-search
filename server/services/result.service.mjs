// 结果服务：去重（跨帧跨引擎按 canonical_url 合并）、排序键、证据链、缩略图本地哈希（可选）。
// 分数双轨：sort_score（排序分，引擎名次映射）+ local_hash_similarity（本地实算）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from '../lib/config.mjs';
import { createResultHitsRepo } from '../lib/db/repo/result-hits.repo.mjs';
import { createResultsRepo, rankToSortScore } from '../lib/db/repo/results.repo.mjs';
import { dhashOfFile, hashSimilarity } from '../lib/media/hash.mjs';
import { request } from '../lib/http/request.mjs';

export function createResultService({ db, tasksRepo, framesRepo, logger, settingsService }) {
  const cfg = getConfig();
  const resultsRepo = createResultsRepo(db);
  const hitsRepo = createResultHitsRepo(db);

  // 把一次引擎命中的条目写入 results + result_hits。返回新增/复用计数。
  async function ingest({ analysis, frame, task, items }) {
    let created = 0;
    let reused = 0;
    for (const item of items) {
      const up = await resultsRepo.upsert({ url: item.url, title: item.title, provider: analysis.provider, rank: item.rank });
      if (up.reused) reused += 1;
      else created += 1;
      await hitsRepo.insert({
        resultId: up.id,
        analysisId: analysis.id,
        frameId: frame?.id ?? null,
        taskId: task?.id ?? null,
        provider: analysis.provider,
        rank: item.rank,
        scoreBasis: 'engine_rank',
        localHashSimilarity: null,
        sortScore: rankToSortScore(item.rank),
      });
    }
    logger.debug('result', 'ingested', `写入 ${items.length} 条命中（新增 ${created}，复用 ${reused}）`, {
      analysis_id: analysis.id,
    });
    return { created, reused };
  }

  // 可选：为结果计算本地哈希相似度（临时下载缩略图，不落盘；默认关闭）。
  async function computeThumbSimilarity(resultId) {
    const settings = await settingsService.load();
    if (!settings.similarity.compute_thumb_hash) return null;
    const result = await resultsRepo.get(resultId);
    if (!result || !result.thumb_url) return null;
    const hits = await hitsRepo.listByResult(resultId);
    if (!hits.length || !hits[0].frame_id) return null;
    const frame = await framesRepo.get(hits[0].frame_id);
    if (!frame?.dhash) return null;
    const res = await request(result.thumb_url, { config: cfg, proxy: cfg.proxy, maxBodyBytes: 2 * 1024 * 1024 });
    if (!res.ok) return null;
    const tmp = path.join(os.tmpdir(), `rvs-thumb-${resultId}.jpg`);
    try {
      fs.writeFileSync(tmp, Buffer.from(res.body, 'binary'));
      const dhash = await dhashOfFile(cfg, tmp);
      const sim = hashSimilarity(frame.dhash, dhash);
      await resultsRepo.update(resultId, { local_hash_similarity: sim });
      return sim;
    } catch {
      return null;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  async function list(query = {}) {
    const taskIds = query.task_id ? String(query.task_id).split(',').filter(Boolean) : null;
    const { items, total } = await resultsRepo.list({
      q: query.q || null,
      domain: query.domain || null,
      provider: query.provider || null,
      minScore: query.min_score !== undefined ? Number(query.min_score) : null,
      taskIds,
      sort: query.sort || 'sort_score',
      order: query.order || 'desc',
      limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20)),
      offset: Math.max(0, Number.parseInt(query.offset, 10) || 0),
    });
    const enriched = [];
    for (const item of items) {
      const hits = await hitsRepo.listByResult(item.id);
      enriched.push({
        ...item,
        hit_count: hits.length,
        hits: hits.map((h) => ({
          frame_id: h.frame_id,
          provider: h.provider,
          rank: h.rank,
          score_basis: h.score_basis,
          local_hash_similarity: h.local_hash_similarity,
        })),
        similarity_note: item.local_hash_similarity === null ? '未提供（引擎不返回真实相似度；可在设置中开启缩略图本地哈希）' : null,
      });
    }
    return { items: enriched, total };
  }

  async function detail(resultId) {
    const result = await resultsRepo.get(resultId);
    if (!result) return null;
    const hits = await hitsRepo.listByResult(resultId);
    const frames = [];
    for (const hit of hits) {
      if (!hit.frame_id) continue;
      const frame = await framesRepo.get(hit.frame_id);
      if (frame) frames.push({ ...frame, preview_url: `/frames/${frame.task_id}/${frame.file_name}` });
    }
    return { ...result, hits, frames };
  }

  async function removeByTask(taskId) {
    const hits = await hitsRepo.list({ taskId, limit: 10000 });
    for (const hit of hits) await hitsRepo.deleteByAnalysis(hit.analysis_id);
    await resultsRepo.deleteOrphans();
    void taskId;
  }

  return { ingest, list, detail, computeThumbSimilarity, removeByTask, repos: { results: resultsRepo, hits: hitsRepo } };
}
