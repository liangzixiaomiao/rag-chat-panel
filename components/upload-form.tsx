'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import UploadProgress from '@/components/upload-progress';

const MAX_INGEST_ROUNDS = 200;

interface UploadResponse {
  documentId?: string;
  duplicate?: boolean;
  error?: string;
}

interface IngestResponse {
  nextCursor?: number;
  done?: boolean;
  total?: number;
  error?: string;
}

export default function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  async function driveIngest(id: string): Promise<void> {
    let cursor = 0;

    for (let round = 0; round < MAX_INGEST_ROUNDS; round += 1) {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: id, cursor }),
      });
      const data = (await response.json()) as IngestResponse;

      if (!response.ok) {
        setError(data.error ?? `入库失败（HTTP ${response.status}）`);
        return;
      }

      cursor = data.nextCursor ?? 0;
      if (data.done === true) return;
    }

    setError('入库批次超过上限，已停止');
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (file === null) return;

    setBusy(true);
    setError('');
    setNote('');
    setDocumentId('');

    const form = new FormData();
    form.append('file', file);
    if (title.trim() !== '') form.append('title', title.trim());

    try {
      const response = await fetch('/api/upload', { method: 'POST', body: form });
      const data = (await response.json()) as UploadResponse;

      if (response.status === 409 && data.duplicate === true) {
        setNote(`这份文档已经入库过了：${data.documentId ?? ''}`);
        if (data.documentId !== undefined) setDocumentId(data.documentId);
        return;
      }

      if (!response.ok || data.documentId === undefined) {
        throw new Error(data.error ?? `上传失败（HTTP ${response.status}）`);
      }

      setDocumentId(data.documentId);
      await driveIngest(data.documentId);
    } catch (err) {
      setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="file"
          accept=".pdf,.docx,.md,.txt"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="标题（可选，默认用文件名）"
          style={{ width: 240, padding: '2px 4px' }}
        />
        <button type="submit" disabled={busy || file === null}>
          {busy ? '入库中…' : '上传并入库'}
        </button>
      </form>

      <p style={{ color: '#666', fontSize: 12, margin: '6px 0' }}>支持 pdf / docx / md / txt，单个文件不超过 50MB。</p>

      {note !== '' && <p style={{ color: '#a60' }}>{note}</p>}
      {error !== '' && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{error}</pre>}

      {documentId !== '' && (
        <section style={{ marginTop: 12 }}>
          <UploadProgress documentId={documentId} />
          <p style={{ marginTop: 8 }}>
            去提问：<a href={`/d/${documentId}`}>/d/{documentId}</a>
          </p>
        </section>
      )}
    </section>
  );
}
