// 三种来源（PDF / DOCX / 纯文本）共用的纯函数：标题识别、页眉页脚过滤、跨页段落合并。
// 这里不依赖 unpdf、mammoth 或任何 IO。
import type { Paragraph } from '@/lib/types';

const CJK_CHAR = /[\u3000-\u9fff\uff00-\uffef]/;
const TAB_RUN = /\t{2,}/;
const SENTENCE_END = /[。！？；:：]$/;
const HEADER_FOOTER_MAX_CHARS = 40;
const HEADER_FOOTER_MIN_RUN = 3;
const HEADER_FOOTER_ZONE = 3;

/** 解析过程中的中间形态：比 Paragraph 多两个内部标记，用于跨页合并判定。 */
export interface ParsedParagraph extends Paragraph {
  isHeading: boolean;
  isTable: boolean;
}

export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

/** 只认 markdown 的 "#" 标题。 */
export function markdownHeadingLevel(line: string): number | null {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match ? match[1].length : null;
}

/**
 * 行首标题识别，返回层级；不是标题返回 null。
 * "#" 为 markdown 标题，其余为中文书籍常见编号。
 */
export function headingLevel(line: string): number | null {
  const markdown = markdownHeadingLevel(line);
  if (markdown !== null) return markdown;
  if (/^第[0-9零〇一二三四五六七八九十百千两]+章/.test(line)) return 1;
  if (/^第[0-9零〇一二三四五六七八九十百千两]+节/.test(line)) return 2;
  if (/^[一二三四五六七八九十]+、/.test(line)) return 3;
  if (/^\d+\.\d+(?:\.\d+)*(\s|、|\.\s)/.test(line)) return 4;
  if (/^\d+[.、]\s*\S/.test(line)) return 3;
  return null;
}

export function cleanHeading(line: string): string {
  return line.trim().replace(/^#{1,6}\s*/, '');
}

/** 标题入栈：截断到当前层级，再写入本层，深层标题自动出栈。 */
export function applyHeading(stack: string[], level: number, title: string): string[] {
  const next = stack.slice(0, level - 1);
  next[level - 1] = title;
  return next;
}

export function headingPathOf(stack: string[]): string {
  return stack.filter((part): part is string => Boolean(part)).join(' > ');
}

/** 同一段内的折行拼接：中英/中日边界不加空格，其余补一个空格。 */
export function joinLines(lines: string[]): string {
  let merged = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!merged) {
      merged = line;
      continue;
    }
    const prevChar = merged.slice(-1);
    const nextChar = line.slice(0, 1);
    merged += CJK_CHAR.test(prevChar) || CJK_CHAR.test(nextChar) ? line : ` ${line}`;
  }
  return merged;
}

export function isTableLine(line: string): boolean {
  return line.includes('|') || TAB_RUN.test(line);
}

/**
 * 页眉页脚：同一文本在连续 3 页以上、处于页面相同位置（前 3 行 / 后 3 行）且长度小于 40 字。
 * 返回需要丢弃的 "页索引:行索引" 集合。
 */
export function findHeadersAndFooters(pages: string[][]): Set<string> {
  const occurrences = new Map<string, Map<number, number>>();

  pages.forEach((lines, pageIndex) => {
    const slots: Array<{ lineIndex: number; slot: string }> = [];
    const headEnd = Math.min(HEADER_FOOTER_ZONE, lines.length);
    for (let i = 0; i < headEnd; i += 1) slots.push({ lineIndex: i, slot: `top:${i}` });
    const tailStart = Math.max(0, lines.length - HEADER_FOOTER_ZONE);
    for (let i = lines.length - 1; i >= tailStart; i -= 1) {
      slots.push({ lineIndex: i, slot: `bottom:${lines.length - 1 - i}` });
    }

    for (const { lineIndex, slot } of slots) {
      const normalized = normalizeLine(lines[lineIndex]);
      if (!normalized || normalized.length >= HEADER_FOOTER_MAX_CHARS) continue;
      const key = `${slot}|${normalized}`;
      const pageMap = occurrences.get(key) ?? new Map<number, number>();
      pageMap.set(pageIndex, lineIndex);
      occurrences.set(key, pageMap);
    }
  });

  const removed = new Set<string>();
  for (const pageMap of occurrences.values()) {
    const pageIndexes = [...pageMap.keys()].sort((a, b) => a - b);
    let runStart = 0;
    for (let i = 1; i <= pageIndexes.length; i += 1) {
      const broken = i === pageIndexes.length || pageIndexes[i] !== pageIndexes[i - 1] + 1;
      if (!broken) continue;
      const run = pageIndexes.slice(runStart, i);
      if (run.length >= HEADER_FOOTER_MIN_RUN) {
        for (const pageIndex of run) {
          removed.add(`${pageIndex}:${pageMap.get(pageIndex)}`);
        }
      }
      runStart = i;
    }
  }
  return removed;
}

/** 跨页断句：上页末段没有句末标点、下页首段不是标题/表格时合并，page 取上一页。 */
function canMergeAcrossPages(prev: ParsedParagraph, next: ParsedParagraph): boolean {
  if (prev.isTable || next.isTable) return false;
  // 标题已经单独成段，剩下的小写开头 / 非标题开头都允许合并
  if (next.isHeading) return false;
  return !SENTENCE_END.test(prev.text);
}

/** 按页顺序合并跨页断句，返回新的数组，不修改入参。 */
export function mergeAcrossPages(perPage: ParsedParagraph[][]): ParsedParagraph[] {
  const merged: ParsedParagraph[] = [];
  for (const list of perPage) {
    if (list.length === 0) continue;
    const prev = merged[merged.length - 1];
    if (prev && canMergeAcrossPages(prev, list[0])) {
      merged[merged.length - 1] = { ...prev, text: joinLines([prev.text, list[0].text]) };
      merged.push(...list.slice(1));
      continue;
    }
    merged.push(...list);
  }
  return merged;
}

/** 去掉内部标记，产出对外契约 Paragraph。 */
export function toParagraph(paragraph: ParsedParagraph): Paragraph {
  return { text: paragraph.text, page: paragraph.page, headingPath: paragraph.headingPath };
}
