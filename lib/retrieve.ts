import { serverClient } from './db.ts';
import { embedTexts } from './embed.ts';
import type { CompareSide } from './commands.ts';
import type { Retrieved } from './types.ts';

/** 低于该相似度的子块直接丢弃，注意改这里而不是改 if。 */
const MIN_SIMILARITY = 0.3;
const DEFAULT_TOP_K = 20;
const DEFAULT_MAX_PARENTS = 8;
/** 全库检索的候选放大倍数：避免单本大文档占满 KNN 名额，把小文档挤光。 */
const ALL_SCOPE_CANDIDATE_FACTOR = 4;

export interface RetrieveParams {
  question: string;
  /** null 表示全库检索；有值时只在该文档内检索 */
  documentId: string | null;
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
  documentTitle: string;
  content: string;
  fullContext: string;
  headingPath: string | null;
  pageFrom: number;
  pageTo: number | null;
  parentIndex: number;
  distance: number;
}

// full_context 在 chunks 里已经是整段父块原文，这里只做一次 join，不再回头查父块。
// scoped=false 时去掉 partition 条件，vec0 支持不带 document_id 的全库 KNN。
function knnSql(scoped: boolean): string {
  const partition = scoped ? '\n    and document_id = ?' : '';
  return `
select c.id            as chunkId,
       c.document_id   as documentId,
       d.title         as documentTitle,
       c.content       as content,
       c.full_context  as fullContext,
       c.heading_path  as headingPath,
       c.page_from     as pageFrom,
       c.page_to       as pageTo,
       c.parent_index  as parentIndex,
       knn.distance    as distance
from (
  select chunk_id, distance
  from vec_chunks
  where embedding match ? and k = ?${partition}
) as knn
join chunks c on c.id = knn.chunk_id
join documents d on d.id = c.document_id
order by knn.distance asc
`;
}

function elapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

/**
 * 检索：子块命中 → 过滤阈值 → 按父块聚合。
 * documentId 为 null 时全库检索，父块聚合键带上 documentId，避免不同文档的 parentIndex 串在一起。
 * hits 保留全部命中子块（前端按 parentIndex 高亮），parents 是每个父块相似度最高的代表。
 */
export async function retrieve(params: RetrieveParams): Promise<RetrieveResult> {
  const { question, documentId } = params;
  const topK = params.topK ?? DEFAULT_TOP_K;
  const maxParents = params.maxParents ?? DEFAULT_MAX_PARENTS;
  const allScope = documentId === null;
  // 全库时多取候选，后面再按文档保底，单文档检索保持原有 topK 不变
  const candidateK = allScope ? topK * ALL_SCOPE_CANDIDATE_FACTOR : topK;

  const embedStartedAt = performance.now();
  const [queryVector] = await embedTexts([question]);
  const embedMs = elapsedMs(embedStartedAt);

  const searchStartedAt = performance.now();
  const db = serverClient();
  const rows = allScope
    ? (db.prepare(knnSql(false)).all(new Float32Array(queryVector), candidateK) as KnnRow[])
    : (db.prepare(knnSql(true)).all(new Float32Array(queryVector), topK, documentId) as KnnRow[]);
  const searchMs = elapsedMs(searchStartedAt);

  const hits: Retrieved[] = rows
    .map((row) => ({
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      content: row.content,
      fullContext: row.fullContext,
      headingPath: row.headingPath,
      pageFrom: row.pageFrom,
      pageTo: row.pageTo,
      parentIndex: row.parentIndex,
      similarity: 1 - row.distance,
    }))
    .filter((hit) => hit.similarity >= MIN_SIMILARITY);

  const byParent = new Map<string, Retrieved>();
  for (const hit of hits) {
    const key = `${hit.documentId}#${hit.parentIndex}`;
    const current = byParent.get(key);
    if (!current || hit.similarity > current.similarity) {
      byParent.set(key, hit);
    }
  }

  const ranked = [...byParent.values()].sort((a, b) => b.similarity - a.similarity);
  const parents = allScope ? pickCrossDocument(ranked, maxParents) : ranked.slice(0, maxParents);

  return { hits: hits.slice(0, topK), parents, timings: { embedMs, searchMs } };
}

/**
 * 全库父块挑选：先保证每个有命中的文档至少进 1 条，再按相似度补满。
 * 只有一份文档时，结果与单文档检索完全一致。
 */
function pickCrossDocument(ranked: Retrieved[], maxParents: number): Retrieved[] {
  const picked: Retrieved[] = [];
  const covered = new Set<string>();

  for (const parent of ranked) {
    if (picked.length >= maxParents) break;
    if (covered.has(parent.documentId)) continue;
    covered.add(parent.documentId);
    picked.push(parent);
  }

  for (const parent of ranked) {
    if (picked.length >= maxParents) break;
    if (picked.includes(parent)) continue;
    picked.push(parent);
  }

  return picked.sort((a, b) => b.similarity - a.similarity);
}

interface ParentRow {
  chunkId: number;
  documentId: string;
  documentTitle: string;
  content: string;
  fullContext: string;
  headingPath: string | null;
  pageFrom: number;
  pageTo: number | null;
  parentIndex: number;
}

interface DocumentRow {
  id: string;
  title: string;
}

function toRetrieved(row: ParentRow): Retrieved {
  // 结构类查询没有相似度，这里只是给 Retrieved 一个占位值；不参与排序。
  return { ...row, similarity: 1 };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export interface ListParentsParams {
  documentId: string | null;
  limit: number;
}

/** 按父块顺序列出结构（/outline 用）：不做向量检索，保证整篇文档的 headingPath 都能拿到。 */
export function listParents(params: ListParentsParams): Retrieved[] {
  const rows = serverClient()
    .prepare(
      `select c.id            as chunkId,
              c.document_id   as documentId,
              d.title         as documentTitle,
              c.content       as content,
              c.full_context  as fullContext,
              c.heading_path  as headingPath,
              c.page_from     as pageFrom,
              c.page_to       as pageTo,
              c.parent_index  as parentIndex
       from chunks c
       join documents d on d.id = c.document_id
       where (? is null or c.document_id = ?)
         and c.id in (select min(id) from chunks group by document_id, parent_index)
       order by d.created_at asc, c.document_id asc, c.parent_index asc
       limit ?`
    )
    .all(params.documentId, params.documentId, params.limit) as ParentRow[];

  return rows.map(toRetrieved);
}

export interface CompareRetrieveParams {
  scope: 'current' | 'all';
  documentId: string | null;
  targets: [string, string];
  topK: number;
  maxParentsPerSide: number;
}

export type CompareRetrieveResult =
  | { ok: true; sides: [CompareSide, CompareSide] }
  | { ok: false; message: string };

function findDocumentRows(target: string): DocumentRow[] {
  return serverClient()
    .prepare(
      `select id, title from documents
       where id = ? or title like ? escape '\\'
       order by case when id = ? then 0 when title = ? then 1 else 2 end
       limit 5`
    )
    .all(target, `%${escapeLike(target)}%`, target, target) as DocumentRow[];
}

function pickDocument(rows: DocumentRow[], target: string): DocumentRow | null {
  const exact = rows.find((row) => row.id === target || row.title === target);
  if (exact !== undefined) return exact;
  return rows.length === 1 ? rows[0] : null;
}

function headingPathsFor(documentId: string, target: string): string[] {
  const rows = serverClient()
    .prepare(
      `select distinct heading_path as headingPath
       from chunks
       where document_id = ?
         and heading_path is not null
         and heading_path <> ''
         and heading_path like ? escape '\\'
       limit 30`
    )
    .all(documentId, `%${escapeLike(target)}%`) as Array<{ headingPath: string }>;

  return rows.map((row) => row.headingPath);
}

function parentsByHeadings(documentId: string, headings: string[], limit: number): Retrieved[] {
  if (headings.length === 0) return [];

  const placeholders = headings.map(() => '?').join(', ');
  const rows = serverClient()
    .prepare(
      `select c.id            as chunkId,
              c.document_id   as documentId,
              d.title         as documentTitle,
              c.content       as content,
              c.full_context  as fullContext,
              c.heading_path  as headingPath,
              c.page_from     as pageFrom,
              c.page_to       as pageTo,
              c.parent_index  as parentIndex
       from chunks c
       join documents d on d.id = c.document_id
       where c.document_id = ?
         and c.heading_path in (${placeholders})
         and c.id in (select min(id) from chunks where document_id = ? group by parent_index)
       order by c.parent_index asc
       limit ?`
    )
    .all(documentId, ...headings, documentId, limit) as ParentRow[];

  return rows.map(toRetrieved);
}

/**
 * /compare 的两侧检索。
 * 当前文档：两个参数按章节标题解析，匹配 headingPath；匹配不到就退回该参数的向量检索。
 * 全部文档：两个参数按文档标题解析，各自在文档内取核心内容。
 */
export async function retrieveCompare(params: CompareRetrieveParams): Promise<CompareRetrieveResult> {
  const { scope, documentId, targets, topK, maxParentsPerSide } = params;

  if (scope === 'current') {
    if (documentId === null) {
      return { ok: false, message: '当前范围缺少文档，无法对比。' };
    }
    if (targets[0] === targets[1]) {
      return { ok: false, message: '请选择两个不同的章节进行对比。' };
    }

    const sides: CompareSide[] = [];
    for (const target of targets) {
      const headings = headingPathsFor(documentId, target);
      const parents =
        headings.length > 0
          ? parentsByHeadings(documentId, headings, maxParentsPerSide)
          : (await retrieve({ question: target, documentId, topK, maxParents: maxParentsPerSide })).parents;
      sides.push({ label: target, parents });
    }

    const emptyIndex = sides.findIndex((side) => side.parents.length === 0);
    if (emptyIndex !== -1) {
      return { ok: false, message: `没有在当前文档里找到「${targets[emptyIndex]}」，请写清两个章节标题。` };
    }

    return { ok: true, sides: [sides[0], sides[1]] };
  }

  const resolved = targets.map((target) => pickDocument(findDocumentRows(target), target));
  const missingIndex = resolved.findIndex((doc) => doc === null);
  if (missingIndex !== -1) {
    return { ok: false, message: `没有找到文档「${targets[missingIndex]}」，请写清两份文档的标题。` };
  }

  const first = resolved[0] as DocumentRow;
  const second = resolved[1] as DocumentRow;
  if (first.id === second.id) {
    return { ok: false, message: '请选择两篇不同的文档进行对比。' };
  }

  const sides: CompareSide[] = [];
  for (const doc of [first, second]) {
    const result = await retrieve({
      question: `${doc.title} 核心观点 主要内容`,
      documentId: doc.id,
      topK,
      maxParents: maxParentsPerSide,
    });
    sides.push({ label: doc.title, parents: result.parents });
  }

  const emptyIndex = sides.findIndex((side) => side.parents.length === 0);
  if (emptyIndex !== -1) {
    return { ok: false, message: `文档「${targets[emptyIndex]}」里没有检索到可比对的内容。` };
  }

  return { ok: true, sides: [sides[0], sides[1]] };
}
