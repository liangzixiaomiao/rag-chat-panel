'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { streamChat } from '@/lib/chat-stream';
import type { Citation } from '@/lib/types';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export default function ChatDebugPage() {
  const [documentId, setDocumentId] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<Turn[]>([]);

  async function send(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const asked = question;
    const priorHistory = history.slice(-4);

    setBusy(true);
    setError('');
    setAnswer('');
    setCitations([]);

    try {
      const result = await streamChat(
        { question: asked, documentId, history: priorHistory },
        {
          onText: (delta) => setAnswer((current) => current + delta),
          onCitations: setCitations,
        }
      );

      if (result.error !== null) setError(result.error);
      const nextTurns: Turn[] = [
        ...priorHistory,
        { role: 'user', content: asked },
        { role: 'assistant', content: result.text },
      ];
      setHistory(nextTurns.slice(-4));
      setQuestion('');
    } catch (err) {
      setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: 16, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 16, margin: '0 0 12px' }}>/debug/chat</h1>

      <form onSubmit={send} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={documentId}
          onChange={(event) => setDocumentId(event.target.value)}
          placeholder="documentId"
          style={{ width: 240, padding: '2px 4px' }}
        />
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="question"
          style={{ width: 420, padding: '2px 4px' }}
        />
        <button type="submit" disabled={busy || documentId.trim() === ''}>
          发送
        </button>
        {documentId.trim() === '' && <span>先填 documentId</span>}
        {busy && <span>生成中…</span>}
        {history.length > 0 && <span>已带 {history.length} 条历史</span>}
      </form>

      {error !== '' && <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 12 }}>{error}</pre>}

      <h2 style={{ fontSize: 14, margin: '16px 0 6px' }}>回答</h2>
      <pre style={{ whiteSpace: 'pre-wrap', margin: 0, minHeight: 40 }}>{answer === '' ? '（等待流式输出）' : answer}</pre>

      <h2 style={{ fontSize: 14, margin: '16px 0 6px' }}>引用（{citations.length}）</h2>
      {citations.length === 0 ? (
        <p style={{ margin: 0 }}>（无）</p>
      ) : (
        <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th>refId</th>
              <th>pageFrom</th>
              <th>headingPath</th>
              <th>quote</th>
            </tr>
          </thead>
          <tbody>
            {citations.map((citation, index) => (
              <tr key={`${citation.refId}-${index}`}>
                <td>{citation.refId}</td>
                <td>{citation.pageFrom}</td>
                <td>{citation.headingPath ?? '(无标题)'}</td>
                <td>{citation.quote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
