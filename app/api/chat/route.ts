import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { validateCitations } from '@/lib/citation';
import {
  COMMAND_DEFAULT_QUERY,
  COMMAND_RETRIEVAL,
  buildCommandSystemPrompt,
  buildCommandUserMessage,
  buildCompareContext,
  buildOutlineContext,
  isCommandName,
} from '@/lib/commands';
import type { CommandName } from '@/lib/commands';
import { serverClient } from '@/lib/db';
import { estimateTokens } from '@/lib/embed';
import { canSpend, recordUsage } from '@/lib/guard';
import { buildContextBlock, buildMessages, buildSystemPrompt } from '@/lib/prompt';
import { rewriteQuery } from '@/lib/query';
import { listParents, retrieve, retrieveCompare } from '@/lib/retrieve';
import type { Citation, Retrieved } from '@/lib/types';

const MODEL = 'deepseek-chat';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const CHAT_TEMPERATURE = 0.2;
const CHAT_MAX_OUTPUT = 1000;
const CITATION_MAX_OUTPUT = 400;
const NO_CONTEXT_ANSWER = '知识库里没有检索到相关内容。';

const CITATION_SYSTEM_PROMPT =
  '你是引用抽取器。只输出 JSON：{"citations":[{"refId":1,"quote":"原文片段"}]}，不要输出任何其他文字。';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { total_tokens?: number };
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
}

function logError(scope: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[api/chat] ${scope}\n${detail}`);
}

function modelEndpoint(): { url: string; apiKey: string } {
  const baseUrl = (process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY');
  return { url: `${baseUrl}/chat/completions`, apiKey };
}

/** 流式调模型，每收到一段 delta 就回调，返回完整正文与 usage。 */
async function streamCompletion(messages: ChatMessage[], onDelta: (delta: string) => void): Promise<{
  content: string;
  tokens: number | null;
}> {
  const { url, apiKey } = modelEndpoint();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: CHAT_TEMPERATURE,
      max_tokens: CHAT_MAX_OUTPUT,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`DeepSeek 返回 ${response.status}：${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let tokens: number | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const line = part.split('\n').find((item) => item.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;

      const chunk = JSON.parse(payload) as StreamChunk;
      const delta = chunk.choices?.[0]?.delta?.content ?? '';
      if (delta !== '') {
        content += delta;
        onDelta(delta);
      }
      if (chunk.usage?.total_tokens) tokens = chunk.usage.total_tokens;
    }
  }

  return { content, tokens };
}

/** 非流式小请求：只要 citations JSON。 */
async function requestCitations(answer: string, parents: Retrieved[]): Promise<Citation[]> {
  const { url, apiKey } = modelEndpoint();
  const userContent = `${buildContextBlock(parents)}\n\n【回答】\n${answer}\n\n请从【资料】中摘出支撑该回答的原文片段。`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: CITATION_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      max_tokens: CITATION_MAX_OUTPUT,
    }),
  });

  if (!response.ok) {
    throw new Error(`引用抽取失败 ${response.status}：${await response.text()}`);
  }

  const data = (await response.json()) as CompletionResponse;
  recordUsage(data.usage?.total_tokens ?? estimateTokens([userContent]));

  const text = data.choices?.[0]?.message?.content ?? '';
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return [];

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { citations?: unknown };
    return validateCitations(parsed.citations, parents);
  } catch {
    return [];
  }
}

function saveAssistantMessage(conversationId: string, content: string, citations: Citation[]): void {
  serverClient()
    .prepare('insert into messages (conversation_id, role, content, citations) values (?, ?, ?, ?)')
    .run(conversationId, 'assistant', content, JSON.stringify(citations));
}

function sseFrame(encoder: TextEncoder, event: string | null, data: unknown): Uint8Array {
  const prefix = event === null ? '' : `event: ${event}\n`;
  return encoder.encode(`${prefix}data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是合法 JSON' }, { status: 400 });
  }

  const record = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    question?: unknown;
    scope?: unknown;
    documentId?: unknown;
    documentIds?: unknown;
    history?: unknown;
    command?: unknown;
    commandArgs?: unknown;
    selectedText?: unknown;
  };

  const rawScope: unknown = record.scope === undefined ? 'current' : record.scope;
  if (rawScope !== 'current' && rawScope !== 'all' && rawScope !== 'selected') {
    return NextResponse.json({ error: "scope 只能是 'current'、'all' 或 'selected'" }, { status: 400 });
  }
  const scope: 'current' | 'all' | 'selected' = rawScope;
  if (typeof record.question !== 'string' || record.question.trim() === '') {
    return NextResponse.json({ error: '缺少 question' }, { status: 400 });
  }

  let command: CommandName | undefined;
  if (record.command !== undefined) {
    if (!isCommandName(record.command)) {
      return NextResponse.json({ error: '未知指令' }, { status: 400 });
    }
    command = record.command;
  }

  const commandArgs = Array.isArray(record.commandArgs)
    ? record.commandArgs
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.trim())
    : [];
  const selectedText = typeof record.selectedText === 'string' ? record.selectedText.trim() : '';

  // scope=all 时忽略 documentId；scope=current（含未传 scope）时 documentId 必填；scope=selected 时 documentIds 必填
  let documentId: string | null = null;
  let documentIds: string[] = [];
  if (scope === 'current') {
    if (typeof record.documentId !== 'string' || record.documentId.trim() === '') {
      return NextResponse.json({ error: 'scope=current 时必须提供 documentId' }, { status: 400 });
    }
    documentId = record.documentId;
  } else if (scope === 'selected') {
    if (!Array.isArray(record.documentIds) || record.documentIds.length === 0) {
      return NextResponse.json({ error: 'scope=selected 时必须提供 documentIds' }, { status: 400 });
    }
    const ids = record.documentIds
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
    if (ids.length === 0) {
      return NextResponse.json({ error: 'scope=selected 时必须提供 documentIds' }, { status: 400 });
    }
    if (ids.length > 20) {
      return NextResponse.json({ error: '一次最多选择 20 篇文档' }, { status: 400 });
    }
    documentIds = [...new Set(ids)];
  }

  const question = record.question;
  const history = Array.isArray(record.history)
    ? record.history
        .filter(
          (item): item is { role: 'user' | 'assistant'; content: string } =>
            typeof item === 'object' &&
            item !== null &&
            ((item as { role?: unknown }).role === 'user' || (item as { role?: unknown }).role === 'assistant') &&
            typeof (item as { content?: unknown }).content === 'string'
        )
        .map((item) => ({ role: item.role, content: item.content }))
    : [];

  let parents: Retrieved[] = [];
  let messages: ChatMessage[] = [];
  let citationsEnabled = true;
  let askAnswer: string | null = null;

  try {
    if (command === 'explain') {
      // 选中原文直接当上下文，不做检索
      const text = selectedText !== '' ? selectedText : commandArgs.join(' ').trim();
      if (text === '') {
        return NextResponse.json({ error: '请先选中要解释的原文，或写在 /explain 后面' }, { status: 400 });
      }
      messages = [
        { role: 'system', content: buildCommandSystemPrompt('explain', buildSystemPrompt()) },
        { role: 'user', content: buildCommandUserMessage('explain', `【资料】\n${text}`) },
      ];
      citationsEnabled = false;
    } else if (command === 'compare') {
      if (commandArgs.length !== 2) {
        return NextResponse.json({ error: '对比需要两个对象，例如 /compare 第一章 vs 第二章' }, { status: 400 });
      }

      const params = COMMAND_RETRIEVAL.compare;
      const compare = await retrieveCompare({
        scope: scope === 'current' ? 'current' : 'all',
        documentId,
        restrictTo: scope === 'selected' ? documentIds : null,
        targets: [commandArgs[0], commandArgs[1]],
        topK: params.topK,
        maxParentsPerSide: params.maxParents,
      });

      if (!compare.ok) {
        askAnswer = compare.message;
      } else {
        parents = [...compare.sides[0].parents, ...compare.sides[1].parents];
        messages = [
          { role: 'system', content: buildCommandSystemPrompt('compare', buildSystemPrompt()) },
          { role: 'user', content: buildCommandUserMessage('compare', buildCompareContext(compare.sides)) },
        ];
        citationsEnabled = false;
      }
    } else if (command === 'summarize' || command === 'outline') {
      const params = COMMAND_RETRIEVAL[command];
      if (command === 'outline') {
        // 大纲要看整篇结构，按父块顺序取，不做语义检索
        parents = listParents({ documentId, documentIds, limit: params.maxParents });
      } else {
        const searchQuestion = commandArgs.length > 0 ? commandArgs.join(' ') : COMMAND_DEFAULT_QUERY.summarize;
        parents = (
          await retrieve({
            question: searchQuestion,
            documentId,
            documentIds,
            topK: params.topK,
            maxParents: params.maxParents,
          })
        ).parents;
      }

      const context = command === 'outline' ? buildOutlineContext(parents) : buildContextBlock(parents);
      messages = [
        { role: 'system', content: buildCommandSystemPrompt(command, buildSystemPrompt()) },
        { role: 'user', content: buildCommandUserMessage(command, context) },
      ];
      // /outline 只要结构，不做引用抽取
      citationsEnabled = command === 'summarize';
    } else {
      // 检索用改写后的问题，生成用原问题
      const rewrite = await rewriteQuery({ question, history });
      const searchQuery = rewrite.query === '' ? question : rewrite.query;
      parents = (await retrieve({ question: searchQuery, documentId, documentIds, topK: 20, maxParents: 8 })).parents;
      messages = buildMessages({ question, parents, history });
    }
  } catch (err) {
    logError('检索失败', err);
    return NextResponse.json({ error: '检索失败，请查看服务端日志' }, { status: 500 });
  }

  const conversationId = randomUUID();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string | null, data: unknown): void => {
        controller.enqueue(sseFrame(encoder, event, data));
      };

      try {
        if (askAnswer !== null) {
          send(null, { text: askAnswer });
          send('citations', []);
          try {
            saveAssistantMessage(conversationId, askAnswer, []);
          } catch (err) {
            logError('落库失败（追问分支）', err);
          }
          send('done', {});
          return;
        }

        if (parents.length === 0 && command !== 'explain') {
          send(null, { text: NO_CONTEXT_ANSWER });
          send('citations', []);
          try {
            saveAssistantMessage(conversationId, NO_CONTEXT_ANSWER, []);
          } catch (err) {
            logError('落库失败（无资料分支）', err);
          }
          send('done', {});
          return;
        }

        const estimated = estimateTokens(messages.map((item) => item.content)) + CHAT_MAX_OUTPUT;
        if (!canSpend(estimated)) {
          send('error', { error: '今日 LLM 额度已用完' });
          return;
        }

        let answer = '';
        const completion = await streamCompletion(messages, (delta) => {
          answer += delta;
          send(null, { text: delta });
        });
        recordUsage(completion.tokens ?? estimateTokens([completion.content]));

        let citations: Citation[] = [];
        if (citationsEnabled) {
          try {
            citations = await requestCitations(completion.content, parents);
          } catch (err) {
            logError('引用抽取失败', err);
          }
          send('citations', citations.map((citation) => ({
            ...citation,
            pageTo: parents[citation.refId - 1].pageTo,
            fullContext: parents[citation.refId - 1].fullContext,
          })));
        } else {
          send('citations', []);
        }

        try {
          saveAssistantMessage(conversationId, completion.content, citations);
        } catch (err) {
          logError('落库失败', err);
          send('error', { error: '回答已生成，但保存会话失败' });
        }

        send('done', {});
      } catch (err) {
        logError('流式生成中断', err);
        send('error', { error: '生成中断，请重试' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
