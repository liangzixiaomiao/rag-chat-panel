'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
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

type ItemStatus = 'pending' | 'uploading' | 'ingesting' | 'ready' | 'duplicate' | 'failed';

interface QueueItem {
  key: string;
  fileName: string;
  status: ItemStatus;
  documentId: string | null;
  message: string;
}

interface UploadFormProps {
  /** 上传或入库状态变化后通知父组件刷新文档列表 */
  onChanged?: () => void;
}

const STATUS_LABELS: Record<ItemStatus, string> = {
  pending: '等待上传',
  uploading: '上传中',
  ingesting: '入库中',
  ready: '已就绪',
  duplicate: '已存在',
  failed: '失败',
};

const STATUS_TONES: Record<ItemStatus, string> = {
  pending: 'bg-gray-300',
  uploading: 'bg-blue-500',
  ingesting: 'bg-amber-500',
  ready: 'bg-emerald-500',
  duplicate: 'bg-gray-400',
  failed: 'bg-red-500',
};

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

export default function UploadForm({ onChanged }: UploadFormProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<QueueItem[]>([]);
  // 提交后重置 input，避免浏览器继续显示上一批文件
  const [inputKey, setInputKey] = useState(0);

  function handleFiles(event: ChangeEvent<HTMLInputElement>): void {
    setFiles(Array.from(event.target.files ?? []));
    setItems([]);
  }

  function patchItem(key: string, patch: Partial<QueueItem>): void {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }

  async function driveIngest(id: string): Promise<{ ok: boolean; message: string }> {
    let cursor = 0;

    for (let round = 0; round < MAX_INGEST_ROUNDS; round += 1) {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: id, cursor }),
      });
      const data = (await response.json()) as IngestResponse;

      if (!response.ok) {
        return { ok: false, message: data.error ?? `入库失败（HTTP ${response.status}）` };
      }

      cursor = data.nextCursor ?? 0;
      if (data.done === true) return { ok: true, message: '' };
    }

    return { ok: false, message: '入库批次超过上限，已停止' };
  }

  async function uploadOne(file: File, key: string, onlyFile: boolean): Promise<void> {
    patchItem(key, { status: 'uploading', message: '' });

    const form = new FormData();
    form.append('file', file);
    if (onlyFile && title.trim() !== '') form.append('title', title.trim());

    try {
      const response = await fetch('/api/upload', { method: 'POST', body: form });
      const data = (await response.json()) as UploadResponse;

      if (response.status === 409 && data.duplicate === true) {
        patchItem(key, {
          status: 'duplicate',
          documentId: data.documentId ?? null,
          message: '这份文档已经入库过了，已跳过',
        });
        return;
      }

      if (!response.ok || data.documentId === undefined) {
        throw new Error(data.error ?? `上传失败（HTTP ${response.status}）`);
      }

      patchItem(key, { status: 'ingesting', documentId: data.documentId });
      onChanged?.();

      const result = await driveIngest(data.documentId);
      patchItem(
        key,
        result.ok ? { status: 'ready', message: '' } : { status: 'failed', message: result.message }
      );
    } catch (err) {
      patchItem(key, { status: 'failed', message: describeError(err) });
    } finally {
      onChanged?.();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (files.length === 0 || busy) return;

    const batch = files;
    const entries: QueueItem[] = batch.map((file) => ({
      key: crypto.randomUUID(),
      fileName: file.name,
      status: 'pending',
      documentId: null,
      message: '',
    }));

    setBusy(true);
    setItems(entries);
    setFiles([]);
    setInputKey((value) => value + 1);

    // 逐个上传，避免并发入库把本地向量计算和 SQLite 写锁打满
    for (let index = 0; index < batch.length; index += 1) {
      await uploadOne(batch[index], entries[index].key, batch.length === 1);
    }

    setBusy(false);
    onChanged?.();
  }

  const activeItem =
    items.find(
      (item): item is QueueItem & { documentId: string } =>
        item.status === 'ingesting' && item.documentId !== null
    ) ?? null;
  const readyCount = items.filter((item) => item.status === 'ready').length;
  const duplicateCount = items.filter((item) => item.status === 'duplicate').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const finished = !busy && items.length > 0;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          key={inputKey}
          type="file"
          multiple
          accept=".pdf,.docx,.md,.txt"
          onChange={handleFiles}
          className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200 sm:w-auto"
        />
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={files.length > 1 ? '多文件时使用各自文件名' : '标题（可选，默认用文件名）'}
          disabled={files.length > 1}
          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-400 focus:border-gray-300 disabled:bg-gray-50 disabled:text-gray-400 sm:max-w-[240px]"
        />
        <button
          type="submit"
          disabled={busy || files.length === 0}
          className="shrink-0 rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400 sm:ml-auto"
        >
          {busy ? '批量入库中…' : files.length > 1 ? `上传 ${files.length} 个文件` : '上传并入库'}
        </button>
      </form>

      <p className="mt-3 text-xs text-gray-400">
        {files.length > 0
          ? `已选择 ${files.length} 个文件，将逐个上传入库。`
          : '支持一次选择多个 pdf / docx / md / txt，单个文件不超过 50MB。'}
      </p>

      {items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {items.map((item) => (
            <li key={item.key} className="flex items-start gap-2.5 rounded-xl bg-gray-50 px-3 py-2">
              <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${STATUS_TONES[item.status]}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-gray-800" title={item.fileName}>
                  {item.fileName}
                </p>
                {item.message !== '' && (
                  <p className="mt-0.5 truncate text-xs text-red-500" title={item.message}>
                    {item.message}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-xs text-gray-500">{STATUS_LABELS[item.status]}</span>
              {(item.status === 'ready' || item.status === 'duplicate') && item.documentId !== null && (
                <Link
                  href={`/d/${encodeURIComponent(item.documentId)}`}
                  className="shrink-0 text-xs font-medium text-blue-700 hover:underline"
                >
                  去提问 →
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      {activeItem !== null && (
        <div className="mt-3 rounded-xl border border-gray-100 bg-white p-3">
          <UploadProgress documentId={activeItem.documentId} />
        </div>
      )}

      {finished && (
        <p className="mt-3 text-xs text-gray-500">
          共 {items.length} 个文件：成功 {readyCount}，已存在 {duplicateCount}，失败 {failedCount}
          {failedCount > 0 ? '（可重新选择失败的文件再传一次）' : ''}
        </p>
      )}
    </section>
  );
}
