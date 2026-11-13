// 引用校验：模型只给 refId + quote，页码/标题一律由父块回填。
import type { Citation, Retrieved } from './types.ts';

const MAX_QUOTE_CHARS = 200;
const SENTENCE_END = '。！？；.!?;';

function truncateAtSentence(quote: string): string {
  if (quote.length <= MAX_QUOTE_CHARS) return quote;
  const head = quote.slice(0, MAX_QUOTE_CHARS);
  for (let index = head.length - 1; index >= 0; index -= 1) {
    if (SENTENCE_END.includes(head[index])) return head.slice(0, index + 1);
  }
  return head;
}

/**
 * 只保留能逐字对上父块原文的引用；refId 越界、quote 对不上、格式不对的都丢弃。
 */
export function validateCitations(raw: unknown, parents: Retrieved[]): Citation[] {
  if (!Array.isArray(raw)) return [];

  const result: Citation[] = [];

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as { refId?: unknown; quote?: unknown };
    if (typeof record.refId !== 'number' || !Number.isInteger(record.refId)) continue;
    if (typeof record.quote !== 'string') continue;
    if (record.refId < 1 || record.refId > parents.length) continue;

    const parent = parents[record.refId - 1];
    if (!parent.fullContext.includes(record.quote)) continue;

    const quote = truncateAtSentence(record.quote.trim());
    if (quote === '') continue;

    result.push({
      refId: record.refId,
      quote,
      pageFrom: parent.pageFrom,
      headingPath: parent.headingPath,
      documentTitle: parent.documentTitle,
    });
  }

  return result;
}
