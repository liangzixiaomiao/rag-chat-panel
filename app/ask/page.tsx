'use client';

import { useState } from 'react';
import ChatPanel from '@/components/chat-panel';
import CitationDrawer from '@/components/citation-drawer';
import ScopeSwitcher from '@/components/scope-switcher';
import type { CitationDetail } from '@/lib/chat-stream';

export default function AskPage() {
  const [citation, setCitation] = useState<CitationDetail | null>(null);

  return (
    <main style={{ padding: 16, maxWidth: 860, fontFamily: 'monospace', fontSize: 14, lineHeight: 1.6 }}>
      <ScopeSwitcher scope="all" documentId={null} />

      <header style={{ borderBottom: '1px solid #ddd', paddingBottom: 8, marginBottom: 12 }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>全部文档</h1>
        <p style={{ margin: '4px 0 0', color: '#2a7' }}>跨全部已入库文档检索</p>
      </header>

      <ChatPanel documentId={null} scope="all" canAsk disabledReason="" onCitationOpen={setCitation} />

      <CitationDrawer citation={citation} onClose={() => setCitation(null)} />
    </main>
  );
}
