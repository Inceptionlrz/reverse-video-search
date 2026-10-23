// frames 仓储：帧 CRUD、去重分组回写、启用状态批量更新。
const WRITABLE = ['file_name', 'file_path', 'url_path', 'time_ms', 'width', 'height', 'dhash', 'dup_group', 'is_duplicate', 'enabled'];

export function createFramesRepo(db) {
  return {
    async insertMany(rows) {
      if (!rows.length) return 0;
      const cols = ['id', 'task_id', 'seq', 'file_name', 'file_path', 'url_path', 'time_ms', 'width', 'height', 'dhash', 'dup_group', 'is_duplicate', 'enabled'];
      const sql = `INSERT OR REPLACE INTO frames (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      let n = 0;
      await db.transaction(async (tx) => {
        for (const row of rows) {
          const res = await tx.run(sql, cols.map((c) => row[c] ?? null));
          n += res.changes;
        }
      });
      return n;
    },

    async listByTask(taskId, { enabledOnly = false, includeDuplicates = true } = {}) {
      const where = ['task_id = ?'];
      const params = [taskId];
      if (enabledOnly) where.push('enabled = 1');
      if (!includeDuplicates) where.push('is_duplicate = 0');
      return db.all(
        `SELECT * FROM frames WHERE ${where.join(' AND ')} ORDER BY seq ASC`,
        params,
      );
    },

    async get(id) {
      return db.get('SELECT * FROM frames WHERE id = ?', [id]);
    },

    async getByTaskAndSeq(taskId, seq) {
      return db.get('SELECT * FROM frames WHERE task_id = ? AND seq = ?', [taskId, seq]);
    },

    async setEnabled(taskId, frameIds, enabled) {
      const value = enabled ? 1 : 0;
      if (!frameIds || !frameIds.length) {
        const res = await db.run('UPDATE frames SET enabled = ? WHERE task_id = ?', [value, taskId]);
        return res.changes;
      }
      const marks = frameIds.map(() => '?').join(', ');
      const res = await db.run(
        `UPDATE frames SET enabled = ? WHERE task_id = ? AND id IN (${marks})`,
        [value, taskId, ...frameIds],
      );
      return res.changes;
    },

    async updateDupGroups(taskId, groups) {
      let n = 0;
      await db.transaction(async (tx) => {
        for (const g of groups) {
          const res = await tx.run('UPDATE frames SET dup_group = ?, is_duplicate = ? WHERE id = ?', [
            g.dup_group,
            g.is_duplicate ? 1 : 0,
            g.id,
          ]);
          n += res.changes;
        }
      });
      void taskId;
      return n;
    },

    async countByTask(taskId) {
      const row = await db.get('SELECT COUNT(*) AS n FROM frames WHERE task_id = ?', [taskId]);
      return Number(row?.n || 0);
    },

    async deleteByTask(taskId) {
      const res = await db.run('DELETE FROM frames WHERE task_id = ?', [taskId]);
      return res.changes;
    },

    async update(id, patch) {
      const keys = Object.keys(patch).filter((k) => WRITABLE.includes(k));
      if (!keys.length) return 0;
      const sql = `UPDATE frames SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      const res = await db.run(sql, [...keys.map((k) => patch[k] ?? null), id]);
      return res.changes;
    },
  };
}
