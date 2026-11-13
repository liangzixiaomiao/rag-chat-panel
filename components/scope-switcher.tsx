'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CSSProperties } from 'react';

const LAST_DOC_KEY = 'self-rag:last-document-id';

export type SearchScope = 'current' | 'all';

interface ScopeSwitcherProps {
  scope: SearchScope;
  /** 当前文档 id；/ask 全库页传 null */
  documentId: string | null;
}

function tabStyle(active: boolean, disabled = false): CSSProperties {
  return {
    border: '1px solid #888',
    borderRadius: 4,
    background: active ? '#333' : '#f5f5f5',
    color: active ? '#fff' : '#333',
    padding: '2px 10px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

export default function ScopeSwitcher({ scope, documentId }: ScopeSwitcherProps) {
  const router = useRouter();
  const [lastDocumentId, setLastDocumentId] = useState<string | null>(documentId);

  // 从文档页切到全库后，记住来源文档，便于切回“这篇文档”
  useEffect(() => {
    if (documentId !== null) {
      window.sessionStorage.setItem(LAST_DOC_KEY, documentId);
      setLastDocumentId(documentId);
      return;
    }
    setLastDocumentId(window.sessionStorage.getItem(LAST_DOC_KEY));
  }, [documentId]);

  function switchTo(next: SearchScope): void {
    if (next === scope) return;

    if (next === 'all') {
      router.push('/ask?scope=all');
      return;
    }

    if (lastDocumentId === null) return;
    router.push(`/d/${encodeURIComponent(lastDocumentId)}`);
  }

  return (
    <div
      role="group"
      aria-label="检索范围"
      style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}
    >
      <span style={{ color: '#666', fontSize: 12 }}>范围：</span>
      <button
        type="button"
        aria-pressed={scope === 'current'}
        style={tabStyle(scope === 'current', scope !== 'current' && lastDocumentId === null)}
        onClick={() => switchTo('current')}
      >
        这篇文档
      </button>
      <button
        type="button"
        aria-pressed={scope === 'all'}
        style={tabStyle(scope === 'all')}
        onClick={() => switchTo('all')}
      >
        全部文档
      </button>
    </div>
  );
}
