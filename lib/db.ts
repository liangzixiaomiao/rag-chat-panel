// 本地向量库（方案 B）：better-sqlite3 + sqlite-vec。
// 只在服务端 / 脚本里导入；better-sqlite3 是原生模块，禁止被客户端组件引入。
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DEFAULT_DB_PATH = 'out/kb.sqlite';

let client: Database.Database | null = null;

/**
 * 打开（首次调用时）并返回本地 SQLite 单例。
 * 只负责连接与加载 sqlite-vec 扩展，不建表：表结构统一由 scripts/db.mjs 维护。
 */
export function serverClient(): Database.Database {
  if (client) return client;

  const dbPath = resolve(process.env.SQLITE_DB_PATH ?? DEFAULT_DB_PATH);

  try {
    const database = new Database(dbPath);
    // 外键级联删除依赖这个 pragma，关掉的话删 documents 不会带走 chunks
    database.pragma('foreign_keys = ON');
    sqliteVec.load(database);
    client = database;
    return database;
  } catch (err) {
    const stack = err instanceof Error ? err.stack ?? err.message : String(err);
    throw new Error(`打开本地向量库失败：${dbPath}\n${stack}`, { cause: err });
  }
}
