// 提示词验收：node scripts/prompt.check.mjs
import { buildContextBlock, buildMessages, buildSystemPrompt } from '../lib/prompt.ts';
import { estimateTokens } from '../lib/embed.ts';

const makeParent = (parentIndex, headingPath, fullContext, similarity) => ({
  chunkId: parentIndex + 1,
  documentId: 'demo-doc',
  content: fullContext.slice(0, 40),
  fullContext,
  headingPath,
  pageFrom: parentIndex + 1,
  pageTo: parentIndex + 2,
  parentIndex,
  similarity,
});

const parents = [
  makeParent(0, '第三章 缓存', '缓存击穿是指热点 key 过期瞬间大量请求穿透到数据库。处理方式是加互斥锁，只允许一个请求回源。', 0.82),
  makeParent(1, '第三章 缓存 > 3.2 失效', '缓存失效的常见原因包括过期时间集中、缓存雪崩、以及缓存穿透。', 0.71),
  makeParent(2, null, 'Redis 的 maxmemory-policy 支持 noeviction、allkeys-lru、volatile-lru 等策略。', 0.64),
];

const title = (text) => `\n=== ${text} ===`;

console.log(title('1. system prompt'));
const system = buildSystemPrompt();
console.log(system);
const ruleCount = (system.match(/^\d\. /gm) ?? []).length;
console.log(`铁律条数 = ${ruleCount}（期望 5）`);

console.log(title('2. 上下文块'));
const block = buildContextBlock(parents);
console.log(block);
const numbers = [...block.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
console.log(`编号 = ${numbers.join(',')}（期望 1,2,3 连续）`);
console.log(`含页码泄漏（"第 X 页"）= ${/第\s*\d+\s*页|page\s*\d+/i.test(block)}（期望 false）`);

console.log(title('3. 最终 messages'));
const messages = buildMessages({
  question: '缓存为什么会失效',
  parents,
  history: [
    { role: 'user', content: '我在看第三章' },
    { role: 'assistant', content: '第三章讲缓存。' },
  ],
});
console.log(JSON.stringify(messages, null, 2));
console.log(`roles = ${messages.map((item) => item.role).join(',')}`);

console.log(title('4. 边界'));
console.log(`空 parents → ${JSON.stringify(buildContextBlock([]))}`);

const history = Array.from({ length: 6 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `第${index + 1}条历史`,
}));
const trimmed = buildMessages({ question: '问题', parents, history });
console.log(`history 6 条 → 实际带入 ${trimmed.length - 2} 条：${trimmed.slice(1, -1).map((item) => item.content).join(' | ')}`);

const huge = Array.from({ length: 5 }, (_, index) =>
  makeParent(index, `第${index + 1}节`, '长'.repeat(3000), 0.9 - index * 0.1)
);
const hugeBlock = buildContextBlock(huge);
const hugeNumbers = [...hugeBlock.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
console.log(
  `5 个超大父块 → 保留 ${hugeNumbers.length} 块，编号 ${hugeNumbers.join(',')}，约 ${estimateTokens([hugeBlock])} token（上限 10000）`
);
console.log(`末尾有没有截断提示 = ${/截断|省略|truncat/i.test(hugeBlock)}（期望 false）`);
