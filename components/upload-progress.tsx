'use client';

import { useCallback, useEffect, useState } from 'react';

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_COUNT = 100;

const STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  parsing: '解析中',
  chunking: '切块中',
  embedding: '向量化中',
  ready: '已完成',
  failed: '失败',
};

interface DocumentState {
  id: string;
  title: string;
  status: string;
  chunkCount: number;
  embeddedCount: number;
  error: string | null;
}

interface UploadProgressProps {
  documentId: string;
}

export default function UploadProgress({ documentId }: UploadProgressProps) {
  const [doc, setDoc] = useState<DocumentState | null>(null);
  const [pollError, setPollError] = useState('');
  const [retryError, setRetryError] = useState('');
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;

    function scheduleNext(): void {
      if (pollCount >= MAX_POLL_COUNT) {
        setPollError(`已连续轮询 ${MAX_POLL_COUNT} 次仍未完成，已停止`);
        return;
      }
      timer = setTimeout(() => {
        void poll();
      }, POLL_INTERVAL_MS);
    }

    async function poll(): Promise<void> {
      if (cancelled) return;
      pollCount += 1;

      try {
        const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`);
        const raw = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}：${raw}`);

        const data = JSON.parse(raw) as DocumentState;
        if (cancelled) return;

        setDoc(data);
        setPollError('');

        if (data.status !== 'ready' && data.status !== 'failed') {
          scheduleNext();
        }
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        scheduleNext();
      }
    }

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [documentId, round]);

  const retry = useCallback(async (): Promise<void> => {
    setRetryError('');
    setRound((value) => value + 1);

    try {
      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, cursor: doc?.embeddedCount ?? 0 }),
      });
      if (!response.ok) {
        const raw = await response.text();
        setRetryError(`重试失败（HTTP ${response.status}）：${raw}`);
      }
    } catch (err) {
      setRetryError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    }
  }, [documentId, doc]);

  const percent =
    doc === null || doc.chunkCount === 0 ? 0 : Math.round((doc.embeddedCount / doc.chunkCount) * 100);

  if (doc === null) {
    return <p style={{ fontFamily: 'monospace' }}>{pollError === '' ? '读取进度…' : pollError}</p>;
  }

  return (
    <section style={{ fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}>
      <p style={{ margin: 0 }}>
        {doc.title} — {STATUS_LABELS[doc.status] ?? doc.status}（{percent}%）
      </p>

      <div style={{ height: 8, background: '#eee', width: 320, margin: '6px 0' }}>
        <div
          style={{
            height: '100%',
            width: `${doc.status === 'ready' ? 100 : percent}%`,
            background: doc.status === 'failed' ? '#c33' : '#2a7',
          }}
        />
      </div>

      <p style={{ margin: 0 }}>
        子块 {doc.embeddedCount} / {doc.chunkCount}
      </p>

      {doc.status === 'failed' && (
        <div style={{ color: 'crimson', marginTop: 6 }}>
          <p style={{ margin: 0 }}>{doc.error === null ? '入库失败' : doc.error.slice(0, 100)}</p>
          <button type="button" style={{ marginTop: 6 }} onClick={() => void retry()}>
            重试
          </button>
        </div>
      )}

      {retryError !== '' && <p style={{ color: 'crimson' }}>{retryError}</p>}
      {pollError !== '' && <p style={{ color: '#a60' }}>轮询失败：{pollError}</p>}
    </section>
  );
}
