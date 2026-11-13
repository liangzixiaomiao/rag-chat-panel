import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/db';

interface DocumentRow {
  id: string;
  title: string;
  status: string;
  pageCount: number | null;
  error: string | null;
}

interface CountRow {
  n: number;
}

function logError(scope: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[api/documents] ${scope}\n${detail}`);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    const db = serverClient();
    const row = db
      .prepare('select id, title, status, page_count as pageCount, error from documents where id = ?')
      .get(id) as DocumentRow | undefined;

    if (row === undefined) return NextResponse.json({ error: '文档不存在' }, { status: 404 });

    const chunkCount = (db.prepare('select count(*) as n from chunks where document_id = ?').get(id) as CountRow).n;
    const embeddedCount = (db.prepare('select count(*) as n from vec_chunks where document_id = ?').get(id) as CountRow).n;

    return NextResponse.json({ ...row, chunkCount, embeddedCount });
  } catch (err) {
    logError(`读取文档失败：${id}`, err);
    return NextResponse.json({ error: '读取文档失败，请查看服务端日志' }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    // chunks 由外键级联删除，vec_chunks 由 chunks_after_delete 触发器清理
    const info = serverClient().prepare('delete from documents where id = ?').run(id);
    if (info.changes === 0) return NextResponse.json({ error: '文档不存在' }, { status: 404 });

    return NextResponse.json({ deleted: true, documentId: id });
  } catch (err) {
    logError(`删除文档失败：${id}`, err);
    return NextResponse.json({ error: '删除文档失败，请查看服务端日志' }, { status: 500 });
  }
}
