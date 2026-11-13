import { readFile } from 'node:fs/promises';
import type { Paragraph } from '@/lib/types';
import { applyHeading, cleanHeading, headingPathOf, joinLines, markdownHeadingLevel } from './common.ts';

const LIST_ITEM = /^[-*]\s+\S/;

/**
 * 解析纯文本 / Markdown 为段落列表。
 * 页码信息不存在：page 一律 null。
 * .md 按 "#" 标题算 headingPath，列表块（连续以 "- "/"* " 开头）不拆开；其他一律 headingPath = ""。
 */
export async function parseText(textPath: string): Promise<Paragraph[]> {
  const raw = await readFile(textPath, 'utf8');
  if (raw.trim() === '') return [];

  const isMarkdown = /\.(md|markdown)$/i.test(textPath);
  const lines = raw.split(/\r?\n/);
  const paragraphs: Paragraph[] = [];

  let stack: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = joinLines(buffer);
    buffer = [];
    if (!text) return;
    paragraphs.push({ text, page: null, headingPath: headingPathOf(stack) });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      flush();
      i += 1;
      continue;
    }

    if (isMarkdown && LIST_ITEM.test(line.trim())) {
      const block: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i].trim())) {
        block.push(lines[i].trim());
        i += 1;
      }
      flush();
      paragraphs.push({ text: block.join('\n'), page: null, headingPath: headingPathOf(stack) });
      continue;
    }

    if (isMarkdown) {
      const level = markdownHeadingLevel(line.trim());
      if (level !== null) {
        flush();
        stack = applyHeading(stack, level, cleanHeading(line.trim()));
        paragraphs.push({ text: line.trim(), page: null, headingPath: headingPathOf(stack) });
        i += 1;
        continue;
      }
    }

    buffer.push(line);
    i += 1;
  }

  flush();
  return paragraphs;
}
