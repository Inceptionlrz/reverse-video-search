// settings 仓储：单例键值表，值为 JSON 编码字符串。
export function createSettingsRepo(db) {
  return {
    async get(key) {
      const row = await db.get('SELECT * FROM settings WHERE key = ?', [key]);
      if (!row) return null;
      let value = row.value;
      try {
        value = JSON.parse(row.value);
      } catch {
        // 非 JSON 原样返回字符串
      }
      return { key: row.key, value };
    },

    async all() {
      const rows = await db.all('SELECT key, value FROM settings ORDER BY key ASC');
      const out = {};
      for (const row of rows) {
        try {
          out[row.key] = JSON.parse(row.value);
        } catch {
          out[row.key] = row.value;
        }
      }
      return out;
    },

    async set(key, value) {
      await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
        key,
        JSON.stringify(value),
      ]);
      return key;
    },

    async remove(key) {
      const res = await db.run('DELETE FROM settings WHERE key = ?', [key]);
      return res.changes;
    },
  };
}
