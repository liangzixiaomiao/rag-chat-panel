'use client';

import UploadForm from '@/components/upload-form';

export default function UploadDebugPage() {
  return (
    <main style={{ padding: 16, fontFamily: 'monospace', fontSize: 13, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 16, margin: '0 0 12px' }}>/debug/upload</h1>
      <UploadForm />
    </main>
  );
}
