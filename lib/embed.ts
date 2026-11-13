import { canSpend, QuotaError, recordUsage } from './guard.ts';

// 方案 B（本地向量）：全项目唯一的维度定义，其他文件一律引用这个常量。
export const EMBED_DIMS = 512;
// 方案 B 暂未接真实模型，先用确定性 Hash 向量跑通流程；换成 bge-small-zh-v1.5 时只改这一处。
export const EMBED_MODEL = 'local-hash-512';

const MAX_BATCH = 20;
const BATCH_DELAY_MS = 100;
const MAX_RETRIES = 2;
const MAX_INPUT_CHARS = 4000;

const CJK_CHAR = /[\u3000-\u9fff\uff00-\uffef]/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function estimateOne(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 本地 token 估算：CJK 一字一 token，其余字符 4 个一 token。 */
export function estimateTokens(texts: string[]): number {
  return texts.reduce((total, text) => total + estimateOne(text), 0);
}

function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 中文按单字 + 相邻二元组，英文/数字按单词，保证同一文本得到同一向量。 */
function tokenize(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = normalized.match(/[a-z0-9]+/g) ?? [];
  const cjk = normalized.match(/[\u3400-\u9fff]/g) ?? [];
  for (let i = 0; i < cjk.length; i += 1) {
    tokens.push(cjk[i]);
    if (i + 1 < cjk.length) tokens.push(`${cjk[i]}${cjk[i + 1]}`);
  }
  return tokens;
}

/** L2 归一化：方案 B 的本地向量必须归一化，入库与查询共用这一条路径。 */
function l2Normalize(vector: number[]): number[] {
  let squareSum = 0;
  for (const value of vector) squareSum += value * value;
  if (squareSum === 0) {
    throw new Error('文本没有可用 token，无法生成向量（空文本请在上游过滤）');
  }
  const norm = Math.sqrt(squareSum);
  return vector.map((value) => value / norm);
}

function embedOne(text: string): number[] {
  const vector = new Array<number>(EMBED_DIMS).fill(0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const index = hash % EMBED_DIMS;
    const sign = hash >>> 31 === 1 ? -1 : 1;
    vector[index] += sign * (1 + Math.log1p(token.length));
  }
  return l2Normalize(vector);
}

function embedBatch(texts: string[]): number[][] {
  return texts.map((text) => embedOne(text));
}

/** 最多重试 2 次，指数退避；重试次数固定，不会无限循环。 */
async function embedBatchWithRetry(texts: string[]): Promise<number[][]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return embedBatch(texts);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      await sleep(BATCH_DELAY_MS * 2 ** attempt);
    }
  }
  const stack = lastError instanceof Error ? lastError.stack ?? lastError.message : String(lastError);
  throw new Error(`本地 embedding 生成失败（已重试 ${MAX_RETRIES} 次）\n${stack}`, { cause: lastError });
}

/**
 * 入库与查询唯一的 embedding 入口。
 * 空数组返回 []；单条超长直接报错不截断；额度不足抛 QuotaError。
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  texts.forEach((text, index) => {
    if (text.length > MAX_INPUT_CHARS) {
      throw new Error(
        `第 ${index + 1} 条文本 ${text.length} 字符，超过 ${MAX_INPUT_CHARS} 上限；请先切分，embedding 层不做截断`
      );
    }
  });

  const estimated = estimateTokens(texts);
  if (!canSpend(estimated)) {
    throw new QuotaError('今日 embedding 额度已用完');
  }

  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += MAX_BATCH) {
    if (start > 0) await sleep(BATCH_DELAY_MS);
    const batch = texts.slice(start, start + MAX_BATCH);
    const batchVectors = await embedBatchWithRetry(batch);
    if (batchVectors.length !== batch.length) {
      throw new Error(`embedding 返回条数 ${batchVectors.length} 与输入 ${batch.length} 不一致`);
    }
    vectors.push(...batchVectors);
  }

  if (vectors.length !== texts.length) {
    throw new Error(`embedding 返回条数 ${vectors.length} 与输入 ${texts.length} 不一致`);
  }

  vectors.forEach((vector, index) => {
    if (vector.length !== EMBED_DIMS) {
      throw new Error(`第 ${index + 1} 条向量维度 ${vector.length}，期望 ${EMBED_DIMS}；不做静默截断`);
    }
  });

  recordUsage(estimated);
  return vectors;
}
