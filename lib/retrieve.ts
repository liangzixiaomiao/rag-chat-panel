import { serverClient } from './db.ts';
import { embedTexts } from './embed.ts';
import type { Retrieved } from './types.ts';

/** 低于该相似度的子块直接丢弃，注意改这里而不是改 if。 */
const MIN_SIMILARITY = 0.3;
const DEFAULT_TOP_K = 20;
const DEFAULT_MAX_PARENTS = 8;

export interface RetrieveParams {
  question: string;
  /** M0 必填：只在该文档内检索，没有全库 fallback */
  documentId: string;
  topK?: number;
  maxParents?: number;
}

export interface RetrieveResult {
  hits: Retrieved[];
  parents: Retrieved[];
  timings: { embedMs: number; searchMs: number };
}

interface KnnRow {
  chunkId: number;
  documentId: string;
  content: string;
  fullContext: string;
  headingPath: string | null;
  pageFrom: number;
  parentIndex: number;
  distance: number;
}

// full_context 在 chunks 里已经是整段父块原文，这里只做一次 join，不再回头查父块
const KNN_SQL = `
select c.id            as chunkId,
       c.document_id   as documentId,
       c.content       as content,
       c.full_context  as fullContext,
       c.heading_path  as headingPath,
       c.page_from     as pageFrom,
       c.parent_index  as parentIndex,
       knn.distance    as distance
from (
  select chunk_id, distance
  from vec_chunks
  where embedding match ? and k = ? and document_id = ?
) as knn
join chunks c on c.id = knn.chunk_id
order by knn.distance asc
`;

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

/**
 * 检索：子块命中 → 过滤阈值 → 按父块聚合。
 * hits 保留全部命中子块（前端按 parentIndex 高亮），parents 是每个父块相似度最高的代表。
 */
export async function retrieve(params: RetrieveParams): Promise<RetrieveResult> {
  const { question, documentId } = params;
  const topK = params.topK ?? DEFAULT_TOP_K;
  const maxParents = params.maxParents ?? DEFAULT_MAX_PARENTS;

  const embedStartedAt = performance.now();
  const [queryVector] = await embedTexts([question]);
  const embedMs = elapsedMs(embedStartedAt);

  const searchStartedAt = performance.now();
  const rows = serverClient()
    .prepare(KNN_SQL)
    .all(new Float32Array(queryVector), topK, documentId) as KnnRow[];
  const searchMs = elapsedMs(searchStartedAt);

  const hits: Retrieved[] = rows
    .map((row) => ({
      chunkId: row.chunkId,
      documentId: row.documentId,
      content: row.content,
      fullContext: row.fullContext,
      headingPath: row.headingPath,
      pageFrom: row.pageFrom,
      parentIndex: row.parentIndex,
      similarity: 1 - row.distance,
    }))
    .filter((hit) => hit.similarity >= MIN_SIMILARITY);

  const byParent = new Map<number, Retrieved>();
  for (const hit of hits) {
    const current = byParent.get(hit.parentIndex);
    if (!current || hit.similarity > current.similarity) {
      byParent.set(hit.parentIndex, hit);
    }
  }

  const parents = [...byParent.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxParents);

  return { hits, parents, timings: { embedMs, searchMs } };
}
