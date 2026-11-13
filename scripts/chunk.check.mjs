// 切块验收：node scripts/chunk.check.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { chunkText } from '../lib/chunk.ts';

const sentence = (length) => '文'.repeat(length - 1) + '。';
const body = (length) => sentence(length / 2) + sentence(length / 2);

const cases = [
  { name: '1 空数组', input: [] },
  { name: '2 单句', input: [{ text: '你好。', page: 1, headingPath: '' }] },
  {
    name: '3 两个 headingPath',
    input: [
      { text: '第一节的正文。', page: 1, headingPath: '第一章' },
      { text: '第二节的正文。', page: 2, headingPath: '第二章' },
    ],
  },
  {
    name: '4 1200 字连续正文',
    input: [{ text: Array.from({ length: 6 }, () => sentence(200)).join(''), page: 1, headingPath: 'A' }],
  },
  {
    name: '5 1800 字同一标题',
    input: Array.from({ length: 6 }, (_, index) => ({ text: sentence(300), page: index + 1, headingPath: 'A' })),
  },
  {
    name: '6 代码块 200 + 前后各 400',
    input: [
      { text: body(400), page: 1, headingPath: 'A' },
      { text: `\`\`\`\n${'x'.repeat(190)}\n\`\`\``, page: 2, headingPath: 'A' },
      { text: body(400), page: 3, headingPath: 'A' },
    ],
  },
  {
    name: '7 表格 3 行 + 前后正文',
    input: [
      { text: body(400), page: 1, headingPath: 'A' },
      { text: '| 名称 | 值 |\n| a | 1 |\n| b | 2 |', page: 2, headingPath: 'A' },
      { text: body(400), page: 3, headingPath: 'A' },
    ],
  },
  {
    name: '8 无句末标点 3000 字',
    input: Array.from({ length: 10 }, (_, index) => ({ text: '文'.repeat(300), page: index + 1, headingPath: 'A' })),
  },
];

const textLength = (value) => [...value].length;
const isAtomic = (content) => content.includes('```') || content.split('\n').filter((line) => line.includes('|')).length >= 2;

let failed = 0;
const dump = [];

for (const testCase of cases) {
  const parents = chunkText(testCase.input);
  dump.push({ case: testCase.name, parents });
  const children = parents.flatMap((parent) => parent.children);
  const chars = children.reduce((sum, child) => sum + textLength(child.content), 0);
  const problems = [];

  const source = testCase.input.filter((item) => item.text.trim() !== '');
  const expected = source.map((item) => item.text).join('\n\n');
  const rebuilt = parents.map((parent) => parent.fullContext).join('\n\n');
  if (rebuilt !== expected) problems.push('fullContext 与原文不一致');

  parents.forEach((parent, index) => {
    if (parent.parentIndex !== index) problems.push(`parentIndex 不连续：${parent.parentIndex}`);
    if (parent.children.length === 0) problems.push(`父块 ${index} 没有子块`);
    parent.children.forEach((child, childIndex) => {
      if (child.chunkIndex !== childIndex) problems.push(`chunkIndex 不连续：${child.chunkIndex}`);
      if (child.content.trim() === '') problems.push('出现空子块');
      if (/[，、,]$/.test(child.content)) problems.push(`子块以顿逗号结尾：${child.content.slice(-8)}`);
      const tooSmall = textLength(child.content) < 50;
      if (tooSmall && parent.children.length > 1 && !isAtomic(child.content)) {
        problems.push(`碎块 ${textLength(child.content)} 字：${child.content.slice(0, 12)}`);
      }
      if (!isAtomic(child.content) && textLength(child.content) > 500) {
        problems.push(`子块超过 500 字：${textLength(child.content)}`);
      }
      if (!Number.isFinite(child.tokenCount) || child.tokenCount <= 0) problems.push('tokenCount 非法');
    });
  });

  if (testCase.name.startsWith('3') && parents.length !== 2) problems.push(`期望 2 个父块，实际 ${parents.length}`);
  if (testCase.name.startsWith('5') && parents.length !== 2) problems.push(`期望 2 个父块，实际 ${parents.length}`);
  if (testCase.name.startsWith('4')) {
    parents.forEach((parent) => {
      parent.children.forEach((child) => {
        const length = textLength(child.content);
        if (length < 300 || length > 500) problems.push(`子块 ${length} 字不在 300-500`);
      });
    });
  }
  if (testCase.name.startsWith('6') || testCase.name.startsWith('7')) {
    const marker = testCase.name.startsWith('6') ? '```' : '| 名称 | 值 |';
    const blocks = children.filter((child) => child.content.includes(marker));
    if (blocks.length !== 1) problems.push(`整块标记出现在 ${blocks.length} 个子块里`);
  }

  if (problems.length === 0) {
    console.log(`PASS ${testCase.name} → 父块 ${parents.length} / 子块 ${children.length} / ${chars} 字`);
  } else {
    failed += 1;
    console.log(`FAIL ${testCase.name} → 父块 ${parents.length} / 子块 ${children.length} / ${chars} 字`);
    for (const problem of problems) console.log(`     - ${problem}`);
  }
}

mkdirSync('out', { recursive: true });
const jsonPath = 'out/chunks.json';
writeFileSync(jsonPath, JSON.stringify(dump, null, 2), 'utf8');
const totalParents = dump.reduce((sum, item) => sum + item.parents.length, 0);
const totalChildren = dump.reduce(
  (sum, item) => sum + item.parents.reduce((acc, parent) => acc + parent.children.length, 0),
  0
);
console.log(`json         = ${jsonPath}（${dump.length} 组用例 / ${totalParents} 个父块 / ${totalChildren} 个子块）`);

if (failed > 0) {
  console.error(`\n${failed} 个用例未通过`);
  process.exit(1);
}

console.log('\n全部用例通过');
