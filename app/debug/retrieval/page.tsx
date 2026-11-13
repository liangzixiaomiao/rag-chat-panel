'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Retrieved } from '@/lib/types';

interface SearchResponse {
  hits: Retrieved[];
  parents: Retrieved[];
  timings: { embedMs: number; searchMs: number };
}

const MAX_ROWS = 20;

function SimilarityBar({ value }: { value: number }) {
  const width = `${Math.max(0, Math.min(1, value)) * 100}%`;
  return (
    <span
      style={{
        display: 'inline-block',
        width: 80,
        height: 6,
        marginLeft: 6,
        background: '#e5e5e5',
        verticalAlign: 'middle',
      }}
    >
      <span style={{ display: 'block', height: 6, width, background: '#666' }} />
    </span>
  );
}

export default function RetrievalDebugPage() {
  const [documentId, setDocumentId] = useState('');
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [openIds, setOpenIds] = useState<number[]>([]);

  async function runSearch(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    setOpenIds([]);

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, documentId }),
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}\n${raw}`);
      }
      setResult(JSON.parse(raw) as SearchResponse);
    } catch (err) {
      setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggle(chunkId: number): void {
    setOpenIds((current) =>
      current.includes(chunkId) ? current.filter((id) => id !== chunkId) : [...current, chunkId]
    );
  }

  return (
    <main style={{ padding: 16, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.5 }}>
      <h1 style={{ fontSize: 16, margin: '0 0 12px' }}>/debug/retrieval</h1>

      <form onSubmit={runSearch} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={documentId}
          onChange={(event) => setDocumentId(event.target.value)}
          placeholder="documentId"
          style={{ width: 280, padding: '2px 4px' }}
        />
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="question"
          style={{ width: 360, padding: '2px 4px' }}
        />
        <button type="submit" disabled={loading || documentId.trim() === ''}>
          检索
        </button>
        {documentId.trim() === '' && <span>先填 documentId</span>}
        {loading && <span>检索中…</span>}
      </form>

      {error !== '' && (
        <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap', marginTop: 12 }}>{error}</pre>
      )}

      {result && (
        <section style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 12px' }}>
            timings: embedding {result.timings.embedMs} ms ／ 检索 {result.timings.searchMs} ms　｜　hits{' '}
            {result.hits.length} ／ parents {result.parents.length}
          </p>

          <h2 style={{ fontSize: 14, margin: '12px 0 6px' }}>子块命中（最多 {MAX_ROWS} 条）</h2>
          {result.hits.length === 0 ? (
            <p>无命中（全部低于阈值）</p>
          ) : (
            <table border={1} cellPadding={4} style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>page_from</th>
                  <th>similarity</th>
                  <th>content（前 120 字）</th>
                </tr>
              </thead>
              <tbody>
                {result.hits.slice(0, MAX_ROWS).map((hit, index) => {
                  const open = openIds.includes(hit.chunkId);
                  return (
                    <tr key={hit.chunkId}>
                      <td>{index + 1}</td>
                      <td>{hit.pageFrom}</td>
                      <td>
                        {hit.similarity.toFixed(3)}
                        <SimilarityBar value={hit.similarity} />
                      </td>
                      <td>
                        {open ? (
                          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{hit.content}</pre>
                        ) : (
                          hit.content.slice(0, 120)
                        )}{' '}
                        <button type="button" onClick={() => toggle(hit.chunkId)}>
                          {open ? '收起' : '展开'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <h2 style={{ fontSize: 14, margin: '16px 0 6px' }}>父块（最多 {MAX_ROWS} 条）</h2>
          {result.parents.length === 0 ? (
            <p>无父块</p>
          ) : (
            result.parents.slice(0, MAX_ROWS).map((parent) => (
              <div key={`parent-${parent.chunkId}`} style={{ borderTop: '1px solid #ccc', padding: '6px 0' }}>
                <div>
                  父块 {parent.parentIndex} ／ p{parent.pageFrom}-{parent.pageTo ?? '?'} ／{' '}
                  {parent.headingPath ?? '(无标题)'} ／ sim {parent.similarity.toFixed(3)}
                  <SimilarityBar value={parent.similarity} />
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{parent.fullContext}</pre>
              </div>
            ))
          )}
        </section>
      )}
    </main>
  );
}
