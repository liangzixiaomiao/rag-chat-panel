import { NextResponse } from 'next/server';
import { chunkText } from '@/lib/chunk';
import { serverClient } from '@/lib/db';
import { embedTexts } from '@/lib/embed';
import { parseDocx } from '@/lib/parse/docx';
import { parsePdf } from '@/lib/parse/pdf';
import { parseText } from '@/lib/parse/text';
import type { Paragraph } from '@/lib/types';

const BATCH_SIZE = 100;
const MAX_ERROR_CHARS = 500;
const STATUS_ORDER = ['pending', 'parsing', 'chunking', 'embedding', 'ready'] as const;

type DocStatus = (typeof STATUS_ORDER)[number];

interface DocumentRow {
  id: string;
  storage_path: string;
  file_type: string;
  status: string;
  error: string | null;
}

interface ChunkRow {
  id: number;
  content: string;
}

interface CountRow {
  n: number;
}

function logError(scope: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[api/ingest] ${scope}\n${detail}`);
}

function failDocument(documentId: string, err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.includes('NO_TEXT_LAYER')
    ? '这份 PDF 没有文本层，需要 OCR（暂不支持）'
    : raw.slice(0, MAX_ERROR_CHARS);
  serverClient().prepare("update documents set status = 'failed', error = ? where id = ?").run(message, documentId);
  return message;
}

/** 只允许前进，或从 failed 重新进入；不允许 embedding → pending 这类回退。 */
function advanceStatus(documentId: string, current: string, next: DocStatus): void {
  if (current === next) return;

  const from = STATUS_ORDER.indexOf(current as DocStatus);
  const to = STATUS_ORDER.indexOf(next);
  const allowed = current === 'failed' ? true : to > from;

  if (!allowed) throw new Error(`非法状态流转：${current} → ${next}`);

  serverClient().prepare('update documents set status = ?, error = null where id = ?').run(next, documentId);
}

async function parseDocument(storagePath: string, fileType: string): Promise<Paragraph[]> {
  if (fileType === 'pdf') return parsePdf(storagePath);
  if (fileType === 'docx') return parseDocx(storagePath);
  if (fileType === 'md' || fileType === 'txt') return parseText(storagePath);
  throw new Error(`不支持的文件类型：${fileType}`);
}

/** 解析 + 切块 + 落 chunks（不含向量），只在文档还没有任何 chunk 时执行。 */
async function stageChunks(documentId: string, doc: DocumentRow): Promise<void> {
  advanceStatus(documentId, doc.status, 'parsing');

  const paragraphs = await parseDocument(doc.storage_path, doc.file_type);
  advanceStatus(documentId, 'parsing', 'chunking');

  const parents = chunkText(paragraphs);
  const db = serverClient();

  const insertChunk = db.prepare(
    `insert into chunks (document_id, parent_index, content, full_context, heading_path,
                         page_from, page_to, chunk_index, token_count)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const write = db.transaction(() => {
    for (const parent of parents) {
      for (const child of parent.children) {
        insertChunk.run(
          documentId,
          parent.parentIndex,
          child.content,
          parent.fullContext,
          parent.headingPath,
          child.pageFrom,
          child.pageTo,
          child.chunkIndex,
          child.tokenCount
        );
      }
    }
  });

  write();

  const maxPage = paragraphs.reduce((max, paragraph) => (paragraph.page === null ? max : Math.max(max, paragraph.page)), 0);
  if (maxPage > 0) {
    db.prepare('update documents set page_count = ? where id = ?').run(maxPage, documentId);
  }
}

/** 取 100 条还没有向量的 chunk，embed 后写入 vec_chunks。 */
async function embedBatch(documentId: string): Promise<number> {
  const db = serverClient();
  const rows = db
    .prepare(
      `select c.id, c.content from chunks c
       where c.document_id = ?
         and not exists (select 1 from vec_chunks v where v.chunk_id = c.id)
       order by c.id
       limit ?`
    )
    .all(documentId, BATCH_SIZE) as ChunkRow[];

  if (rows.length === 0) return 0;

  const vectors = await embedTexts(rows.map((row) => row.content));
  const insertVector = db.prepare('insert into vec_chunks (chunk_id, embedding, document_id) values (?, ?, ?)');

  const write = db.transaction(() => {
    rows.forEach((row, index) => {
      insertVector.run(BigInt(row.id), new Float32Array(vectors[index]), documentId);
    });
  });

  write();
  return rows.length;
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    documentId?: unknown;
    cursor?: unknown;
  };

  if (typeof record.documentId !== 'string' || record.documentId.trim() === '') {
    return NextResponse.json({ error: '缺少 documentId' }, { status: 400 });
  }

  const documentId = record.documentId;
  const cursor = typeof record.cursor === 'number' && Number.isFinite(record.cursor) ? record.cursor : 0;

  const db = serverClient();
  const doc = db
    .prepare('select id, storage_path, file_type, status, error from documents where id = ?')
    .get(documentId) as DocumentRow | undefined;

  if (doc === undefined) {
    return NextResponse.json({ error: '文档不存在' }, { status: 404 });
  }

  const countChunks = (): number =>
    (db.prepare('select count(*) as n from chunks where document_id = ?').get(documentId) as CountRow).n;

  const total = countChunks();

  if (doc.status === 'ready') {
    return NextResponse.json({ nextCursor: total, done: true, total });
  }

  if (cursor > total) {
    return NextResponse.json({ nextCursor: total, done: true, total });
  }

  try {
    if (total === 0) {
      await stageChunks(documentId, doc);
    }

    const currentStatus = (
      db.prepare('select status from documents where id = ?').get(documentId) as { status: string }
    ).status;
    advanceStatus(documentId, currentStatus, 'embedding');
    await embedBatch(documentId);

    const chunkTotal = countChunks();
    const nextCursor = Number(
      (db.prepare('select count(*) as n from vec_chunks where document_id = ?').get(documentId) as CountRow).n
    );
    const done = nextCursor >= chunkTotal;

    if (done) {
      db.prepare('update documents set status = ? where id = ?').run('ready', documentId);
    }

    return NextResponse.json({ nextCursor, done, total: chunkTotal });
  } catch (err) {
    logError(`入库失败：${documentId}`, err);
    const message = failDocument(documentId, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
