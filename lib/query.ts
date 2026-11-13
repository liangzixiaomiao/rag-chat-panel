// 查询改写：调 DeepSeek 的 OpenAI 兼容接口，把口语化问题改成适合语义检索的表述。
// 任何异常都降级成原始问题，绝不把错误抛给上层。
import { estimateTokens } from './embed.ts';
import { canSpend, recordUsage } from './guard.ts';

const SYSTEM_PROMPT =
  '把用户的问题改写成适合语义检索的标准表述：补全指代和缺失的背景，去掉口语化表达和情绪词，专有名词、编号、章节号原样保留。只输出改写后的查询语句，不要解释，不要加引号。';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const MODEL = 'deepseek-chat';
const TIMEOUT_MS = 8000;
const MAX_OUTPUT_TOKENS = 60;
const MAX_QUERY_CHARS = 200;

const PREFIXES = [
  /^改写(后)?\s*[:：]\s*/,
  /^查询(语句)?\s*[:：]\s*/,
  /^检索(式|语句)?\s*[:：]\s*/,
  /^Query\s*[:：]\s*/i,
];

// 出现这些词说明模型在解释而不是只输出查询语句
const EXPLANATORY = ['这个问题是', '这个问题的意思', '用户的问题是', '用户想', '您的问题是', '该问题是', '以下是', '改写后', '这句话的'];

interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export interface RewriteInput {
  question: string;
  history?: HistoryItem[];
}

export interface RewriteResult {
  query: string;
  rewritten: boolean;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
}

function buildUserContent(question: string, history?: HistoryItem[]): string {
  const recent = (history ?? []).slice(-4);
  if (recent.length === 0) return question;
  const lines = recent.map((item) => `${item.role === 'user' ? '用户' : '助手'}：${item.content}`);
  return `最近两轮对话：\n${lines.join('\n')}\n\n当前问题：${question}`;
}

/** 去掉换行、首尾引号、常见前缀；不做语义改写。 */
function cleanQuery(raw: string): string {
  let text = raw.replace(/\r?\n/g, '').trim();
  text = text.replace(/^["'“”「」『』]+/, '').replace(/["'“”「」『』]+$/, '').trim();
  for (const prefix of PREFIXES) {
    text = text.replace(prefix, '').trim();
  }
  text = text.replace(/^["'“”「」『』]+/, '').replace(/["'“”「」『』]+$/, '').trim();
  return text;
}

function isValidQuery(text: string): boolean {
  if (text === '') return false;
  if (text.length > MAX_QUERY_CHARS) return false;
  return !EXPLANATORY.some((phrase) => text.includes(phrase));
}

/**
 * 改写用户问题。失败 / 超时 / 空返回 / 超长 / 像解释 → 原样返回问题并标记 rewritten=false。
 */
export async function rewriteQuery(input: RewriteInput): Promise<RewriteResult> {
  const question = input.question ?? '';
  const fallback: RewriteResult = { query: question, rewritten: false };

  if (question.trim() === '') return { query: '', rewritten: false };

  try {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY');

    const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const userContent = buildUserContent(question, input.history);
    const estimatedTokens = estimateTokens([SYSTEM_PROMPT, userContent]) + MAX_OUTPUT_TOKENS;

    if (!canSpend(estimatedTokens)) throw new Error('今日 LLM 额度已用完');

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, TIMEOUT_MS);

    let raw = '';
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          temperature: 0,
          max_tokens: MAX_OUTPUT_TOKENS,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`DeepSeek 返回 ${response.status}：${await response.text()}`);
      }

      const data = (await response.json()) as ChatCompletionResponse;
      recordUsage(data.usage?.total_tokens ?? estimatedTokens);
      raw = data.choices?.[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }

    const query = cleanQuery(raw);
    if (!isValidQuery(query)) return fallback;

    return { query, rewritten: true };
  } catch {
    return fallback;
  }
}
