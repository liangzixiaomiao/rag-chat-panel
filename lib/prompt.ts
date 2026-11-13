// 提示词拼装：只拼字符串，不调模型、不碰数据库、不读环境变量。
import { estimateTokens } from './embed.ts';
import type { Retrieved } from './types.ts';

const CONTEXT_TOKEN_LIMIT = 10000;
const MIN_PARENTS = 3;
const BLOCK_SEPARATOR = '\n\n---\n\n';
const MAX_HISTORY = 4;

/**
 * 铁律原样保留，不增不减。
 */
export function buildSystemPrompt(): string {
  return [
    '你是知识库问答助手。只依据下面提供的【资料】回答。',
    '',
    '【铁律】',
    '1. 只使用【资料】里的内容。资料里没有的信息，直接说"知识库里没有找到相关内容"，不要用常识或推测补充。',
    '2. 先在【资料】中找到所有能支撑结论的原文片段，再基于这些片段组织答案。不要先想好结论再找依据，不要凭空推导。',
    '3. 每个结论后面标注它依据的片段编号，如 [3]；一句话涉及多个片段就标多个。',
    '4. 如果不同片段的信息存在矛盾或不一致，明确指出分歧点、各自出自哪个片段，不要自行统一成一个结论。',
    '5. 不要写页码、不要写文件名、不要写"第几章"。出处信息由系统根据编号回填。',
  ].join('\n');
}

function renderBlock(index: number, parent: Retrieved): string {
  const header = parent.headingPath ? `[${index}] ${parent.headingPath}` : `[${index}]`;
  return `${header}\n${parent.fullContext}`;
}

function renderContext(parents: Retrieved[]): string {
  const blocks = parents.map((parent, index) => renderBlock(index + 1, parent));
  return `【资料】\n${blocks.join(BLOCK_SEPARATOR)}`;
}

/**
 * 拼【资料】块：编号从 1 开始，只带 headingPath，不带页码。
 * 超过 10000 token 时按相似度从低到高丢块，至少保留 3 块，不做截断提示。
 */
export function buildContextBlock(parents: Retrieved[]): string {
  if (parents.length === 0) return '【资料】\n（无）';

  let kept = [...parents];
  while (kept.length > MIN_PARENTS && estimateTokens([renderContext(kept)]) > CONTEXT_TOKEN_LIMIT) {
    let lowest = 0;
    for (let index = 1; index < kept.length; index += 1) {
      if (kept[index].similarity < kept[lowest].similarity) lowest = index;
    }
    kept = kept.filter((_, index) => index !== lowest);
  }

  return renderContext(kept);
}

export function buildMessages(params: {
  question: string;
  parents: Retrieved[];
  history: { role: 'user' | 'assistant'; content: string }[];
}): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const history = params.history.slice(-MAX_HISTORY);
  const context = buildContextBlock(params.parents);

  return [
    { role: 'system', content: buildSystemPrompt() },
    ...history.map((item) => ({ role: item.role, content: item.content })),
    { role: 'user', content: `${context}\n\n【问题】\n${params.question}` },
  ];
}
