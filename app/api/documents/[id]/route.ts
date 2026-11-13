import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/db';

interface DocumentRow {
  id: string;
  title: string;
  status: string;
  pageCount: number | null;
  error: string | null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;

  try {
    const row = serverClient()
      .prepare('select id, title, status, page_count as pageCount, error from documents where id = ?')
      .get(id) as DocumentRow | undefined;

    if (!row) return NextResponse.json({ error: '文档不存在' }, { status: 404 });
    return NextResponse.json(row);
  } catch (err) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[api/documents] 读取文档失败：${id}\n${detail}`);
    return NextResponse.json({ error: '读取文档失败，请查看服务端日志' }, { status: 500 });
  }
}
