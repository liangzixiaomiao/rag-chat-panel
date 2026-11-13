import { readFile } from 'node:fs/promises';
import mammoth from 'mammoth';
import type { Paragraph } from '@/lib/types';
import { applyHeading, headingPathOf, normalizeLine } from './common.ts';

interface HtmlHeading {
  level: number;
  text: string;
}

const HEADING_TAG = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
const ANY_TAG = /<[^>]+>/g;
const ENTITIES: Array<[RegExp, string]> = [
  [/&nbsp;/g, ' '],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&amp;/g, '&'],
];

function decodeHtml(value: string): string {
  return ENTITIES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

/** 从 mammoth 的 HTML 里按文档顺序抽出 h1~h6。 */
function extractHeadings(html: string): HtmlHeading[] {
  const headings: HtmlHeading[] = [];
  for (const match of html.matchAll(HEADING_TAG)) {
    const text = decodeHtml(match[2].replace(ANY_TAG, '')).trim();
    if (!text) continue;
    headings.push({ level: Number(match[1]), text });
  }
  return headings;
}

/**
 * 解析 DOCX 为段落列表。
 * DOCX 没有可靠的页码信息：page 一律 null；headingPath 来自 Word 的标题样式（h1~h6），
 * 文档没有标题样式时全部为 ""。
 */
export async function parseDocx(docxPath: string): Promise<Paragraph[]> {
  const buffer = await readFile(docxPath);
  const { value: rawText } = await mammoth.extractRawText({ buffer });

  const blocks = rawText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) return [];

  const { value: html } = await mammoth.convertToHtml({ buffer });
  const headings = extractHeadings(html);

  let cursor = 0;
  let stack: string[] = [];
  const paragraphs: Paragraph[] = [];

  for (const block of blocks) {
    const key = normalizeLine(block);
    if (cursor < headings.length && normalizeLine(headings[cursor].text) === key) {
      stack = applyHeading(stack, headings[cursor].level, headings[cursor].text);
      cursor += 1;
    }
    paragraphs.push({ text: block, page: null, headingPath: headingPathOf(stack) });
  }

  return paragraphs;
}
