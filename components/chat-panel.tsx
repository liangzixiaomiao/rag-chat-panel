'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import SlashCommands from '@/components/slash-commands';
import { COMMANDS, buildAskMessage, parseCompareArgs, parseSlashInput } from '@/lib/commands';
import type { CommandName } from '@/lib/commands';
import { streamChat } from '@/lib/chat-stream';
import type { CitationDetail } from '@/lib/chat-stream';

const FIRST_TOKEN_TIMEOUT_MS = 30000;
const MAX_HISTORY = 4;
const FALLBACK_ERROR = '这次没答上来，可以重试';

interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: CitationDetail[];
  error: string | null;
  pending: boolean;
}

interface ChatPanelProps {
  documentId: string | null;
  scope: 'current' | 'all';
  canAsk: boolean;
  disabledReason: string;
  onCitationOpen: (citation: CitationDetail) => void;
}

const badgeStyle = {
  border: '1px solid #888',
  borderRadius: 3,
  background: '#f3f3f3',
  padding: '0 3px',
  margin: '0 1px',
  cursor: 'pointer',
  fontSize: 12,
} as const;

const citationListStyle = { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 } as const;
const citationItemStyle = {
  border: '1px solid #bbb',
  borderRadius: 3,
  background: '#fafafa',
  padding: '1px 6px',
  cursor: 'pointer',
  fontSize: 12,
  color: '#333',
} as const;

interface CommandPayload {
  command: CommandName;
  commandArgs: string[];
  selectedText: string;
  question: string;
}

export default function ChatPanel({ documentId, scope, canAsk, disabledReason, onCitationOpen }: ChatPanelProps) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // 选中原文后焦点会切到输入框，这里持续记住最后一次非空选区，供 /explain 使用
  const selectedTextRef = useRef('');

  useEffect(() => {
    function handleSelectionChange(): void {
      const text = window.getSelection()?.toString().trim() ?? '';
      if (text !== '') selectedTextRef.current = text;
    }
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  function patchMessage(id: string, patch: Partial<UiMessage>): void {
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  }

  /** 参数解析不到时只追问一次：把用户输入和提示一起放进对话，不发请求。 */
  function askOnce(rawInput: string, notice: string): void {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', content: rawInput, citations: [], error: null, pending: false },
      { id: crypto.randomUUID(), role: 'assistant', content: notice, citations: [], error: null, pending: false },
    ]);
    setInput('');
    setHint('');
  }

  function prepareCommand(command: CommandName, args: string, rawInput: string): CommandPayload | null {
    if (command === 'explain') {
      const text = args !== '' ? args : selectedTextRef.current;
      if (text === '') {
        askOnce(rawInput, buildAskMessage('explain', scope));
        return null;
      }
      return { command, commandArgs: [], selectedText: text, question: text };
    }

    if (command === 'compare') {
      const targets = parseCompareArgs(args);
      if (targets === null) {
        askOnce(rawInput, buildAskMessage('compare', scope));
        return null;
      }
      return { command, commandArgs: targets, selectedText: '', question: args };
    }

    const trimmed = args.trim();
    return {
      command,
      commandArgs: trimmed === '' ? [] : [trimmed],
      selectedText: '',
      question: trimmed === '' ? `/${command}` : trimmed,
    };
  }

  async function send(rawInput: string): Promise<void> {
    const text = rawInput.trim();
    if (text === '' || busy || !canAsk) return;

    let payload: CommandPayload | null = null;

    if (text.startsWith('/')) {
      const slash = parseSlashInput(text);
      if (slash.kind === 'menu') {
        // 只输入 "/"：保持输入框内容并展示指令列表，不发请求
        setInput(text);
        setHint('');
        return;
      }
      if (slash.kind === 'unknown') {
        setHint(`没有这个指令：/${slash.token}`);
        return;
      }
      if (slash.kind === 'command') {
        payload = prepareCommand(slash.command, slash.args, text);
        if (payload === null) return;
      }
    }

    const question = payload === null ? text : payload.question;
    const history = messages
      .filter((message) => message.content.trim() !== '')
      .slice(-MAX_HISTORY)
      .map((message) => ({ role: message.role, content: message.content }));

    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();

    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', content: text, citations: [], error: null, pending: false },
      { id: assistantId, role: 'assistant', content: '', citations: [], error: null, pending: true },
    ]);
    setInput('');
    setHint('');
    setBusy(true);

    const request =
      payload === null
        ? { question, scope, documentId: documentId ?? undefined, history }
        : {
            question,
            scope,
            documentId: documentId ?? undefined,
            command: payload.command,
            commandArgs: payload.commandArgs,
            selectedText: payload.selectedText,
            history: [],
          };

    const controller = new AbortController();
    let receivedFirstToken = false;
    const timeoutTimer = setTimeout(() => {
      if (!receivedFirstToken) {
        controller.abort();
        patchMessage(assistantId, { pending: false, error: '检索或生成超时' });
      }
    }, FIRST_TOKEN_TIMEOUT_MS);

    try {
      const result = await streamChat(
        request,
        {
          onText: (delta) => {
            if (!receivedFirstToken) {
              receivedFirstToken = true;
              clearTimeout(timeoutTimer);
            }
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, content: message.content + delta } : message
              )
            );
          },
          onCitations: (citations) => patchMessage(assistantId, { citations }),
        },
        controller.signal
      );

      if (result.error !== null) {
        patchMessage(assistantId, { error: result.error });
      } else if (result.text === '') {
        patchMessage(assistantId, { error: FALLBACK_ERROR });
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      const detail = err instanceof Error ? err.message : String(err);
      patchMessage(assistantId, { error: aborted ? '检索或生成超时' : `${FALLBACK_ERROR}（${detail}）` });
    } finally {
      clearTimeout(timeoutTimer);
      patchMessage(assistantId, { pending: false });
      setBusy(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  }

  function renderContent(message: UiMessage): ReactNode[] {
    const nodes: ReactNode[] = [];
    const pattern = /\[(\d+)\]/g;
    let cursor = 0;
    let match = pattern.exec(message.content);

    while (match !== null) {
      if (match.index > cursor) nodes.push(message.content.slice(cursor, match.index));

      const refId = Number(match[1]);
      const citation = message.citations.find((item) => item.refId === refId);
      const key = `${message.id}-${match.index}`;

      nodes.push(
        citation ? (
          <button key={key} type="button" style={badgeStyle} onClick={() => onCitationOpen(citation)}>
            [{refId}]
          </button>
        ) : (
          <span key={key}>[{refId}]</span>
        )
      );

      cursor = match.index + match[0].length;
      match = pattern.exec(message.content);
    }

    nodes.push(message.content.slice(cursor));
    return nodes;
  }

  function previousQuestion(index: number): string {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor].role === 'user') return messages[cursor].content;
    }
    return '';
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ minHeight: 200 }}>
        {messages.length === 0 ? (
          <p style={{ color: '#666' }}>
            {scope === 'all' ? '在所有已入库文档里问点什么' : '在这篇文档里问点什么'}（输入 / 可调用指令）
          </p>
        ) : (
          messages.map((message, index) => (
            <div key={message.id} style={{ marginBottom: 12 }}>
              <div style={{ color: '#888', fontSize: 12 }}>{message.role === 'user' ? '你' : '助手'}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>
                {message.content === '' && message.pending ? '…' : renderContent(message)}
              </div>
              {/* 全库检索时正文不写文件名，出处统一在回答下方回填标题，保证每条引用能看出是哪本书 */}
              {message.role === 'assistant' && message.citations.length > 0 && (
                <div style={citationListStyle}>
                  {message.citations.map((citation) => (
                    <button
                      key={`${message.id}-cite-${citation.refId}`}
                      type="button"
                      style={citationItemStyle}
                      title={`p${citation.pageFrom}-${citation.pageTo ?? '?'}`}
                      onClick={() => onCitationOpen(citation)}
                    >
                      [{citation.refId}] {citation.documentTitle}
                    </button>
                  ))}
                </div>
              )}
              {message.error !== null && (
                <div style={{ color: 'crimson', marginTop: 4 }}>
                  {message.error}
                  <button
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={() => void send(previousQuestion(index))}
                    disabled={busy}
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {input.trim() === '/' && (
        <SlashCommands
          commands={COMMANDS}
          onPick={(command) => {
            setInput(`/${command.name} `);
            setHint('');
            textareaRef.current?.focus();
          }}
        />
      )}

      {hint !== '' && <div style={{ color: '#a60', fontSize: 12 }}>{hint}</div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setHint('');
          }}
          onKeyDown={handleKeyDown}
          rows={3}
          disabled={!canAsk || busy}
          placeholder={canAsk ? 'Enter 发送，Shift+Enter 换行；输入 / 调用指令' : disabledReason}
          style={{ flex: 1, padding: 6, cursor: busy ? 'progress' : 'text' }}
        />
        <button type="submit" onClick={() => void send(input)} disabled={!canAsk || busy}>
          {busy ? '生成中…' : '发送'}
        </button>
      </div>

      {!canAsk && <div style={{ color: '#a60', fontSize: 12 }}>{disabledReason}</div>}
    </section>
  );
}
