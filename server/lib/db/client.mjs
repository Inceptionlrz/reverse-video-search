// node:sqlite 连接包装。仓储层只经由此处访问数据库，Database 实例不向上泄漏。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Db {
  constructor(dbPath) {
    this.path = dbPath;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
  }

  exec(sql) {
    this.db.exec(sql);
    return this;
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  // 以下三个方法是仓储层唯一允许使用的入口，全部为异步签名。
  async run(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const info = stmt.run(...params);
    return { changes: Number(info.changes ?? 0), lastInsertRowid: info.lastInsertRowid ?? null };
  }

  async get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params) ?? null;
  }

  async all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) ?? [];
  }

  async transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 回滚失败时保留原始异常
      }
      throw err;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      // 关闭失败不抛
    }
  }
}

export function openDb(dbPath) {
  return new Db(dbPath);
}
