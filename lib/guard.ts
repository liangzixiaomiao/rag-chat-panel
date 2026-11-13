// 用量护栏：按天记账，超额直接拒绝，不降级到别的模型（混维度会毁掉检索）。
import { serverClient } from './db.ts';

const DEFAULT_DAILY_TOKEN_CAP = 100000;

export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaError';
  }
}

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** 每次调用都读环境变量，方便验收时临时调小 cap。 */
function dailyCap(): number {
  const raw = Number(process.env.DAILY_TOKEN_CAP ?? DEFAULT_DAILY_TOKEN_CAP);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_TOKEN_CAP;
}

export function todayTokens(): number {
  const row = serverClient()
    .prepare('select tokens from usage where date = ?')
    .get(today()) as { tokens: number } | undefined;
  return row?.tokens ?? 0;
}

export function canSpend(estTokens: number): boolean {
  return todayTokens() + estTokens <= dailyCap();
}

export function recordUsage(tokens: number): void {
  serverClient()
    .prepare(
      `insert into usage (date, calls, tokens) values (?, 1, ?)
       on conflict(date) do update set calls = calls + 1, tokens = tokens + excluded.tokens`
    )
    .run(today(), tokens);
}
