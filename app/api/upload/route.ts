import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { serverClient } from '@/lib/db';

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['pdf', 'docx', 'md', 'txt']);
const FILES_DIR = path.join(process.cwd(), 'data', 'files');

interface DuplicateRow {
  id: string;
}

function logError(scope: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[api/upload] ${scope}\n${detail}`);
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const form = await request.formData();
    const file = form.get('file');
    const titleField = form.get('title');

    if (!(file instanceof File)) {
      return NextResponse.json({ error: '缺少文件字段 file' }, { status: 400 });
    }

    const fileType = (file.name.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED_TYPES.has(fileType)) {
      return NextResponse.json({ error: '只支持 pdf / docx / md / txt' }, { status: 415 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: '暂不支持超大文件（超过 50MB）' }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const contentHash = createHash('sha256').update(bytes).digest('hex');

    const db = serverClient();
    const duplicate = db
      .prepare("select id from documents where content_hash = ? and status = 'ready'")
      .get(contentHash) as DuplicateRow | undefined;

    if (duplicate !== undefined) {
      return NextResponse.json({ duplicate: true, documentId: duplicate.id }, { status: 409 });
    }

    const documentId = randomUUID();
    await mkdir(FILES_DIR, { recursive: true });
    const storagePath = path.join(FILES_DIR, documentId);
    await writeFile(storagePath, bytes);

    const title = typeof titleField === 'string' && titleField.trim() !== '' ? titleField.trim() : file.name;

    db.prepare(
      `insert into documents (id, title, storage_path, file_type, status, content_hash, source_kind)
       values (?, ?, ?, ?, 'pending', ?, 'upload')`
    ).run(documentId, title, storagePath, fileType, contentHash);

    return NextResponse.json({ documentId });
  } catch (err) {
    logError('上传失败', err);
    return NextResponse.json({ error: '上传失败，请查看服务端日志' }, { status: 500 });
  }
}
