import { zonedWallTimeToUtc } from "./dot-schedules.js";

/**
 * Token usage by process and provider (operator 5/11 17:26 BKK, plan clipboard:qH5emwVaV6yO): what consumed the tokens per day, week and
 * month, read from Space Gateway's request logs only. `day` is today in the owner's zone so far, `week` the last 7 days and `month` the last
 * 30 (each with today); the period before is the same span just before it, so a rise compares like with like.
 */
export const TOKEN_USAGE_PERIODS = ["day", "week", "month"] as const;
export type TokenUsagePeriod = typeof TOKEN_USAGE_PERIODS[number];
export const TOKEN_USAGE_PERIOD_DAYS: Record<TokenUsagePeriod, number> = { day: 1, week: 7, month: 30 };

/** Gateway figures: `inputTokens` holds every prompt token (cache re-reads and cache writes included), `costUsd` the API value. */
export interface TokenUsageFigures {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type TokenUsageProcessKind = "nous" | "pane" | "copilot" | "other";

/** One process: a Nous turn kind ("nous:INBOX"), a pane ("pane:<id>") or another gateway project tag. */
export interface TokenUsageProcess extends TokenUsageFigures {
  key: string;
  label: string;
  kind: TokenUsageProcessKind;
  /** The pane's room, copilot type, or what a Nous kind means. */
  detail: string | null;
  /** What a category gathers, largest first: each CLI outside panes, lab key or internal key; CLI panes' requests without a pane tag. */
  parts?: Array<TokenUsageFigures & { label: string }>;
}

export interface TokenUsageRiser {
  key: string;
  label: string;
  kind: TokenUsageProcessKind;
  /** Total tokens (input + output) this period and the period before. */
  tokens: number;
  before: number;
}

export interface TokenUsageBreakdown {
  period: TokenUsagePeriod;
  /** Set when the read was narrowed to one Space Gateway provider ("CLAUDE", "DEEPSEEK", ...): every figure below is that provider's. */
  provider?: string;
  timeZone: string;
  since: string;
  until: string;
  previousSince: string;
  previousUntil: string;
  totals: TokenUsageFigures;
  previousTotals: TokenUsageFigures;
  processes: TokenUsageProcess[];
  providers: Array<TokenUsageFigures & { key: string }>;
  /** By model, largest first (absent from servers before 8/11). */
  models?: Array<TokenUsageFigures & { key: string }>;
  /** Each day of the period in the owner's zone, total tokens per provider. */
  days: Array<{ day: string; providers: Record<string, number> }>;
  /** Up to ten processes that grew most against the period before. */
  risers: TokenUsageRiser[];
}

export const tokenUsageTotal = (figures: Pick<TokenUsageFigures, "inputTokens" | "outputTokens">) => figures.inputTokens + figures.outputTokens;

/** The period's span in the owner's zone, and the same span just before it. */
export function tokenUsageRange(period: TokenUsagePeriod, timeZone: string, now: number) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(new Date(now)).map((part) => [part.type, part.value]));
  const days = TOKEN_USAGE_PERIOD_DAYS[period];
  const start = zonedWallTimeToUtc(Number(parts.year), Number(parts.month) - 1, Number(parts.day) - (days - 1), 0, 0, timeZone);
  const span = now - start;
  const iso = (ms: number) => new Date(ms).toISOString();
  return { since: iso(start), until: iso(now), previousSince: iso(start - days * 86_400_000), previousUntil: iso(start - days * 86_400_000 + span) };
}
