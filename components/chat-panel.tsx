'use client';

import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { streamChat } from '@/lib/chat-stream';
import type { CitationDetail } from '@/lib/chat-stream';

const FIRST_TOKEN_TIMEOUT_MS = 30000;
const MAX_HISTORY = 4;
const FALLBACK_ERROR = '这次没答上来，可以重试';

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: CitationDetail[];
  error: string | null;
  pending: boolean;
}

interface ChatPanelProps {
  documentId: string;
  canAsk: boolean;
  disabledReason: string;
  onCitationOpen: (citation: CitationDetail) => void;
}

const badgeStyle = {
  border: '1px solid #888',
  borderRadius: 3,
  background: '#f3f3f3',
  padding: '0 3px',
  margin: '0 1px',
  cursor: 'pointer',
  fontSize: 12,
} as const;

export default function ChatPanel({ documentId, canAsk, disabledReason, onCitationOpen }: ChatPanelProps) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);

  function patchMessage(id: string, patch: Partial<UiMessage>): void {
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  }

  async function send(rawQuestion: string): Promise<void> {
    const question = rawQuestion.trim();
    if (question === '' || busy || !canAsk) return;

    const history = messages
      .filter((message) => message.content.trim() !== '')
      .slice(-MAX_HISTORY)
      .map((message) => ({ role: message.role, content: message.content }));

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();

    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', content: question, citations: [], error: null, pending: false },
      { id: assistantId, role: 'assistant', content: '', citations: [], error: null, pending: true },
    ]);
    setInput('');
    setBusy(true);

    const controller = new AbortController();
    let receivedFirstToken = false;
    const timeoutTimer = setTimeout(() => {
      if (!receivedFirstToken) {
        controller.abort();
        patchMessage(assistantId, { pending: false, error: '检索或生成超时' });
      }
    }, FIRST_TOKEN_TIMEOUT_MS);

    try {
      const result = await streamChat(
        { question, documentId, history },
        {
          onText: (delta) => {
            if (!receivedFirstToken) {
              receivedFirstToken = true;
              clearTimeout(timeoutTimer);
            }
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, content: message.content + delta } : message
              )
            );
          },
          onCitations: (citations) => patchMessage(assistantId, { citations }),
        },
        controller.signal
      );

      if (result.error !== null) {
        patchMessage(assistantId, { error: result.error });
      } else if (result.text === '') {
        patchMessage(assistantId, { error: FALLBACK_ERROR });
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      const detail = err instanceof Error ? err.message : String(err);
      patchMessage(assistantId, { error: aborted ? '检索或生成超时' : `${FALLBACK_ERROR}（${detail}）` });
    } finally {
      clearTimeout(timeoutTimer);
      patchMessage(assistantId, { pending: false });
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  }

  function renderContent(message: UiMessage): ReactNode[] {
    const nodes: ReactNode[] = [];
    const pattern = /\[(\d+)\]/g;
    let cursor = 0;
    let match = pattern.exec(message.content);

    while (match !== null) {
      if (match.index > cursor) nodes.push(message.content.slice(cursor, match.index));

      const refId = Number(match[1]);
      const citation = message.citations.find((item) => item.refId === refId);
      const key = `${message.id}-${match.index}`;

      nodes.push(
        citation ? (
          <button key={key} type="button" style={badgeStyle} onClick={() => onCitationOpen(citation)}>
            [{refId}]
          </button>
        ) : (
          <span key={key}>[{refId}]</span>
        )
      );

      cursor = match.index + match[0].length;
      match = pattern.exec(message.content);
    }

    nodes.push(message.content.slice(cursor));
    return nodes;
  }

  function previousQuestion(index: number): string {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor].role === 'user') return messages[cursor].content;
    }
    return '';
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ minHeight: 200 }}>
        {messages.length === 0 ? (
          <p style={{ color: '#666' }}>在这篇文档里问点什么</p>
        ) : (
          messages.map((message, index) => (
            <div key={message.id} style={{ marginBottom: 12 }}>
              <div style={{ color: '#888', fontSize: 12 }}>{message.role === 'user' ? '你' : '助手'}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>
                {message.content === '' && message.pending ? '…' : renderContent(message)}
              </div>
              {message.error !== null && (
                <div style={{ color: 'crimson', marginTop: 4 }}>
                  {message.error}
                  <button
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() => void send(previousQuestion(index))}
                    disabled={busy}
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={!canAsk || busy}
          placeholder={canAsk ? 'Enter 发送，Shift+Enter 换行' : disabledReason}
          style={{ flex: 1, padding: 6, cursor: busy ? 'progress' : 'text' }}
        />
        <button type="submit" onClick={() => void send(input)} disabled={!canAsk || busy}>
          {busy ? '生成中…' : '发送'}
        </button>
      </div>

      {!canAsk && <div style={{ color: '#a60', fontSize: 12 }}>{disabledReason}</div>}
    </section>
  );
}
