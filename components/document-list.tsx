'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

interface DocumentSummary {
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

interface DocumentListResponse {
  documents?: DocumentSummary[];
  error?: string;
}

interface DocumentListProps {
  /** 值变化时重新拉取列表，上传完成后由父组件自增 */
  refreshToken: number;
}

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  parsing: '解析中',
  chunking: '切块中',
  embedding: '向量化中',
  ready: '已就绪',
  failed: '入库失败',
};

function statusLabel(doc: DocumentSummary): string {
  return STATUS_LABELS[doc.status] ?? doc.status;
}

function statusTone(status: string): string {
  if (status === 'ready') return 'bg-emerald-500';
  if (status === 'failed') return 'bg-red-500';
  return 'bg-amber-500';
}

function metaText(doc: DocumentSummary): string {
  if (doc.status === 'failed') {
    return doc.error === null ? '入库失败' : doc.error.slice(0, 80);
  }
  if (doc.status === 'ready') {
    const pages = doc.pageCount === null ? '' : ` · ${doc.pageCount} 页`;
    return `${doc.fileType.toUpperCase()}${pages} · ${doc.chunkCount} 个子块`;
  }
  const percent = doc.chunkCount === 0 ? 0 : Math.round((doc.embeddedCount / doc.chunkCount) * 100);
  return `${doc.embeddedCount} / ${doc.chunkCount} 子块（${percent}%）`;
}

export default function DocumentList({ refreshToken }: DocumentListProps) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch('/api/documents');
        const raw = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}：${raw}`);

        const data = JSON.parse(raw) as DocumentListResponse;
        if (cancelled) return;
        setDocuments(data.documents ?? []);
        setError('');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshToken, round]);

  if (loading) {
    return <p className="px-1 py-6 text-sm text-gray-400">读取文档列表…</p>;
  }

  if (error !== '') {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">
        <span className="min-w-0 flex-1 break-words">{error}</span>
        <button
          type="button"
          className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
          onClick={() => {
            setLoading(true);
            setRound((value) => value + 1);
          }}
        >
          重试
        </button>
      </div>
    );
  }

  if (documents.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-gray-200 bg-white/60 px-6 py-10 text-center">
        <p className="text-sm font-medium text-gray-700">还没有文档</p>
        <p className="mt-1 text-xs text-gray-400">上传 PDF / DOCX / MD / TXT，入库完成后就能开始提问。</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      {documents.map((doc) => (
        <li key={doc.id} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-gray-50/70">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-gray-900" title={doc.title}>
              {doc.title}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-500">
              <span className={`size-1.5 shrink-0 rounded-full ${statusTone(doc.status)}`} />
              <span className="shrink-0">{statusLabel(doc)}</span>
              <span className="text-gray-300">·</span>
              <span className="min-w-0 truncate" title={metaText(doc)}>
                {metaText(doc)}
              </span>
            </p>
          </div>

          <Link
            href={`/d/${encodeURIComponent(doc.id)}`}
            className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50"
          >
            {doc.status === 'ready' ? '去提问' : '查看进度'}
          </Link>
        </li>
      ))}
    </ul>
  );
}
