// 本地向量库（方案 B）：better-sqlite3 + sqlite-vec。
// 只在服务端 / 脚本里导入；better-sqlite3 是原生模块，禁止被客户端组件引入。
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';

// Next 16 + pnpm 下 Turbopack 会把原生模块改写成带哈希的外部模块名导致解析失败，
// 这里改成运行时 require（不走打包器的静态依赖图），按项目根目录解析 node_modules。
const runtimeRequire = createRequire(resolve(process.cwd(), 'package.json'));
const DatabaseCtor = runtimeRequire('better-sqlite3') as new (
  filename: string,
  options?: Database.Options
) => Database.Database;
const sqliteVec = runtimeRequire('sqlite-vec') as { load: (db: Database.Database) => void };

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
    const database = new DatabaseCtor(dbPath);
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
