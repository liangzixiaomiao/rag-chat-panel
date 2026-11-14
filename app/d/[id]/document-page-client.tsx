'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import ChatPanel from '@/components/chat-panel';
import CitationDrawer from '@/components/citation-drawer';
import ScopeSwitcher from '@/components/scope-switcher';
import type { CitationDetail } from '@/lib/chat-stream';

interface DocumentInfo {
  id: string;
  title: string;
  status: string;
  pageCount: number | null;
  error: string | null;
}

function statusText(doc: DocumentInfo): string {
  if (doc.status === 'ready') return '已就绪';
  if (doc.status === 'failed') return doc.error === null ? '入库失败' : `入库失败：${doc.error}`;
  return '入库中';
}

function statusTone(doc: DocumentInfo): string {
  if (doc.status === 'ready') return 'bg-emerald-500';
  if (doc.status === 'failed') return 'bg-red-500';
  return 'bg-amber-500';
}

export default function DocumentPageClient() {
  const params = useParams<{ id: string }>();
  const documentId = typeof params.id === 'string' ? params.id : '';

  const [doc, setDoc] = useState<DocumentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [citation, setCitation] = useState<CitationDetail | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (documentId === '') {
      setError('缺少文档 id');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`);
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}：${raw}`);
      }
      setDoc(JSON.parse(raw) as DocumentInfo);
    } catch (err) {
      setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const canAsk = doc !== null && doc.status === 'ready';
  const disabledReason =
    doc === null
      ? '文档信息未加载完成'
      : doc.status === 'ready'
        ? ''
        : `文档状态为 ${doc.status}（${statusText(doc)}），暂不可提问`;

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-gray-50 text-gray-900">
      <header className="z-10 shrink-0 border-b border-gray-200/60 bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            {loading && <p className="text-sm text-gray-400">加载文档…</p>}

            {!loading && error !== '' && (
              <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 break-words text-sm text-red-600">{error}</p>
                <button
                  type="button"
                  onClick={() => {
                    void load();
                  }}
                  className="shrink-0 rounded-lg bg-gray-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-700"
                >
                  重试
                </button>
              </div>
            )}

            {!loading && error === '' && doc !== null && (
              <>
                <h1 className="truncate text-sm font-semibold text-gray-900 sm:text-base" title={doc.title}>
                  {doc.title}
                </h1>
                <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-gray-500">
                  <span className={`size-1.5 shrink-0 rounded-full ${statusTone(doc)}`} />
                  <span className="truncate" title={statusText(doc)}>
                    {statusText(doc)}
                  </span>
                </p>
              </>
            )}
          </div>

          <ScopeSwitcher scope="current" documentId={documentId === '' ? null : documentId} />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        {doc !== null ? (
          <ChatPanel
            documentId={documentId === '' ? null : documentId}
            scope="current"
            canAsk={canAsk}
            disabledReason={disabledReason}
            onCitationOpen={setCitation}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            {error !== '' && '文档不可用'}
          </div>
        )}
      </div>

      <CitationDrawer citation={citation} onClose={() => setCitation(null)} />
    </main>
  );
}
