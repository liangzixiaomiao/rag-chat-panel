import { Suspense } from 'react';
import DocumentPageClient from './document-page-client';

// G9 还没有上传/缓存能力，这个路由跳过即时导航校验，直接阻塞渲染。
export const instant = false;

export default function DocumentPage() {
  return (
    <Suspense fallback={<main style={{ padding: 16, fontFamily: 'monospace' }}>加载文档…</main>}>
      <DocumentPageClient />
    </Suspense>
  );
}
