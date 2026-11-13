// 仅脚本可用：把切好的父块/子块写进本地库，不在 app 里调用。
import { serverClient } from './db.ts';
import { embedTexts } from './embed.ts';
import type { ParentChunk } from './types.ts';

export interface IngestResult {
  inserted: number;
  skipped: number;
  /** 库里已处理到的最大 chunkIndex，重跑时据此续传；没有数据为 -1 */
  lastChunkIndex: number;
}

interface PendingItem {
  parent: ParentChunk;
  content: string;
  pageFrom: number;
  pageTo: number;
  chunkIndex: number;
  tokenCount: number;
}

/**
 * 批量 embedding 后写库，按 (document_id, parent_index, chunk_index) 幂等：
 * 已存在的跳过，因此重跑天然从断点继续。
 */
export async function ingestChunks(documentId: string, parents: ParentChunk[]): Promise<IngestResult> {
  const db = serverClient();

  const existing = new Set(
    (
      db.prepare('select parent_index, chunk_index from chunks where document_id = ?').all(documentId) as Array<{
        parent_index: number;
        chunk_index: number;
      }>
    ).map((row) => `${row.parent_index}:${row.chunk_index}`)
  );

  const pending: PendingItem[] = [];
  let skipped = 0;

  for (const parent of parents) {
    for (const child of parent.children) {
      if (existing.has(`${parent.parentIndex}:${child.chunkIndex}`)) {
        skipped += 1;
        continue;
      }
      pending.push({
        parent,
        content: child.content,
        pageFrom: child.pageFrom,
        pageTo: child.pageTo,
        chunkIndex: child.chunkIndex,
        tokenCount: child.tokenCount,
      });
    }
  }

  if (pending.length > 0) {
    const vectors = await embedTexts(pending.map((item) => item.content));

    const insertChunk = db.prepare(
      `insert into chunks (document_id, parent_index, content, full_context, heading_path,
                           page_from, page_to, chunk_index, token_count)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertVector = db.prepare('insert into vec_chunks (chunk_id, embedding, document_id) values (?, ?, ?)');

    const write = db.transaction((items: PendingItem[]) => {
      items.forEach((item, index) => {
        const info = insertChunk.run(
          documentId,
          item.parent.parentIndex,
          item.content,
          item.parent.fullContext,
          item.parent.headingPath,
          item.pageFrom,
          item.pageTo,
          item.chunkIndex,
          item.tokenCount
        );
        insertVector.run(BigInt(info.lastInsertRowid), new Float32Array(vectors[index]), documentId);
      });
    });

    write(pending);
  }

  const last = db.prepare('select max(chunk_index) as last from chunks where document_id = ?').get(documentId) as {
    last: number | null;
  };

  return {
    inserted: pending.length,
    skipped,
    lastChunkIndex: last.last ?? -1,
  };
}
