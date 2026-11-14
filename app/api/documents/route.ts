import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/db';

interface DocumentListRow {
  id: string;
  title: string;
  status: string;
  pageCount: number | null;
  fileType: string;
  error: string | null;
  createdAt: string;
  chunkCount: number;
  embeddedCount: number;
}

function logError(scope: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[api/documents] ${scope}\n${detail}`);
}

/** 列出所有通过上传入库的文档，供首页展示与进入提问。 */
export async function GET(): Promise<NextResponse> {
  try {
    const rows = serverClient()
      .prepare(
        `select d.id,
                d.title,
                d.status,
                d.page_count as pageCount,
                d.file_type as fileType,
                d.error,
                coalesce(d.created_at, '') as createdAt,
                (select count(*) from chunks c where c.document_id = d.id) as chunkCount,
                (select count(*) from vec_chunks v where v.document_id = d.id) as embeddedCount
           from documents d
          where coalesce(d.source_kind, 'upload') = 'upload'
            and d.content_hash is not null
          order by d.created_at desc, d.rowid desc`
      )
      .all() as DocumentListRow[];

    return NextResponse.json({ documents: rows });
  } catch (err) {
    logError('读取文档列表失败', err);
    return NextResponse.json({ error: '读取文档列表失败，请查看服务端日志' }, { status: 500 });
  }
}
