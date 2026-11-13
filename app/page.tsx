import UploadForm from '@/components/upload-form';

export default function HomePage() {
  return (
    <main style={{ padding: 24, maxWidth: 760, fontFamily: 'monospace', fontSize: 14, lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 20, margin: '0 0 6px' }}>个人知识库问答</h1>
      <p style={{ color: '#555', margin: '0 0 16px' }}>
        上传一本书或一份文档，入库完成后即可针对它提问。
      </p>

      <UploadForm />
    </main>
  );
}
