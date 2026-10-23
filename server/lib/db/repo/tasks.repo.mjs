// tasks 仓储：只暴露异步方法签名，SQL 与 Database 实例不向上泄漏。
const WRITABLE = [
  'source_type', 'source_name', 'display_name', 'source_path', 'source_url',
  'status', 'phase', 'duration_ms', 'width', 'height', 'codec', 'extract_mode',
  'max_frames', 'scene_threshold', 'ffmpeg_error', 'created_ms', 'updated_ms',
  'frames_done', 'analyses_done', 'analyses_total', 'confirmed', 'deleted_at',
];

export function createTasksRepo(db) {
  return {
    async insert(row) {
      const cols = Object.keys(row);
      const sql = `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      await db.run(sql, cols.map((c) => row[c] ?? null));
      return row.id;
    },

    async get(id) {
      return db.get('SELECT * FROM tasks WHERE id = ?', [id]);
    },

    async list({ status = null, q = null, limit = 50, offset = 0 } = {}) {
      const where = ["deleted_at IS NULL"];
      const params = [];
      if (status) {
        const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
        if (list.length) {
          where.push(`status IN (${list.map(() => '?').join(', ')})`);
          params.push(...list);
        }
      }
      if (q) {
        where.push('(display_name LIKE ? OR source_name LIKE ? OR source_path LIKE ?)');
        const like = `%${String(q).replace(/%/g, '')}%`;
        params.push(like, like, like);
      }
      const clause = `WHERE ${where.join(' AND ')}`;
      const total = await db.get(`SELECT COUNT(*) AS n FROM tasks ${clause}`, params);
      const items = await db.all(
        `SELECT * FROM tasks ${clause} ORDER BY updated_ms DESC LIMIT ? OFFSET ?`,
        [...params, Number(limit), Number(offset)],
      );
      return { items, total: Number(total?.n || 0) };
    },

    async update(id, patch) {
      const keys = Object.keys(patch).filter((k) => WRITABLE.includes(k));
      if (!keys.length) return 0;
      patch.updated_ms = patch.updated_ms ?? Date.now();
      if (!keys.includes('updated_ms')) keys.push('updated_ms');
      const sql = `UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      const res = await db.run(sql, [...keys.map((k) => patch[k] ?? null), id]);
      return res.changes;
    },

    async setConfirmed(id, value = 1) {
      const res = await db.run('UPDATE tasks SET confirmed = ?, updated_ms = ? WHERE id = ?', [
        value ? 1 : 0,
        Date.now(),
        id,
      ]);
      return res.changes;
    },

    async remove(id) {
      const res = await db.run('DELETE FROM tasks WHERE id = ?', [id]);
      return res.changes;
    },

    async softDelete(id) {
      const res = await db.run('UPDATE tasks SET deleted_at = ?, updated_ms = ? WHERE id = ?', [
        Date.now(),
        Date.now(),
        id,
      ]);
      return res.changes;
    },
  };
}
