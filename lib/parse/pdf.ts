import { readFile } from 'node:fs/promises';
import { extractText, getDocumentProxy } from 'unpdf';
import type { Paragraph } from '@/lib/types';
import {
  applyHeading,
  cleanHeading,
  findHeadersAndFooters,
  headingLevel,
  headingPathOf,
  isTableLine,
  joinLines,
  mergeAcrossPages,
  toParagraph,
  type ParsedParagraph,
} from './common.ts';

const MIN_TEXT_CHARS = 100;

interface PageResult {
  paragraphs: ParsedParagraph[];
  stack: string[];
}

function splitPage(
  lines: string[],
  removed: Set<string>,
  pageIndex: number,
  page: number | null,
  stack: string[]
): PageResult {
  const paragraphs: ParsedParagraph[] = [];
  let nextStack = stack;
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = joinLines(buffer);
    buffer = [];
    if (!text) return;
    paragraphs.push({
      text,
      page,
      headingPath: headingPathOf(nextStack),
      isHeading: false,
      isTable: false,
    });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (removed.has(`${pageIndex}:${i}`) || line.trim() === '') {
      flush();
      i += 1;
      continue;
    }

    if (isTableLine(line)) {
      let j = i;
      const block: string[] = [];
      while (j < lines.length && !removed.has(`${pageIndex}:${j}`) && isTableLine(lines[j])) {
        block.push(lines[j].trim());
        j += 1;
      }
      // 表格：连续 2 行以上含 "|"，或单行里出现连续制表符
      if (block.length >= 2 || /\t{2,}/.test(block[0])) {
        flush();
        paragraphs.push({
          text: block.join('\n'),
          page,
          headingPath: headingPathOf(nextStack),
          isHeading: false,
          isTable: true,
        });
        i = j;
        continue;
      }
    }

    const trimmed = line.trim();
    const level = headingLevel(trimmed);
    if (level !== null) {
      flush();
      nextStack = applyHeading(nextStack, level, cleanHeading(trimmed));
      paragraphs.push({
        text: trimmed,
        page,
        headingPath: headingPathOf(nextStack),
        isHeading: true,
        isTable: false,
      });
      i += 1;
      continue;
    }

    buffer.push(line);
    i += 1;
  }

  flush();
  return { paragraphs, stack: nextStack };
}

/**
 * 解析 PDF 为段落列表。页码从 1 开始，取不到页码时为 null。
 * 无文本层（提取到的非空白字符 < 100）抛 Error('NO_TEXT_LAYER')。
 */
export async function parsePdf(pdfPath: string): Promise<Paragraph[]> {
  const buffer = await readFile(pdfPath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text: pageTexts } = await extractText(pdf, { mergePages: false });

  if (totalPages === 0 || pageTexts.length === 0) return [];

  const visibleChars = pageTexts.join('').replace(/\s+/gu, '').length;
  if (visibleChars < MIN_TEXT_CHARS) {
    throw new Error('NO_TEXT_LAYER');
  }

  const pages = pageTexts.map((text) => text.split(/\r?\n/));
  const removed = findHeadersAndFooters(pages);

  const perPage: ParsedParagraph[][] = [];
  let stack: string[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    const page = i + 1 <= totalPages ? i + 1 : null;
    const result = splitPage(pages[i], removed, i, page, stack);
    stack = result.stack;
    perPage.push(result.paragraphs);
  }

  return mergeAcrossPages(perPage).map(toParagraph);
}
