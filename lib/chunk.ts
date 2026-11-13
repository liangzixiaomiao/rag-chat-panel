import { estimateTokens } from './embed.ts';
import type { Chunk, ParentChunk, Paragraph } from './types.ts';

const PARENT_SOFT_MAX = 1000;
const PARENT_HARD_MAX = 1500;
const CHILD_TARGET = 400;
const CHILD_MAX = 500;
const MIN_CHILD = 50;
const PARAGRAPH_SEP = '\n\n';

interface Atom {
  text: string;
  sep: string;
  page: number | null;
  atomic: boolean;
}

function atomsToText(atoms: Atom[]): string {
  let text = '';
  atoms.forEach((atom, index) => {
    text += (index === 0 ? '' : atom.sep) + atom.text;
  });
  return text;
}

function isTableBlock(text: string): boolean {
  let run = 0;
  for (const line of text.split('\n')) {
    if (line.includes('|')) {
      run += 1;
      if (run >= 2) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

function isCodeBlock(text: string): boolean {
  return text.includes('```');
}

/** 段落 → 原子：表格/代码块整块一个原子，其余按句末标点切。 */
function paragraphAtoms(paragraph: Paragraph): Atom[] {
  if (isTableBlock(paragraph.text) || isCodeBlock(paragraph.text)) {
    return [{ text: paragraph.text, sep: '', page: paragraph.page, atomic: true }];
  }
  return paragraph.text
    .split(/(?<=[。！？；])/)
    .filter((piece) => piece.length > 0)
    .map((piece) => ({ text: piece, sep: '', page: paragraph.page, atomic: false }));
}

function pageRange(pages: Array<number | null>): { from: number; to: number } {
  const valid = pages.filter((page): page is number => page !== null);
  if (valid.length === 0) return { from: 0, to: 0 };
  return { from: Math.min(...valid), to: Math.max(...valid) };
}

/** 父块：只在段落边界断开；累计到 1000 字收尾，单段顶到 1500 前先收尾。 */
function packParents(section: Paragraph[]): Atom[][] {
  const parents: Atom[][] = [];
  let current: Atom[] = [];
  let length = 0;

  for (const paragraph of section) {
    const atoms = paragraphAtoms(paragraph);
    const paragraphLength = atoms.reduce((sum, atom) => sum + atom.text.length, 0);
    const addLength = current.length === 0 ? paragraphLength : length + PARAGRAPH_SEP.length + paragraphLength;

    if (current.length > 0 && addLength > PARENT_HARD_MAX) {
      parents.push(current);
      current = [];
      length = 0;
    }
    if (current.length > 0) {
      atoms[0] = { ...atoms[0], sep: PARAGRAPH_SEP };
      length += PARAGRAPH_SEP.length;
    }
    current.push(...atoms);
    length += paragraphLength;

    if (length >= PARENT_SOFT_MAX) {
      parents.push(current);
      current = [];
      length = 0;
    }
  }

  if (current.length > 0) parents.push(current);
  return parents;
}

/** 子块：目标 400 字，超过 500 前收；表格/代码块独立成块且不切。 */
function packChildren(atoms: Atom[]): Atom[][] {
  const children: Atom[][] = [];
  let current: Atom[] = [];
  let length = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    children.push(current);
    current = [];
    length = 0;
  };

  for (const atom of atoms) {
    if (atom.atomic) {
      flush();
      children.push([atom]);
      continue;
    }

    const addLength = current.length === 0 ? atom.text.length : length + atom.sep.length + atom.text.length;
    if (current.length > 0 && addLength > CHILD_MAX) flush();

    current.push(atom);
    length = current.length === 1 ? atom.text.length : length + atom.sep.length + atom.text.length;

    if (length >= CHILD_TARGET) flush();
  }

  flush();
  return mergeTinyChildren(children);
}

/** 不足 50 字的碎块：优先并进下一块，末尾并进上一块；不往表格/代码块里塞。 */
function mergeTinyChildren(children: Atom[][]): Atom[][] {
  const pending = children.map((child) => [...child]);
  let index = 0;

  while (index < pending.length) {
    const child = pending[index];
    const isAtomic = child.length === 1 && child[0].atomic;
    if (isAtomic || atomsToText(child).length >= MIN_CHILD) {
      index += 1;
      continue;
    }

    if (index + 1 < pending.length) {
      const next = pending[index + 1];
      if (next.length === 1 && next[0].atomic) {
        index += 1;
        continue;
      }
      pending[index + 1] = [...child, ...next];
      pending.splice(index, 1);
      continue;
    }

    if (index > 0) {
      pending[index - 1] = [...pending[index - 1], ...child];
      pending.splice(index, 1);
      index -= 1;
      continue;
    }

    index += 1;
  }

  return pending;
}

function buildChunk(atoms: Atom[], chunkIndex: number): Chunk {
  const content = atomsToText(atoms);
  const { from, to } = pageRange(atoms.map((atom) => atom.page));
  return {
    content,
    pageFrom: from,
    pageTo: to,
    chunkIndex,
    tokenCount: estimateTokens([content]),
  };
}

/**
 * 段落 → 父块 / 子块。纯函数、无 IO。
 * 父块按 headingPath 分段，子块不重叠，切点只落在句末标点或段落边界。
 */
export function chunkText(paragraphs: Paragraph[]): ParentChunk[] {
  const source = paragraphs.filter((paragraph) => paragraph.text.trim() !== '');
  if (source.length === 0) return [];

  const sections: Paragraph[][] = [];
  for (const paragraph of source) {
    const last = sections[sections.length - 1];
    if (last && last[0].headingPath === paragraph.headingPath) {
      last.push(paragraph);
    } else {
      sections.push([paragraph]);
    }
  }

  const result: ParentChunk[] = [];

  for (const section of sections) {
    for (const atoms of packParents(section)) {
      const children = packChildren(atoms).map((child, index) => buildChunk(child, index));
      const { from, to } = pageRange(atoms.map((atom) => atom.page));

      result.push({
        parentIndex: result.length,
        headingPath: section[0].headingPath,
        pageFrom: from,
        pageTo: to,
        fullContext: atomsToText(atoms),
        children,
      });
    }
  }

  return result;
}
