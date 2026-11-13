// 改写验收：node scripts/rewrite.check.mjs
import { rewriteQuery } from '../lib/query.ts';

const cases = [
  { label: '口语化', question: '那个缓存的东西为啥老失效啊' },
  {
    label: '指代消解',
    question: '第二点呢',
    history: [
      { role: 'user', content: '说说缓存失效的原因和解决方案' },
      { role: 'assistant', content: '第一点是过期时间过于集中；第二点是缓存击穿导致请求回源。' },
    ],
  },
  { label: '保留章节号', question: '4.2 节说的默认超时是多少' },
  { label: '保留专有名词', question: 'Redis 的 maxmemory-policy 有哪几种' },
  { label: '空串', question: '' },
  {
    label: '本来就很规范',
    question: '在 SQLite 中使用 vec0 虚拟表做向量检索时，topK 参数与分区键 document_id 的过滤顺序会影响召回数量吗',
  },
];

const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);
console.log(`DEEPSEEK_API_KEY = ${hasKey ? '已配置' : '未配置（全部会走降级）'}`);
console.log(`DEEPSEEK_BASE_URL = ${process.env.DEEPSEEK_BASE_URL ?? '(默认 https://api.deepseek.com)'}\n`);

for (const item of cases) {
  const startedAt = Date.now();
  const result = await rewriteQuery({ question: item.question, history: item.history });
  const elapsed = Date.now() - startedAt;

  console.log(`[${item.label}] ${elapsed} ms｜rewritten=${result.rewritten}`);
  console.log(`  原问题 : ${item.question === '' ? '(空串)' : item.question}`);
  console.log(`  改写后 : ${result.query === '' ? '(空串)' : result.query}`);
  if (item.history) {
    console.log(`  带入历史: ${item.history.map((entry) => `${entry.role}:${entry.content.slice(0, 12)}`).join(' | ')}`);
  }
  console.log('');
}
