import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { validateCitations } from '@/lib/citation';
import { serverClient } from '@/lib/db';
import { estimateTokens } from '@/lib/embed';
import { canSpend, recordUsage } from '@/lib/guard';
import { buildContextBlock, buildMessages } from '@/lib/prompt';
import { rewriteQuery } from '@/lib/query';
import { retrieve } from '@/lib/retrieve';
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
    documentId?: unknown;
    history?: unknown;
  };

  if (typeof record.documentId !== 'string' || record.documentId.trim() === '') {
    return NextResponse.json({ error: '缺少 documentId' }, { status: 400 });
  }
  if (typeof record.question !== 'string' || record.question.trim() === '') {
    return NextResponse.json({ error: '缺少 question' }, { status: 400 });
  }

  const question = record.question;
  const documentId = record.documentId;
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

  // 检索用改写后的问题，生成用原问题
  const rewrite = await rewriteQuery({ question, history });
  const searchQuery = rewrite.query === '' ? question : rewrite.query;

  let parents: Retrieved[];
  try {
    const result = await retrieve({ question: searchQuery, documentId, topK: 20, maxParents: 8 });
    parents = result.parents;
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
        if (parents.length === 0) {
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

        const messages = buildMessages({ question, parents, history });
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
