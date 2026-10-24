// analyses 仓储：帧 × 引擎的一次执行。重试采用"复位同一行"而非新增行（UNIQUE(frame_id, provider)）。
import { NON_RETRYABLE_STATUSES, RETRYABLE_ERROR_CODES } from '../../errors.mjs';

const WRITABLE = [
  'attempt_mode', 'hit_source', 'status', 'error_code', 'error_message',
  'request_url', 'http_status', 'latency_ms', 'started_ms', 'finished_ms',
  'degradation_log', 'manual_path', 'manual_url',
];

export function createAnalysesRepo(db) {
  return {
    async insert(row) {
      const cols = Object.keys(row);
      const sql = `INSERT OR REPLACE INTO analyses (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      await db.run(sql, cols.map((c) => row[c] ?? null));
      return row.id;
    },

    async get(id) {
      return db.get('SELECT * FROM analyses WHERE id = ?', [id]);
    },

    async findByFrameProvider(frameId, provider) {
      return db.get('SELECT * FROM analyses WHERE frame_id = ? AND provider = ?', [frameId, provider]);
    },

    async listByTask(taskId, { limit = 500 } = {}) {
      return db.all('SELECT * FROM analyses WHERE task_id = ? ORDER BY created_ms ASC LIMIT ?', [
        taskId,
        Number(limit),
      ]);
    },

    async listByStatus(statuses, { limit = 200 } = {}) {
      if (!statuses || !statuses.length) return [];
      const marks = statuses.map(() => '?').join(', ');
      return db.all(
        `SELECT * FROM analyses WHERE status IN (${marks}) ORDER BY created_ms ASC LIMIT ?`,
        [...statuses, Number(limit)],
      );
    },

    async update(id, patch) {
      const keys = Object.keys(patch).filter((k) => WRITABLE.includes(k));
      if (!keys.length) return 0;
      const sql = `UPDATE analyses SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      const res = await db.run(sql, [...keys.map((k) => patch[k] ?? null), id]);
      return res.changes;
    },

    // 复位为 queued：执行层重试的唯一入口。命中/零命中/手工态被 SQL 层排除。
    async resetForRetry(taskId, ids) {
      const marks = ids.map(() => '?').join(', ');
      const codes = RETRYABLE_ERROR_CODES.map(() => '?').join(', ');
      const nonStatus = NON_RETRYABLE_STATUSES.map(() => '?').join(', ');
      const res = await db.run(
        `UPDATE analyses SET status = 'queued', error_code = NULL, error_message = NULL,
         attempt_mode = NULL, hit_source = NULL, started_ms = NULL, finished_ms = NULL,
         degradation_log = NULL, http_status = NULL, latency_ms = NULL
         WHERE task_id = ? AND id IN (${marks})
           AND status NOT IN (${nonStatus})
           AND error_code IN (${codes})`,
        [taskId, ...ids, ...NON_RETRYABLE_STATUSES, ...RETRYABLE_ERROR_CODES],
      );
      return res.changes;
    },

    // 执行层筛选可重试项：命中/零命中/手工态/运行中一律排除。
    async selectRetryable(taskId) {
      const codes = RETRYABLE_ERROR_CODES.map(() => '?').join(', ');
      return db.all(
        `SELECT * FROM analyses WHERE task_id = ?
           AND status NOT IN ('succeeded', 'zero_result', 'manual', 'running', 'queued')
           AND error_code IN (${codes})
         ORDER BY created_ms ASC`,
        [taskId, ...RETRYABLE_ERROR_CODES],
      );
    },

    async countByTask(taskId) {
      const row = await db.get('SELECT COUNT(*) AS n FROM analyses WHERE task_id = ?', [taskId]);
      return Number(row?.n || 0);
    },

    async countDoneByTask(taskId) {
      const row = await db.get(
        `SELECT COUNT(*) AS n FROM analyses WHERE task_id = ?
           AND status IN ('succeeded', 'zero_result', 'manual', 'failed', 'cancelled')`,
        [taskId],
      );
      return Number(row?.n || 0);
    },

    async countPendingByTask(taskId) {
      const row = await db.get(
        `SELECT COUNT(*) AS n FROM analyses WHERE task_id = ? AND status IN ('queued', 'running')`,
        [taskId],
      );
      return Number(row?.n || 0);
    },

    async deleteByTask(taskId) {
      const res = await db.run('DELETE FROM analyses WHERE task_id = ?', [taskId]);
      return res.changes;
    },
  };
}
