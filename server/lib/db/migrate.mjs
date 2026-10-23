// 幂等迁移：版本号登记在 _migrations，重复执行不产生副作用。
// schema.sql 以 fs 读取，保持其为纯 SQL 文件（不参与 ESM import 图）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, 'schema.sql');

export function readSchema() {
  return fs.readFileSync(SCHEMA_PATH, 'utf8');
}

const MIGRATIONS = [{ version: 1, name: 'init_core_tables', file: 'schema.sql' }];

export async function migrate(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = await db.all('SELECT version FROM _migrations');
  const done = new Set(applied.map((r) => Number(r.version)));
  const log = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    const sql = readSchema();
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.run('INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        Date.now(),
      ]);
    });
    log.push({ version: m.version, name: m.name });
  }
  return log;
}

export { MIGRATIONS, SCHEMA_PATH };
