export interface Paragraph {
  text: string;
  page: number | null;
  headingPath: string;
}

export interface ParentChunk {
  parentIndex: number;
  headingPath: string;
  pageFrom: number;
  pageTo: number;
  fullContext: string;
  children: Chunk[];
}

export interface Chunk {
  content: string;
  pageFrom: number;
  pageTo: number;
  chunkIndex: number;
  tokenCount: number;
}

export interface Retrieved {
  chunkId: number;
  documentId: string;
  content: string;
  fullContext: string;
  headingPath: string | null;
  pageFrom: number;
  pageTo: number | null;
  parentIndex: number;
  similarity: number;
}

export interface Citation {
  refId: number;
  quote: string;
  pageFrom: number;
  headingPath: string | null;
}

export interface ChatAnswer {
  answer: string;
  citations: Citation[];
}

export type DocumentStatus =
  | 'pending'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'ready'
  | 'failed';

export interface Document {
  id: string;
  title: string;
  storagePath: string;
  fileType: string;
  pageCount: number | null;
  status: DocumentStatus;
  error: string | null;
  contentHash: string | null;
  sourceKind: 'upload' | 'watch';
  createdAt: string;
}
