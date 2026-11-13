#!/usr/bin/env node
// 评测入口：
//   node eval/run.mjs        → M0，questions-10.json，单文档
//   node eval/run.mjs --m1   → M1，questions.json，全部文档
// 运行前需要先启动 npm run dev；也可用 EVAL_BASE_URL 指定服务地址。
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
// 引用校验必须复用应用里的同一份实现，不在这里重写
import { validateCitations } from '../lib/citation.ts';

// ===== 参数：一次只改一个，跑完用 report 对比归因 =====
const PARAMS = {
  // 子块目标字数，与 lib/chunk.ts 的 CHILD_TARGET 保持一致（CHILD_MAX = 500）
  chunkSize: 400,
  // 父块软上限，与 lib/chunk.ts 的 PARENT_SOFT_MAX 保持一致
  parentMaxChars: 1000,
  // Recall@K 的 K，同时作为 /api/search 的 topK
  topK: 5,
  // 方案 B 暂未接 rerank，仅记录参数，避免报告对比时丢字段
  rerank: false,
};

const BASE_URL = process.env.EVAL_BASE_URL ?? 'http://localhost:3000';
const M0_DOCUMENT_ID = process.env.EVAL_DOCUMENT_ID ?? '82ee21f3-f285-463c-9f8c-bdd715f1f911';
// 方案 B：本地向量 + 远端 LLM，首字延迟单独放宽阈值
const FIRST_TOKEN_LIMIT_MS = 60000;
const REFUSAL_PATTERNS = ['没有找到', '没有检索到', '未找到', '知识库里没有', '没有相关内容'];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVAL_DIR = path.join(ROOT, 'eval');
const DB_PATH = path.join(ROOT, 'out', 'kb.sqlite');

// chunkId → "parentIndex:cChunkIndex"，用于把检索结果的 chunkId 映射回题目标注
const keyByChunkId = new Map();

const cliArgs = process.argv.slice(2);
const SET = cliArgs.includes('--m1') ? 'm1' : 'm0';
const QUESTIONS_FILE = path.join(EVAL_DIR, SET === 'm1' ? 'questions.json' : 'questions-10.json');
const SCOPE = SET === 'm0' ? 'current' : 'all';

function percent(value) {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

// 防止只改 run.mjs 常量、却没重新入库：两者不一致时报告里的 chunkSize 不可信
function warnIfChunkParamsMismatch() {
  try {
    const source = readFileSync(path.join(ROOT, 'lib', 'chunk.ts'), 'utf8');
    const childTarget = Number(/const CHILD_TARGET = (\d+);/.exec(source)?.[1] ?? NaN);
    const parentSoftMax = Number(/const PARENT_SOFT_MAX = (\d+);/.exec(source)?.[1] ?? NaN);

    if (!Number.isNaN(childTarget) && childTarget !== PARAMS.chunkSize) {
      console.warn(
        `[警告] PARAMS.chunkSize=${PARAMS.chunkSize} 与 lib/chunk.ts 的 CHILD_TARGET=${childTarget} 不一致，` +
          '如果刚改过切块参数，需要重新入库后再评测。'
      );
    }
    if (!Number.isNaN(parentSoftMax) && parentSoftMax !== PARAMS.parentMaxChars) {
      console.warn(
        `[警告] PARAMS.parentMaxChars=${PARAMS.parentMaxChars} 与 lib/chunk.ts 的 PARENT_SOFT_MAX=${parentSoftMax} 不一致。`
      );
    }
  } catch {
    // 读不到源码不影响评测
  }
}

function loadQuestions() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch (err) {
    console.error(`读取题目失败：${QUESTIONS_FILE}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }

  if (!Array.isArray(raw)) {
    console.error(`题目文件必须是数组：${QUESTIONS_FILE}`);
    process.exit(1);
  }
  if (raw.length === 0) {
    console.error('题目数量为 0，退出');
    process.exit(1);
  }

  return raw;
}

function openDatabase() {
  try {
    return new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`打不开数据库：${DB_PATH}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

async function assertServer() {
  try {
    const response = await fetch(`${BASE_URL}/`, { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (err) {
    console.error(`连不上 ${BASE_URL}：${err instanceof Error ? err.message : String(err)}`);
    console.error('请先启动 npm run dev，或用 EVAL_BASE_URL=http://host:port 指定地址。');
    process.exit(1);
  }
}

function scopeBody(question) {
  const body = { question, scope: SCOPE };
  if (SET === 'm0') body.documentId = M0_DOCUMENT_ID;
  return body;
}

async function callSearch(question) {
  const body = { ...scopeBody(question), topK: PARAMS.topK };
  const response = await fetch(`${BASE_URL}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`/api/search ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function parseFrame(frame) {
  let event = null;
  const dataLines = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

async function callChat(question) {
  const startedAt = performance.now();
  const response = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(scopeBody(question)),
  });
  if (!response.ok) {
    throw new Error(`/api/chat ${response.status}: ${await response.text()}`);
  }
  if (response.body === null) throw new Error('/api/chat 没有返回流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let citations = [];
  let firstTokenMs = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseFrame(frame);

      if (parsed !== null) {
        if (parsed.event === 'citations') {
          citations = Array.isArray(parsed.data) ? parsed.data : [];
        } else if (parsed.event === 'error') {
          throw new Error(parsed.data?.error ?? '接口返回 error');
        } else if (parsed.data !== null && typeof parsed.data === 'object' && typeof parsed.data.text === 'string') {
          if (parsed.data.text !== '') {
            if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
            text += parsed.data.text;
          }
        }
      }

      boundary = buffer.indexOf('\n\n');
    }
  }

  return {
    text,
    citations,
    firstTokenMs: firstTokenMs ?? Math.round(performance.now() - startedAt),
  };
}

/** 用 citation 事件自带的 fullContext 还原 parents，再交给 lib/citation.ts 校验。 */
function checkCitations(citations) {
  if (!Array.isArray(citations) || citations.length === 0) return { total: 0, valid: 0 };

  const maxRef = citations.reduce((max, citation) => {
    return Number.isInteger(citation.refId) && citation.refId > max ? citation.refId : max;
  }, 0);

  const parents = Array.from({ length: maxRef }, () => ({
    fullContext: '',
    pageFrom: 0,
    headingPath: null,
    documentTitle: '',
  }));

  for (const citation of citations) {
    if (!Number.isInteger(citation.refId) || citation.refId < 1) continue;
    parents[citation.refId - 1] = {
      fullContext: typeof citation.fullContext === 'string' ? citation.fullContext : '',
      pageFrom: typeof citation.pageFrom === 'number' ? citation.pageFrom : 0,
      headingPath: typeof citation.headingPath === 'string' ? citation.headingPath : null,
      documentTitle: typeof citation.documentTitle === 'string' ? citation.documentTitle : '',
    };
  }

  const valid = validateCitations(
    citations.map((citation) => ({ refId: citation.refId, quote: citation.quote })),
    parents
  );
  return { total: citations.length, valid: valid.length };
}

async function runQuestion(question, skipReason) {
  const result = {
    id: question.id,
    question: question.question,
    type: question.type,
    expectedChunkKeys: Array.isArray(question.expectedChunkKeys) ? question.expectedChunkKeys : [],
    note: question.note ?? '',
    status: 'ok',
    recallHit: null,
    topKeys: [],
    firstTokenMs: null,
    answer: '',
    citations: [],
    citationsValid: 0,
    citationsTotal: 0,
    refusalHit: null,
    error: null,
  };

  if (skipReason !== null) {
    return { ...result, status: 'skipped', error: skipReason };
  }

  try {
    if (question.type !== 'absent') {
      const search = await callSearch(question.question);
      const topKeys = (search.hits ?? [])
        .slice(0, PARAMS.topK)
        .map((hit) => keyByChunkId.get(hit.chunkId))
        .filter((key) => key !== undefined);
      result.topKeys = topKeys;
      result.recallHit = result.expectedChunkKeys.some((key) => topKeys.includes(key));
    }

    const chat = await callChat(question.question);
    result.answer = chat.text;
    result.firstTokenMs = chat.firstTokenMs;

    const citationCheck = checkCitations(chat.citations);
    result.citationsTotal = citationCheck.total;
    result.citationsValid = citationCheck.valid;
    // fullContext 只用于校验，不写进报告，避免报告体积过大
    result.citations = chat.citations.map((citation) => ({
      refId: citation.refId,
      quote: citation.quote,
      pageFrom: citation.pageFrom,
      headingPath: citation.headingPath,
      documentTitle: citation.documentTitle,
    }));

    if (question.type === 'absent') {
      result.refusalHit = REFUSAL_PATTERNS.some((pattern) => chat.text.includes(pattern));
    }

    return result;
  } catch (err) {
    return {
      ...result,
      status: 'error',
      error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err),
    };
  }
}

function printQuestionLine(result) {
  if (result.status === 'skipped') {
    console.log(`#${result.id} ${result.type} skipped - ${result.error}`);
    return;
  }
  if (result.status === 'error') {
    const firstLine = (result.error ?? '').split('\n')[0];
    console.log(`#${result.id} ${result.type} error - ${firstLine}`);
    return;
  }

  const hitLabel =
    result.type === 'absent'
      ? `refusal=${result.refusalHit === true ? 'Y' : 'N'}`
      : `hit=${result.recallHit === true ? 'Y' : 'N'}`;
  console.log(
    `#${result.id} ${result.type} ${hitLabel} ${result.firstTokenMs}ms citations=${result.citationsValid}/${result.citationsTotal}`
  );
}

function computeMetrics(results) {
  const ok = results.filter((result) => result.status === 'ok');
  const recallPool = ok.filter((result) => result.type !== 'absent');
  const recallHits = recallPool.filter((result) => result.recallHit === true).length;
  const refusalPool = ok.filter((result) => result.type === 'absent');
  const refusalHits = refusalPool.filter((result) => result.refusalHit === true).length;

  const citationTotal = ok.reduce((sum, result) => sum + result.citationsTotal, 0);
  const citationValid = ok.reduce((sum, result) => sum + result.citationsValid, 0);

  const latencies = ok
    .map((result) => result.firstTokenMs)
    .filter((value) => typeof value === 'number')
    .sort((a, b) => a - b);
  const avg = latencies.length === 0 ? null : Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
  const p95 =
    latencies.length === 0
      ? null
      : latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)];
  const max = latencies.length === 0 ? null : latencies[latencies.length - 1];

  return {
    total: results.length,
    evaluated: ok.length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    errors: results.filter((result) => result.status === 'error').length,
    recall: {
      hit: recallHits,
      total: recallPool.length,
      value: recallPool.length === 0 ? null : recallHits / recallPool.length,
    },
    citationAccuracy: {
      valid: citationValid,
      total: citationTotal,
      value: citationTotal === 0 ? null : citationValid / citationTotal,
    },
    refusal: {
      hit: refusalHits,
      total: refusalPool.length,
      value: refusalPool.length === 0 ? null : refusalHits / refusalPool.length,
    },
    firstTokenMs: {
      avg,
      p95,
      max,
      threshold: FIRST_TOKEN_LIMIT_MS,
      pass: max === null ? null : max <= FIRST_TOKEN_LIMIT_MS,
    },
  };
}

function findPreviousReport(currentFile) {
  let files;
  try {
    files = readdirSync(EVAL_DIR).filter((name) => /^report-.*\.json$/.test(name) && name !== currentFile);
  } catch {
    return null;
  }

  const candidates = [];
  for (const name of files) {
    try {
      const filePath = path.join(EVAL_DIR, name);
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      if (data.set === SET) {
        candidates.push({ name, data, mtime: statSync(filePath).mtimeMs });
      }
    } catch {
      // 坏报告直接跳过，不能阻断本次评测
    }
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ?? null;
}

function buildComparison(previous, metrics, results) {
  if (previous === null) return null;

  const changedParams = Object.keys(PARAMS).filter((key) => previous.data.params?.[key] !== PARAMS[key]);
  const warnings = [];
  if (changedParams.length >= 2) {
    warnings.push(
      `本次与上次 report 有 ${changedParams.length} 个参数不同（${changedParams.join(', ')}），结果无法归因到单一变量。`
    );
  }

  const previousById = new Map((previous.data.questions ?? []).map((item) => [item.id, item]));
  const regressions = [];

  for (const result of results) {
    const before = previousById.get(result.id);
    if (before === undefined) continue;
    if (
      before.status === 'ok' &&
      result.status === 'ok' &&
      before.recallHit === true &&
      result.recallHit === false
    ) {
      regressions.push({
        id: result.id,
        question: result.question,
        expectedChunkKeys: result.expectedChunkKeys,
      });
    }
  }

  return {
    previousReport: previous.name,
    changedParams,
    warnings,
    previousRecall: previous.data.metrics?.recall?.value ?? null,
    currentRecall: metrics.recall.value,
    regressions,
  };
}

async function main() {
  const questions = loadQuestions();
  await assertServer();

  const db = openDatabase();
  for (const row of db.prepare('select id, parent_index, chunk_index from chunks').all()) {
    keyByChunkId.set(row.id, `${row.parent_index}:c${row.chunk_index}`);
  }

  const targetChunkCount =
    SET === 'm0'
      ? db.prepare('select count(*) as n from chunks where document_id = ?').get(M0_DOCUMENT_ID).n
      : keyByChunkId.size;
  const skipReason = targetChunkCount === 0 ? '库里没有对应文档或子块' : null;
  db.close();

  console.log(
    `评测 ${SET.toUpperCase()} · ${path.basename(QUESTIONS_FILE)} · scope=${SCOPE}` +
      (SET === 'm0' ? ` · documentId=${M0_DOCUMENT_ID}` : '')
  );
  console.log(
    `参数：chunkSize=${PARAMS.chunkSize} parentMaxChars=${PARAMS.parentMaxChars} topK=${PARAMS.topK} rerank=${PARAMS.rerank}`
  );
  warnIfChunkParamsMismatch();
  if (skipReason !== null) console.log(`[提示] ${skipReason}，全部题目标记 skipped`);

  const results = [];
  for (const question of questions) {
    const result = await runQuestion(question, skipReason);
    results.push(result);
    printQuestionLine(result);
  }

  const metrics = computeMetrics(results);
  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\..+/, '');
  const reportFile = `report-${stamp}.json`;

  const previous = findPreviousReport(reportFile);
  const comparison = buildComparison(previous, metrics, results);

  const report = {
    set: SET,
    generatedAt,
    baseUrl: BASE_URL,
    documentId: SET === 'm0' ? M0_DOCUMENT_ID : null,
    params: PARAMS,
    metrics,
    comparison,
    questions: results,
  };

  writeFileSync(path.join(EVAL_DIR, reportFile), JSON.stringify(report, null, 2), 'utf8');

  console.log('');
  console.log(
    `题目：${metrics.total} 题，evaluated=${metrics.evaluated} skipped=${metrics.skipped} error=${metrics.errors}`
  );
  console.log(
    `Recall@${PARAMS.topK}：${metrics.recall.hit}/${metrics.recall.total} = ${percent(metrics.recall.value)}`
  );
  console.log(
    `引用准确率：${metrics.citationAccuracy.valid}/${metrics.citationAccuracy.total} = ${percent(
      metrics.citationAccuracy.value
    )}`
  );
  console.log(
    `拒答正确率：${metrics.refusal.hit}/${metrics.refusal.total} = ${percent(metrics.refusal.value)}`
  );
  const latencyPass =
    metrics.firstTokenMs.pass === null ? 'N/A' : metrics.firstTokenMs.pass ? '通过' : '未通过';
  console.log(
    `首字延迟：avg=${metrics.firstTokenMs.avg ?? 'N/A'}ms p95=${metrics.firstTokenMs.p95 ?? 'N/A'}ms max=${
      metrics.firstTokenMs.max ?? 'N/A'
    }ms（阈值 ${FIRST_TOKEN_LIMIT_MS}ms，${latencyPass}）`
  );

  if (comparison !== null) {
    console.log('');
    console.log(`对比上次 report：${comparison.previousReport}`);
    console.log(`参数变化：[${comparison.changedParams.join(', ') || '无'}]`);
    for (const warning of comparison.warnings) console.warn(`[警告] ${warning}`);
    console.log(
      `Recall@${PARAMS.topK}：上次 ${percent(comparison.previousRecall)} → 本次 ${percent(
        comparison.currentRecall
      )}`
    );
    console.log(`回归题：${comparison.regressions.length} 条`);
    for (const item of comparison.regressions) {
      console.log(`  #${item.id} ${item.question}（期望 ${item.expectedChunkKeys.join(', ') || '无'}）`);
    }
  }

  console.log('');
  console.log(`报告：eval/${reportFile}`);
}

await main();
