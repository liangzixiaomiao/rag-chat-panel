'use client';

import { useState } from 'react';
import ChatPanel from '@/components/chat-panel';
import CitationDrawer from '@/components/citation-drawer';
import ScopeSwitcher from '@/components/scope-switcher';
import type { CitationDetail } from '@/lib/chat-stream';

export default function AskPage() {
  const [citation, setCitation] = useState<CitationDetail | null>(null);

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-gray-50 text-gray-900">
      <header className="z-10 shrink-0 border-b border-gray-200/60 bg-white/80 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-gray-900 sm:text-base">全部文档</h1>
            <p className="mt-0.5 truncate text-xs text-gray-500">跨全部已入库文档检索</p>
          </div>
          <ScopeSwitcher scope="all" documentId={null} />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <ChatPanel documentId={null} scope="all" canAsk disabledReason="" onCitationOpen={setCitation} />
      </div>

      <CitationDrawer citation={citation} onClose={() => setCitation(null)} />
    </main>
  );
}
