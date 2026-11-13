// 本地 embedding：bge-small-zh-v1.5（Transformers.js + onnxruntime-node，CPU 推理）。
// 入库与查询共用本文件；向量维度只在这里定义一次。
import path from 'node:path';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { QuotaError, canSpend, recordUsage } from './guard.ts';

export const EMBED_DIMS = 512;
export const EMBED_MODEL = 'Xenova/bge-small-zh-v1.5';

const MAX_INPUT_CHARS = 4000;
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 100;
const MODEL_DIR = path.join(process.cwd(), 'out', 'models');

interface TransformersEnv {
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  localModelPath: string;
  cacheDir: string;
}

interface TransformersModule {
  env: TransformersEnv;
  pipeline: (task: string, model: string, options?: Record<string, boolean | string>) => Promise<unknown>;
}

let transformersPromise: Promise<TransformersModule> | null = null;
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * 运行时动态解析包名：Turbopack 会把静态 external 包名改写成 `xxx-哈希`，
 * 导致运行时找不到模块（better-sqlite3 也踩过同一个坑）。
 */
async function getTransformers(): Promise<TransformersModule> {
  if (transformersPromise === null) {
    const specifier = ['@huggingface', 'transformers'].join('/');
    transformersPromise = import(/* webpackIgnore: true */ specifier) as Promise<TransformersModule>;
  }
  return transformersPromise;
}

async function createExtractor(): Promise<FeatureExtractionPipeline> {
  const { env, pipeline } = await getTransformers();

  // 模型文件是离线放在 out/models 下的，运行时不联网
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = MODEL_DIR;
  env.cacheDir = MODEL_DIR;

  return (await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'fp32' })) as FeatureExtractionPipeline;
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise === null) extractorPromise = createExtractor();
  return extractorPromise;
}

function normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0 || !Number.isFinite(norm)) {
    throw new Error(`embedding 产出零向量或非法范数：${norm}`);
  }
  return vector.map((value) => value / norm);
}

function assertDims(vector: number[], index: number): void {
  if (vector.length !== EMBED_DIMS) {
    throw new Error(`第 ${index + 1} 条向量维度是 ${vector.length}，期望 ${EMBED_DIMS}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 批量文本 → 归一化向量。入库和查询必须都走这里，保证同一套模型与归一化。
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  texts.forEach((text, index) => {
    if (text.trim() === '') {
      throw new Error(`第 ${index + 1} 条文本是空的，无法 embedding`);
    }
    if (text.length > MAX_INPUT_CHARS) {
      throw new Error(`第 ${index + 1} 条文本 ${text.length} 字符，超过 ${MAX_INPUT_CHARS} 上限；请先切分，embedding 层不做截断`);
    }
  });

  const estimated = estimateTokens(texts);
  if (!canSpend(estimated)) {
    throw new QuotaError('今日 embedding 额度已用完');
  }

  const extractor = await getExtractor();
  const vectors: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BATCH_SIZE);
    const output = await extractor(batch, { pooling: 'cls', normalize: true });
    const rows = output.tolist() as number[][];

    if (rows.length !== batch.length) {
      throw new Error(`embedding 返回 ${rows.length} 条，输入 ${batch.length} 条，数量不一致`);
    }

    rows.forEach((row, index) => {
      assertDims(row, offset + index);
      vectors.push(normalize(row));
    });

    recordUsage(estimateTokens(batch));

    if (offset + BATCH_SIZE < texts.length) await sleep(BATCH_DELAY_MS);
  }

  return vectors;
}

/** 粗估 token：CJK 1 字 ≈ 1 token，其余字符 4 个 ≈ 1 token。 */
export function estimateTokens(texts: string[]): number {
  let tokens = 0;
  for (const text of texts) {
    const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff]/g) ?? []).length;
    tokens += cjk + Math.ceil((text.length - cjk) / 4);
  }
  return tokens;
}
