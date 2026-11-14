'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const LAST_DOC_KEY = 'self-rag:last-document-id';

export type SearchScope = 'current' | 'all';

interface ScopeSwitcherProps {
  scope: SearchScope;
  /** 当前文档 id；/ask 全库页传 null */
  documentId: string | null;
}

function tabClass(active: boolean, disabled = false): string {
  const base = 'rounded-full px-3 py-1 text-xs font-medium transition-colors';
  if (disabled) return `${base} cursor-not-allowed text-gray-300`;
  if (active) return `${base} bg-white text-gray-900 shadow-sm`;
  return `${base} text-gray-500 hover:text-gray-800`;
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
      className="inline-flex shrink-0 items-center rounded-full bg-gray-100 p-0.5"
    >
      <button
        type="button"
        aria-pressed={scope === 'current'}
        className={tabClass(scope === 'current', scope !== 'current' && lastDocumentId === null)}
        onClick={() => switchTo('current')}
      >
        这篇文档
      </button>
      <button
        type="button"
        aria-pressed={scope === 'all'}
        className={tabClass(scope === 'all')}
        onClick={() => switchTo('all')}
      >
        全部文档
      </button>
    </div>
  );
}
