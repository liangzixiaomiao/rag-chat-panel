'use client';

import Link from 'next/link';
import { useState } from 'react';
import DocumentList from '@/components/document-list';
import UploadForm from '@/components/upload-form';

export default function HomePage() {
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <main className="min-h-dvh bg-gray-50 text-gray-900">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">个人知识库问答</h1>
            <p className="mt-1 text-sm text-gray-500">上传一本书或一份文档，入库完成后即可针对它提问。</p>
          </div>
          <Link
            href="/ask?scope=all"
            className="shrink-0 rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:border-gray-300 hover:bg-gray-50"
          >
            多选文档提问
          </Link>
        </header>

        <section className="mt-8">
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-gray-400">上传新文档</h2>
          <UploadForm onChanged={() => setRefreshToken((value) => value + 1)} />
        </section>

        <section className="mt-10">
          <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-gray-400">已入库文档</h2>
          <DocumentList refreshToken={refreshToken} />
        </section>
      </div>
    </main>
  );
}
