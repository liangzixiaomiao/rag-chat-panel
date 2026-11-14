'use client';

import { useState } from 'react';
import ChatPanel from '@/components/chat-panel';
import CitationDrawer from '@/components/citation-drawer';
import DocumentPicker from '@/components/document-picker';
import ScopeSwitcher from '@/components/scope-switcher';
import type { CitationDetail } from '@/lib/chat-stream';

export default function AskPage() {
  const [citation, setCitation] = useState<CitationDetail | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // 不选任何文档时等价于全部文档；选了就只在这些文档里检索
  const scope = selectedIds.length > 0 ? 'selected' : 'all';

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-gray-50 text-gray-900">
      <header className="z-10 shrink-0 border-b border-gray-200/60 bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pb-2 pt-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-gray-900 sm:text-base">
              {selectedIds.length > 0 ? `已选 ${selectedIds.length} 篇文档` : '全部文档'}
            </h1>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {selectedIds.length > 0 ? '问题只会在这几篇文档里检索' : '跨全部已入库文档检索'}
            </p>
          </div>

          {selectedIds.length === 0 ? (
            <ScopeSwitcher scope="all" documentId={null} />
          ) : (
            <button
              type="button"
              onClick={() => setSelectedIds([])}
              className="shrink-0 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 transition-colors hover:border-gray-300 hover:text-gray-900"
            >
              清空选择
            </button>
          )}
        </div>

        <DocumentPicker selectedIds={selectedIds} onChange={setSelectedIds} />
      </header>

      <div className="min-h-0 flex-1">
        <ChatPanel
          documentId={null}
          scope={scope}
          documentIds={selectedIds.length > 0 ? selectedIds : null}
          canAsk
          disabledReason=""
          onCitationOpen={setCitation}
        />
      </div>

      <CitationDrawer citation={citation} onClose={() => setCitation(null)} />
    </main>
  );
}
