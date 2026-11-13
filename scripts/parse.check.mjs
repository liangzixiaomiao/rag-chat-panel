// 解析验收：node scripts/parse.check.mjs path/to/book.pdf（也支持 .docx / .md / .txt）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { parsePdf } from '../lib/parse/pdf.ts';
import { parseDocx } from '../lib/parse/docx.ts';
import { parseText } from '../lib/parse/text.ts';

const target = process.argv[2];

if (!target) {
  console.error('用法: node scripts/parse.check.mjs <file.pdf|file.docx|file.md|file.txt>');
  process.exit(1);
}

const absPath = resolve(target);
const ext = extname(absPath).toLowerCase();

const parsers = {
  '.pdf': parsePdf,
  '.docx': parseDocx,
  '.md': parseText,
  '.markdown': parseText,
  '.txt': parseText,
};

const parser = parsers[ext];

if (!parser) {
  console.error(`不支持的文件类型：${ext}（支持 .pdf / .docx / .md / .txt）`);
  process.exit(1);
}

const paragraphs = await parser(absPath);

const pageCount = paragraphs.reduce((max, item) => (item.page === null ? max : Math.max(max, item.page)), 0);
const headingPaths = [...new Set(paragraphs.map((item) => item.headingPath))];

console.log(`file         = ${absPath}`);
console.log(`paragraphs   = ${paragraphs.length}`);
console.log(`pages        = ${pageCount}${pageCount === 0 ? '（无页码信息）' : ''}`);
console.log(`headingPaths = ${headingPaths.length}`);
for (const path of headingPaths) {
  console.log(`  - ${path === '' ? '(空)' : path}`);
}

const samples = [...new Set([0, 99, paragraphs.length - 10])].filter(
  (index) => index >= 0 && index < paragraphs.length
);

for (const index of samples) {
  const item = paragraphs[index];
  console.log(`--- #${index + 1} page=${item.page} heading=${item.headingPath === '' ? '(空)' : item.headingPath}`);
  console.log(item.text);
}

await mkdir('out', { recursive: true });
const jsonPath = 'out/paragraphs.json';
await writeFile(jsonPath, JSON.stringify(paragraphs, null, 2), 'utf8');

const roundTrip = JSON.parse(await readFile(jsonPath, 'utf8'));
console.log(`json         = ${jsonPath}（${roundTrip.length} 条，JSON.parse 通过）`);
