'use client';

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { CitationDetail } from '@/lib/chat-stream';

interface CitationDrawerProps {
  citation: CitationDetail | null;
  onClose: () => void;
}

/** 把 quote 在父块全文里标出来；找不到就原样输出。 */
function highlight(text: string, quote: string): ReactNode {
  if (quote === '') return text;

  const segments = text.split(quote);
  if (segments.length === 1) return text;

  return segments.map((segment, index) => (
    <Fragment key={index}>
      {segment}
      {index < segments.length - 1 && <mark style={{ background: '#fff3bf' }}>{quote}</mark>}
    </Fragment>
  ));
}

export default function CitationDrawer({ citation, onClose }: CitationDrawerProps) {
  if (citation === null) return null;

  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.15)', zIndex: 9 }}
      />
      <aside
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: '92vw',
          background: '#fff',
          borderLeft: '1px solid #ccc',
          padding: 16,
          overflowY: 'auto',
          zIndex: 10,
          fontSize: 13,
          lineHeight: 1.6,
          fontFamily: 'monospace',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>引用 [{citation.refId}]</strong>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>

        <p style={{ margin: '8px 0 0', fontWeight: 'bold' }}>{citation.documentTitle}</p>
        <p style={{ margin: '4px 0 0' }}>{citation.headingPath === null ? '(无标题)' : citation.headingPath}</p>
        <p style={{ margin: '4px 0 12px' }}>
          p{citation.pageFrom}-{citation.pageTo === null ? '?' : citation.pageTo}
        </p>

        <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{highlight(citation.fullContext, citation.quote)}</pre>

        <p style={{ marginTop: 12, color: '#666' }}>命中片段：{citation.quote}</p>

        <button type="button" disabled title="原文件预览接口尚未实现">
          打开原文件第 {citation.pageFrom} 页
        </button>
      </aside>
    </>
  );
}
