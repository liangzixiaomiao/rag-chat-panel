// 客户端 SSE 解析：只用 fetch + TextDecoder，按 /api/chat 的帧格式拆包。
import type { CommandName } from '@/lib/commands';
import type { Citation } from '@/lib/types';

export interface ChatStreamRequest {
  question: string;
  /** 不传按 current 处理；all 时 documentId 可省略；selected 时 documentIds 必填 */
  scope?: 'current' | 'all' | 'selected';
  documentId?: string;
  /** scope=selected 时使用：只在这些文档里检索 */
  documentIds?: string[];
  /** 斜杠指令；不传就是普通问答 */
  command?: CommandName;
  commandArgs?: string[];
  /** /explain 用：用户选中的原文，直接当上下文，不做检索 */
  selectedText?: string;
  history?: { role: 'user' | 'assistant'; content: string }[];
}

/** citations 事件里的条目：在 Citation 基础上带上父块全文与页码，供前端抽屉展示。 */
export interface CitationDetail extends Citation {
  pageTo: number | null;
  fullContext: string;
}

export interface ChatStreamHandlers {
  onText?: (delta: string) => void;
  onCitations?: (citations: CitationDetail[]) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}

export interface ChatStreamResult {
  text: string;
  citations: CitationDetail[];
  error: string | null;
}

interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * 消费 POST /api/chat 的流。
 * 帧格式：默认帧 {text} / event: citations / event: error / event: done。
 * HTTP 非 2xx 时直接抛错（服务端此时返回的是 JSON，不是 SSE）。
 */
export async function streamChat(
  request: ChatStreamRequest,
  handlers: ChatStreamHandlers = {},
  signal?: AbortSignal
): Promise<ChatStreamResult> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    const raw = await response.text();
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // 非 JSON 错误体就保留原始文本
    }
    throw new Error(`HTTP ${response.status}：${message}`);
  }

  if (!response.body) throw new Error('响应没有 body，不是流式响应');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const citations: CitationDetail[] = [];
  let error: string | null = null;

  const handleFrame = (frame: SseFrame): void => {
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch (err) {
      console.error('[streamChat] 帧解析失败', err, frame.data);
      return;
    }

    if (frame.event === 'citations') {
      const list = Array.isArray(payload) ? (payload as CitationDetail[]) : [];
      citations.push(...list);
      handlers.onCitations?.(list);
      return;
    }

    if (frame.event === 'error') {
      error = (payload as { error?: string }).error ?? '未知错误';
      handlers.onError?.(error);
      return;
    }

    if (frame.event === 'done') {
      handlers.onDone?.();
      return;
    }

    const delta = (payload as { text?: string }).text ?? '';
    if (delta !== '') {
      text += delta;
      handlers.onText?.(delta);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseFrame(raw);
      if (frame) handleFrame(frame);
      boundary = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.trim() !== '') {
    const tail = parseFrame(buffer);
    if (tail) handleFrame(tail);
  }

  return { text, citations, error };
}
