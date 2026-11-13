// 冒烟验证（方案 B）：插一条 document + chunk + 假向量 → vec0 KNN 查回来 → 打印 → 清理。
// 运行：项目根目录下 node scripts/smoke.mjs
import { randomUUID } from 'node:crypto';
import { EMBED_DIMS } from '../lib/embed.ts';
import { db, dbPath } from './db.mjs';

const FAKE_VALUE = 0.1;
const docId = randomUUID();
const fakeVector = new Float32Array(EMBED_DIMS).fill(FAKE_VALUE);

console.log(`db           = ${dbPath}`);
console.log(`vector dims  = ${EMBED_DIMS}`);

let chunkId = null;
let failure = null;

try {
  db.prepare(
    `insert into documents (id, title, storage_path, file_type, page_count, status, source_kind)
     values (?, ?, ?, ?, ?, ?, ?)`
  ).run(docId, 'smoke-document', 'data/smoke.pdf', 'pdf', 1, 'ready', 'upload');

  const chunkInfo = db
    .prepare(
      `insert into chunks (document_id, parent_index, content, full_context, heading_path,
                           page_from, page_to, chunk_index, token_count)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(docId, 0, 'smoke chunk content', 'smoke parent full context', '# smoke', 1, 1, 0, 3);
  // vec0 的整数主键只接受 BigInt 绑定，传 JS number 会报
  // "Only integers are allows for primary key values on vec_chunks"
  chunkId = BigInt(chunkInfo.lastInsertRowid);

  db.prepare('insert into vec_chunks (chunk_id, embedding, document_id) values (?, ?, ?)').run(
    chunkId,
    fakeVector,
    docId
  );

  const hits = db
    .prepare('select chunk_id, distance from vec_chunks where embedding match ? and k = ?')
    .all(fakeVector, 5);

  if (hits.length === 0) {
    throw new Error(`KNN 查询没命中任何向量：document=${docId} chunk=${chunkId}`);
  }

  const hit = hits[0];
  const chunk = db
    .prepare('select id, page_from, full_context from chunks where id = ?')
    .get(hit.chunk_id);

  if (!chunk) {
    throw new Error(`向量命中了 ${hit.chunk_id}，但 chunks 表里查不到这一行`);
  }

  const similarity = 1 - hit.distance;

  if (!Number.isFinite(similarity)) {
    throw new Error(`similarity 不是数字：${similarity}（distance=${hit.distance}）`);
  }

  console.log(`chunk id     = ${chunk.id}`);
  console.log(`page_from    = ${chunk.page_from}`);
  console.log(`similarity   = ${similarity}`);
  console.log(`full_context = ${chunk.full_context}`);
} catch (err) {
  failure = err;
} finally {
  // 删 document 应该靠外键级联带走 chunks，再靠触发器带走向量
  db.prepare('delete from documents where id = ?').run(docId);
}

const leftDocs = db.prepare('select count(*) as n from documents where id = ?').get(docId).n;
const leftChunks = db.prepare('select count(*) as n from chunks where document_id = ?').get(docId).n;
const leftVectors =
  chunkId === null
    ? 0
    : db.prepare('select count(*) as n from vec_chunks where chunk_id = ?').get(chunkId).n;

console.log(`leftover     = documents:${leftDocs} chunks:${leftChunks} vectors:${leftVectors}`);

if (leftDocs !== 0 || leftChunks !== 0 || leftVectors !== 0) {
  throw new Error(
    `删除 document 后仍有残留：documents=${leftDocs} chunks=${leftChunks} vectors=${leftVectors}（检查外键级联与 chunks_after_delete 触发器）`
  );
}

if (failure) throw failure;

console.log('smoke ok');
