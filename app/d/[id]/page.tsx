'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import ChatPanel from '@/components/chat-panel';
import CitationDrawer from '@/components/citation-drawer';
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

export default function DocumentPage() {
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
    <main style={{ padding: 16, maxWidth: 860, fontFamily: 'monospace', fontSize: 14, lineHeight: 1.6 }}>
      <header style={{ borderBottom: '1px solid #ddd', paddingBottom: 8, marginBottom: 12 }}>
        {loading && <p style={{ margin: 0 }}>加载文档…</p>}

        {!loading && error !== '' && (
          <div>
            <p style={{ margin: 0, color: 'crimson', whiteSpace: 'pre-wrap' }}>{error}</p>
            <button
              type="button"
              style={{ marginTop: 8 }}
              onClick={() => {
                void load();
              }}
            >
              重试
            </button>
          </div>
        )}

        {!loading && error === '' && doc !== null && (
          <>
            <h1 style={{ fontSize: 16, margin: 0 }}>{doc.title}</h1>
            <p style={{ margin: '4px 0 0', color: doc.status === 'ready' ? '#2a7' : '#a60' }}>{statusText(doc)}</p>
          </>
        )}
      </header>

      {doc !== null && (
        <ChatPanel
          documentId={documentId}
          canAsk={canAsk}
          disabledReason={disabledReason}
          onCitationOpen={setCitation}
        />
      )}

      <CitationDrawer citation={citation} onClose={() => setCitation(null)} />
    </main>
  );
}
