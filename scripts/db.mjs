// 本地向量库（方案 B）的唯一入口：建表 + 加载 sqlite-vec + 导出 db 单例。
// 表结构只在脚本里执行，应用启动时不建表。
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { EMBED_DIMS } from '../lib/embed.ts';

const DEFAULT_DB_PATH = 'out/kb.sqlite';

export const dbPath = resolve(process.env.SQLITE_DB_PATH ?? DEFAULT_DB_PATH);

// 维度只来自 lib/embed.ts 的 EMBED_DIMS，这里不接受别的来源
const SCHEMA = `
create table if not exists documents (
  id           text primary key,
  title        text not null,
  storage_path text not null,
  file_type    text not null,
  page_count   integer,
  status       text not null default 'pending',
  error        text,
  content_hash text,
  source_kind  text default 'upload',
  created_at   text default (datetime('now'))
);

create table if not exists chunks (
  id           integer primary key autoincrement,
  document_id  text not null references documents(id) on delete cascade,
  parent_index integer not null,
  content      text not null,
  full_context text not null,
  heading_path text,
  page_from    integer,
  page_to      integer,
  chunk_index  integer,
  token_count  integer
);

create table if not exists messages (
  id              integer primary key autoincrement,
  conversation_id text not null,
  role            text not null,
  content         text not null,
  citations       text,
  created_at      text default (datetime('now'))
);

create virtual table if not exists vec_chunks using vec0(
  chunk_id    integer primary key,
  embedding   float[${EMBED_DIMS}] distance_metric=cosine,
  document_id text partition key
);

create trigger if not exists chunks_after_delete
after delete on chunks
begin
  delete from vec_chunks where chunk_id = old.id;
end;
`;

let database;

try {
  mkdirSync(dirname(dbPath), { recursive: true });
  database = new Database(dbPath);
  database.pragma('foreign_keys = ON');
  sqliteVec.load(database);
  database.exec(SCHEMA);
} catch (err) {
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  throw new Error(`初始化本地向量库失败：${dbPath}\n${stack}`, { cause: err });
}

export const db = database;
