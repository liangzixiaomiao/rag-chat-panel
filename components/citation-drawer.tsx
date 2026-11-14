'use client';

import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
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
      {index < segments.length - 1 && (
        <mark className="rounded bg-yellow-200 px-0.5 text-gray-900">{quote}</mark>
      )}
    </Fragment>
  ));
}

export default function CitationDrawer({ citation, onClose }: CitationDrawerProps) {
  // 关闭后仍保留上一次内容，抽屉滑出的 300ms 里不会突然变空白
  const [shown, setShown] = useState<CitationDetail | null>(citation);
  if (citation !== null && citation !== shown) setShown(citation);

  const open = citation !== null;

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? '' : 'pointer-events-none'}`}
      role="dialog"
      aria-modal="true"
      aria-label="引用详情"
      aria-hidden={!open}
      inert={!open}
    >
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-gray-900/20 backdrop-blur-[2px] transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />

      <aside
        className={`absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-2xl transition-transform duration-300 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {shown !== null && (
          <>
            <header className="shrink-0 border-b border-gray-100 px-5 pb-4 pt-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400">引用</p>
                  <h2 className="mt-1 truncate text-base font-semibold text-gray-900">{shown.documentTitle}</h2>
                </div>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={onClose}
                  className="-mr-1 -mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                  第 {shown.pageFrom}
                  {shown.pageTo === null ? '' : `–${shown.pageTo}`} 页
                </span>
                {shown.headingPath !== null && shown.headingPath !== '' && (
                  <span className="min-w-0 truncate text-xs text-gray-500">{shown.headingPath}</span>
                )}
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
              <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-400">父块原文</p>
              <div className="whitespace-pre-wrap text-[15px] leading-7 text-gray-700">
                {highlight(shown.fullContext, shown.quote)}
              </div>
            </div>

            <footer className="shrink-0 border-t border-gray-100 px-5 py-3">
              <button type="button" disabled title="原文件预览接口尚未实现" className="text-xs text-gray-400">
                打开原文件第 {shown.pageFrom} 页
              </button>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}
