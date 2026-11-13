// 斜杠指令：只放元数据、解析、字符串模板与上下文拼装，不调模型、不碰数据库。
// 客户端拿 COMMANDS/解析函数，服务端拿模板拼 prompt，两边都不会引入重型依赖。
import type { Retrieved } from './types.ts';

export type CommandName = 'summarize' | 'outline' | 'explain' | 'compare';

export interface CommandSpec {
  name: CommandName;
  description: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: 'summarize', description: '总结当前范围的核心要点，按标题分组' },
  { name: 'outline', description: '输出层级大纲，只看结构' },
  { name: 'explain', description: '解释选中的原文，保留原段落引用' },
  { name: 'compare', description: '对比两章或两篇，输出分歧点与出处' },
];

const COMMAND_NAMES = new Set<string>(COMMANDS.map((item) => item.name));

export function isCommandName(value: unknown): value is CommandName {
  return typeof value === 'string' && COMMAND_NAMES.has(value);
}

export type SlashParseResult =
  | { kind: 'plain' }
  | { kind: 'menu' }
  | { kind: 'unknown'; token: string }
  | { kind: 'command'; command: CommandName; args: string };

/**
 * 解析输入框内容：
 * - 不以 "/" 开头 → plain，走普通问答
 * - 只有一个 "/" → menu，弹出指令列表
 * - "/xxx" 不存在 → unknown，提示没有这个指令
 * - 命中指令 → command，args 是 "/" 之后的全部文本
 */
export function parseSlashInput(raw: string): SlashParseResult {
  const text = raw.trim();
  if (!text.startsWith('/')) return { kind: 'plain' };

  const rest = text.slice(1);
  const spaceIndex = rest.search(/\s/);
  const token = (spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)).toLowerCase();
  const args = spaceIndex === -1 ? '' : rest.slice(spaceIndex + 1).trim();

  if (token === '') return { kind: 'menu' };
  if (!isCommandName(token)) return { kind: 'unknown', token };
  return { kind: 'command', command: token, args };
}

const COMPARE_SEPARATORS = [' vs ', ' VS ', ' Vs ', ' 对比 ', ' 和 ', ' 与 ', '、', '，', ',', '|'];

/**
 * 解析 /compare 的两个对比对象。支持 "A vs B"、"A、B"、"A 和 B" 或恰好两个空格分隔的词。
 * 解析不到就返回 null，由调用方追问一次。
 */
export function parseCompareArgs(raw: string): [string, string] | null {
  const text = raw.trim();
  if (text === '') return null;

  for (const separator of COMPARE_SEPARATORS) {
    const parts = text
      .split(separator)
      .map((item) => item.trim())
      .filter((item) => item !== '');
    if (parts.length === 2) return [parts[0], parts[1]];
    if (parts.length > 2) return null;
  }

  const tokens = text.split(/\s+/).filter((item) => item !== '');
  return tokens.length === 2 ? [tokens[0], tokens[1]] : null;
}

export interface CommandRetrievalParams {
  topK: number;
  maxParents: number;
}

/** 每条指令自己的检索参数。explain 不检索；outline 直接按父块顺序取结构。 */
export const COMMAND_RETRIEVAL: Record<CommandName, CommandRetrievalParams> = {
  summarize: { topK: 60, maxParents: 16 },
  outline: { topK: 0, maxParents: 60 },
  explain: { topK: 0, maxParents: 0 },
  compare: { topK: 30, maxParents: 6 },
};

export const COMMAND_DEFAULT_QUERY: Record<'summarize' | 'outline', string> = {
  summarize: '核心要点 主要观点 结论',
  outline: '章节 目录 结构 标题',
};

export interface CompareSide {
  label: string;
  parents: Retrieved[];
}

/** 指令模板只追加一段指令说明，五条铁律始终来自 lib/prompt.ts 的 buildSystemPrompt。 */
const SYSTEM_ADDONS: Record<CommandName, string> = {
  summarize:
    '【当前指令：总结】按 headingPath 分组总结核心要点，每组 1-3 句；不要逐段复述，不要展开到资料之外。',
  outline:
    '【当前指令：大纲】只输出层级大纲，用 markdown 缩进列表，不要任何解释、前言或总结。标题原样输出；' +
    '如果资料里没有 headingPath，就按父块序号输出一级大纲，格式为「- 父块 {parentIndex}」。' +
    '全部文档范围时，以文档标题作为一级。',
  explain:
    '【当前指令：解释】解释用户选中的原文，用通俗语言，面向没读过原文的人；先用 > 引用块原样保留原段落，再解释。',
  compare:
    '【当前指令：对比】必须按「分歧点 / 各自出处」结构输出，不要写成两段摘要。' +
    '每个分歧点写清 A 的观点、B 的观点和各自出处（文档标题 + headingPath）。' +
    '本指令要求写出处，覆盖铁律 5 里“不要写文件名/第几章”的限制。',
};

const USER_TASKS: Record<CommandName, string> = {
  summarize: '请总结【资料】的核心要点：按 headingPath 分组，每组 1-3 句。',
  outline: '请只输出【资料】的层级大纲：markdown 缩进列表，不要解释。',
  explain: '请解释上面这段原文，用通俗语言；先原样引用原段落，再解释。',
  compare:
    '请对比资料 A 和资料 B 的核心差异，严格按「分歧点 / 各自出处」格式输出，不要分别写两段摘要。',
};

export function buildCommandSystemPrompt(command: CommandName, base: string): string {
  return `${base}\n\n${SYSTEM_ADDONS[command]}`;
}

export function buildCommandUserMessage(command: CommandName, body: string): string {
  return `${body}\n\n【任务】\n${USER_TASKS[command]}`;
}

/** /outline 专用：把 headingPath 与父块序号直接摊开，标题全空时模型仍能按序号出大纲。 */
export function buildOutlineContext(parents: Retrieved[]): string {
  if (parents.length === 0) return '【资料】\n（无）';

  const blocks = parents.map((parent) => {
    const heading =
      parent.headingPath === null || parent.headingPath.trim() === ''
        ? `(无标题，父块 ${parent.parentIndex})`
        : parent.headingPath;
    const snippet = parent.content.replace(/\s+/g, ' ').slice(0, 120);
    return `[${parent.documentTitle}] ${heading}\n${snippet}`;
  });

  return `【资料】\n${blocks.join('\n\n')}`;
}

/** /compare 专用：A/B 两组资料分开标注，保证模型能写出各自的文档标题与 headingPath。 */
export function buildCompareContext(sides: readonly CompareSide[]): string {
  const names = ['A', 'B'];

  return sides
    .map((side, index) => {
      const label = names[index] ?? String(index + 1);
      const body =
        side.parents.length === 0
          ? '（无）'
          : side.parents
              .map((parent) => `[${parent.documentTitle}] ${parent.headingPath ?? '(无标题)'}\n${parent.content}`)
              .join('\n\n');
      return `【资料 ${label}：${side.label}】\n${body}`;
    })
    .join('\n\n');
}

/** 参数缺失时统一用这句话追问一次。 */
export function buildAskMessage(command: CommandName, scope: 'current' | 'all'): string {
  if (command === 'compare') {
    return scope === 'all'
      ? '请写清要对比的两份文档标题，例如：/compare 文档A vs 文档B'
      : '请写清要对比的两个章节，例如：/compare 第一章 vs 第二章';
  }
  if (command === 'explain') {
    return '请先选中要解释的原文，或写在 /explain 后面，例如：/explain 缓存击穿是……';
  }
  return '';
}
