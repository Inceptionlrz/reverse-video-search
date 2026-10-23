// result_hits 仓储：线索 × 证据（哪帧、哪个引擎、第几位命中）。
import { newHitId } from '../../ids.mjs';

export function createResultHitsRepo(db) {
  return {
    async insert({ resultId, analysisId, frameId, taskId, provider, rank, scoreBasis, localHashSimilarity, sortScore }) {
      const id = newHitId();
      await db.run(
        `INSERT OR REPLACE INTO result_hits (id, result_id, analysis_id, frame_id, task_id, provider,
           rank, score_basis, local_hash_similarity, sort_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, resultId, analysisId, frameId ?? null, taskId ?? null, provider ?? null, rank ?? null,
          scoreBasis ?? 'none', localHashSimilarity ?? null, sortScore ?? null],
      );
      return id;
    },

    async listByResult(resultId) {
      return db.all('SELECT * FROM result_hits WHERE result_id = ? ORDER BY rank ASC', [resultId]);
    },

    async listByAnalysis(analysisId) {
      return db.all('SELECT * FROM result_hits WHERE analysis_id = ? ORDER BY rank ASC', [analysisId]);
    },

    async countByResult(resultId) {
      const row = await db.get('SELECT COUNT(*) AS n FROM result_hits WHERE result_id = ?', [resultId]);
      return Number(row?.n || 0);
    },

    async deleteByAnalysis(analysisId) {
      const res = await db.run('DELETE FROM result_hits WHERE analysis_id = ?', [analysisId]);
      return res.changes;
    },

    async deleteByTask(taskId) {
      const res = await db.run('DELETE FROM result_hits WHERE task_id = ?', [taskId]);
      return res.changes;
    },

    async list({ taskId = null, provider = null, limit = 200, offset = 0 } = {}) {
      const where = ['1 = 1'];
      const params = [];
      if (taskId) {
        where.push('task_id = ?');
        params.push(taskId);
      }
      if (provider) {
        where.push('provider = ?');
        params.push(provider);
      }
      const clause = `WHERE ${where.join(' AND ')}`;
      const total = await db.get(`SELECT COUNT(*) AS n FROM result_hits ${clause}`, params);
      const items = await db.all(
        `SELECT * FROM result_hits ${clause} ORDER BY rank ASC LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)],
      );
      return { items, total: Number(total?.n || 0) };
    },
  };
}
