'use client';

import { useEffect, useState } from 'react';

interface DocumentOption {
  id: string;
  title: string;
  status: string;
}

interface DocumentListResponse {
  documents?: DocumentOption[];
  error?: string;
}

interface DocumentPickerProps {
  /** 已选文档 id；空数组表示全部文档 */
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

function chipClass(active: boolean): string {
  const base = 'max-w-[200px] truncate rounded-full border px-3 py-1 text-xs transition-colors';
  if (active) return `${base} border-gray-900 bg-gray-900 text-white`;
  return `${base} border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900`;
}

/** 只展示已就绪的文档：未入库完成的文档检索不到内容，选它只会得到“没有检索到”。 */
export default function DocumentPicker({ selectedIds, onChange }: DocumentPickerProps) {
  const [documents, setDocuments] = useState<DocumentOption[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch('/api/documents');
        const raw = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}：${raw}`);

        const data = JSON.parse(raw) as DocumentListResponse;
        if (cancelled) return;
        setDocuments((data.documents ?? []).filter((doc) => doc.status === 'ready'));
        setError('');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(id: string): void {
    onChange(selectedIds.includes(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]);
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 pb-3 sm:px-6">
      <span className="shrink-0 text-xs text-gray-400">提问范围</span>
      <button
        type="button"
        aria-pressed={selectedIds.length === 0}
        className={chipClass(selectedIds.length === 0)}
        onClick={() => onChange([])}
      >
        全部文档
      </button>

      {documents.map((doc) => {
        const active = selectedIds.includes(doc.id);
        return (
          <button
            key={doc.id}
            type="button"
            aria-pressed={active}
            title={doc.title}
            className={chipClass(active)}
            onClick={() => toggle(doc.id)}
          >
            {doc.title}
          </button>
        );
      })}

      {error !== '' && <span className="text-xs text-red-500">读取文档失败</span>}
      {error === '' && documents.length === 0 && <span className="text-xs text-gray-400">暂无已就绪文档</span>}
      {selectedIds.length > 0 && (
        <span className="ml-auto shrink-0 text-xs text-gray-400">已选 {selectedIds.length} 篇</span>
      )}
    </div>
  );
}
