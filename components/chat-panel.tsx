'use client';

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import SlashCommands from '@/components/slash-commands';
import { COMMANDS, buildAskMessage, parseCompareArgs, parseSlashInput } from '@/lib/commands';
import type { CommandName } from '@/lib/commands';
import { streamChat } from '@/lib/chat-stream';
import type { CitationDetail } from '@/lib/chat-stream';

const FIRST_TOKEN_TIMEOUT_MS = 30000;
const MAX_HISTORY = 4;
const FALLBACK_ERROR = '这次没答上来，可以重试';
/** 输入框自动撑高的上限，超过后内部滚动 */
const TEXTAREA_MAX_HEIGHT = 176;
/** 距底部小于该值时认为用户仍贴着底部，可以继续自动滚动 */
const STICK_BOTTOM_THRESHOLD = 96;

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
  scope: 'current' | 'all' | 'selected';
  /** scope=selected 时使用：只在这些文档里检索 */
  documentIds?: string[] | null;
  canAsk: boolean;
  disabledReason: string;
  onCitationOpen: (citation: CitationDetail) => void;
}

interface CommandPayload {
  command: CommandName;
  commandArgs: string[];
  selectedText: string;
  question: string;
}

export default function ChatPanel({
  documentId,
  scope,
  documentIds = null,
  canAsk,
  disabledReason,
  onCitationOpen,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 用户手动往上翻时暂停自动滚动，回到底部后恢复
  const stickToBottomRef = useRef(true);
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

  // 新消息或流式增量都会改变 messages，贴着底部时平滑跟进
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !stickToBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // 输入框随内容自动撑高，内容清空后回到单行
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  }, [input]);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (el === null) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_BOTTOM_THRESHOLD;
  }

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
    // 多选范围在指令提示语里按“跨文档”处理
    const promptScope = scope === 'current' ? 'current' : 'all';

    if (command === 'explain') {
      const text = args !== '' ? args : selectedTextRef.current;
      if (text === '') {
        askOnce(rawInput, buildAskMessage('explain', promptScope));
        return null;
      }
      return { command, commandArgs: [], selectedText: text, question: text };
    }

    if (command === 'compare') {
      const targets = parseCompareArgs(args);
      if (targets === null) {
        askOnce(rawInput, buildAskMessage('compare', promptScope));
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
    stickToBottomRef.current = true;

    const request =
      payload === null
        ? { question, scope, documentId: documentId ?? undefined, documentIds: documentIds ?? undefined, history }
        : {
            question,
            scope,
            documentId: documentId ?? undefined,
            documentIds: documentIds ?? undefined,
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
          <button
            key={key}
            type="button"
            onClick={() => onCitationOpen(citation)}
            className="mx-0.5 inline-flex h-[18px] min-w-[18px] translate-y-[-1px] items-center justify-center rounded-md bg-blue-50 px-1 align-baseline text-[11px] font-medium text-blue-700 transition-colors hover:bg-blue-100"
          >
            {refId}
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

  function renderAssistantAvatar(): ReactNode {
    return (
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-gray-900 text-[10px] font-semibold tracking-wide text-white">
        AI
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
              <div className="flex size-11 items-center justify-center rounded-full bg-gray-900 text-sm font-semibold text-white">
                AI
              </div>
              <p className="mt-2 text-base font-medium text-gray-800">开始新的对话</p>
              <p className="max-w-xs text-sm leading-relaxed text-gray-400">
                {scope === 'selected'
                  ? '在你选中的文档里提问，回答会标注出处。'
                  : scope === 'all'
                    ? '在所有已入库文档里提问，回答会标注出处。'
                    : '在这篇文档里提问，回答会标注引用页码。'}
              </p>
              <p className="mt-1 text-xs text-gray-400">输入 / 可调用指令</p>
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              {messages.map((message, index) => (
                <div key={message.id}>
                  {message.role === 'user' ? (
                    <div className="flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-blue-50 px-4 py-2.5 text-[15px] leading-relaxed text-gray-900 sm:max-w-[75%]">
                        {message.content}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start gap-3">
                      {renderAssistantAvatar()}
                      <div className="min-w-0 flex-1 pt-0.5">
                        <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-gray-800">
                          {message.content === '' && message.pending ? (
                            <span className="inline-flex items-center gap-1 py-1">
                              <span className="size-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.2s]" />
                              <span className="size-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.1s]" />
                              <span className="size-1.5 animate-bounce rounded-full bg-gray-400" />
                            </span>
                          ) : (
                            renderContent(message)
                          )}
                          {message.content !== '' && message.pending && (
                            <span
                              aria-hidden="true"
                              className="ml-0.5 inline-block h-4 w-[2px] translate-y-[2px] animate-pulse rounded-full bg-gray-800"
                            />
                          )}
                        </div>

                        {/* 全库检索时正文不写文件名，出处统一在回答下方回填标题，保证每条引用能看出是哪本书 */}
                        {message.citations.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {Array.from(
                              new Map(message.citations.map((item) => [item.refId, item])).values()
                            ).map((citation) => (
                              <button
                                key={`${message.id}-cite-${citation.refId}`}
                                type="button"
                                title={`p${citation.pageFrom}-${citation.pageTo ?? '?'}`}
                                onClick={() => onCitationOpen(citation)}
                                className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50"
                              >
                                <span className="font-medium text-gray-800">{citation.refId}</span>
                                <span className="max-w-[200px] truncate">{citation.documentTitle}</span>
                              </button>
                            ))}
                          </div>
                        )}

                        {message.error !== null && (
                          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">
                            <span className="min-w-0 flex-1 break-words">{message.error}</span>
                            <button
                              type="button"
                              className="shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
                              onClick={() => void send(previousQuestion(index))}
                              disabled={busy}
                            >
                              重试
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-gray-200/60 bg-white/80 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-3 pb-3 pt-3 sm:px-6">
          {input.trim() === '/' && (
            <div className="mb-2 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-lg shadow-gray-900/5">
              <SlashCommands
                commands={COMMANDS}
                onPick={(command) => {
                  setInput(`/${command.name} `);
                  setHint('');
                  textareaRef.current?.focus();
                }}
              />
            </div>
          )}

          {hint !== '' && <div className="mb-2 px-2 text-xs text-amber-600">{hint}</div>}

          <div className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white p-2 shadow-lg shadow-gray-900/5 transition-colors focus-within:border-gray-300">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setHint('');
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={!canAsk || busy}
              placeholder={canAsk ? '问点什么…（Enter 发送，Shift+Enter 换行）' : disabledReason}
              className="max-h-44 min-h-[36px] w-full flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-6 text-gray-900 outline-none placeholder:text-gray-400 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="button"
              aria-label="发送"
              onClick={() => void send(input)}
              disabled={!canAsk || busy || input.trim() === ''}
              className="mb-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-900 text-white transition-all hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
            >
              <ArrowUp className="size-4" strokeWidth={2.5} />
            </button>
          </div>

          <p className="mt-2 hidden text-center text-xs text-gray-400 sm:block">
            Enter 发送 · Shift + Enter 换行 · 输入 / 调用指令
          </p>

          {!canAsk && <div className="mt-2 px-2 text-xs text-amber-600">{disabledReason}</div>}
        </div>
      </div>
    </section>
  );
}
