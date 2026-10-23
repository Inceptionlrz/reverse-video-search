// results 仓储：去重后的唯一来源线索。canonical_url 唯一，跨帧跨引擎合并。
import { canonicalizeUrl, domainOf } from '../../http/parse-html.mjs';
import { newResultId } from '../../ids.mjs';

export function rankToSortScore(rank) {
  if (!Number.isFinite(rank) || rank < 1) return null;
  return Math.max(20, 100 - (rank - 1) * 5);
}

const WRITABLE = ['url', 'title', 'provider', 'rank', 'score_basis', 'local_hash_similarity', 'sort_score', 'thumb_url', 'thumb_local_path', 'thumb_status'];

export function createResultsRepo(db) {
  return {
    async findByCanonical(canonicalUrl) {
      return db.get('SELECT * FROM results WHERE canonical_url = ?', [canonicalUrl]);
    },

    async upsert({ url, title, provider, rank }) {
      const canonical = canonicalizeUrl(url) || url;
      const existing = await this.findByCanonical(canonical);
      const score = rankToSortScore(rank);
      const now = Date.now();
      if (existing) {
        const nextRank = Number.isFinite(rank) && (existing.rank === null || rank < existing.rank) ? rank : existing.rank;
        const nextScore = rankToSortScore(nextRank);
        await db.run(
          `UPDATE results SET rank = ?, sort_score = ?, provider = COALESCE(?, provider),
           title = COALESCE(?, title), discovered_ms = discovered_ms WHERE id = ?`,
          [nextRank ?? null, nextScore ?? null, provider ?? null, title ?? null, existing.id],
        );
        return { id: existing.id, canonical_url: canonical, reused: true };
      }
      const id = newResultId();
      await db.run(
        `INSERT INTO results (id, url, canonical_url, domain, title, provider, rank, score_basis,
           local_hash_similarity, sort_score, thumb_url, thumb_local_path, thumb_status, discovered_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, url, canonical, domainOf(url), title ?? null, provider ?? null, rank ?? null,
          Number.isFinite(rank) ? 'engine_rank' : 'none', null, score ?? null, null, null, 'remote', now],
      );
      return { id, canonical_url: canonical, reused: false };
    },

    async update(id, patch) {
      const keys = Object.keys(patch).filter((k) => WRITABLE.includes(k));
      if (!keys.length) return 0;
      const sql = `UPDATE results SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      const res = await db.run(sql, [...keys.map((k) => patch[k] ?? null), id]);
      return res.changes;
    },

    async list({ q = null, domain = null, provider = null, minScore = null, taskIds = null, sort = 'sort_score', order = 'desc', limit = 20, offset = 0 } = {}) {
      const where = ['1 = 1'];
      const params = [];
      if (taskIds && taskIds.length) {
        where.push(`id IN (SELECT result_id FROM result_hits WHERE task_id IN (${taskIds.map(() => '?').join(', ')}))`);
        params.push(...taskIds);
      }
      if (q) {
        where.push('(title LIKE ? OR canonical_url LIKE ? OR domain LIKE ?)');
        const like = `%${String(q).replace(/%/g, '')}%`;
        params.push(like, like, like);
      }
      if (domain) {
        where.push('domain = ?');
        params.push(String(domain).toLowerCase());
      }
      if (provider) {
        where.push(`id IN (SELECT result_id FROM result_hits WHERE provider = ?)`);
        params.push(provider);
      }
      if (minScore !== null && minScore !== undefined && Number.isFinite(Number(minScore))) {
        where.push('COALESCE(sort_score, -1) >= ?');
        params.push(Number(minScore));
      }
      const sortCol = { sort_score: 'sort_score', local_hash_similarity: 'local_hash_similarity', hits: 'hit_count', discovered: 'discovered_ms' }[sort] || 'sort_score';
      const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      // 无分数项稳定沉底（SPEC 8.1）
      const orderBy = `CASE WHEN ${sortCol} IS NULL THEN 1 ELSE 0 END ASC, ${sortCol} ${dir}, discovered_ms DESC`;
      const clause = `WHERE ${where.join(' AND ')}`;
      const total = await db.get(`SELECT COUNT(*) AS n FROM results ${clause}`, params);
      const items = await db.all(
        `SELECT * FROM results ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)],
      );
      return { items, total: Number(total?.n || 0) };
    },

    async get(id) {
      return db.get('SELECT * FROM results WHERE id = ?', [id]);
    },

    async deleteOrphans() {
      const res = await db.run(
        'DELETE FROM results WHERE id NOT IN (SELECT result_id FROM result_hits)',
      );
      return res.changes;
    },
  };
}
