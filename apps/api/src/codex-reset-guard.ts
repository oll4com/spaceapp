import { createHash } from "node:crypto";
import type { GatewayAccount } from "@space/contracts";
import { codexUsageWindows } from "@space/gateway";

/**
 * When a Codex weekly reset credit may be spent (operator 2/11 15:38 BKK, brief 20261102-codex-reset-credits), for Nous's
 * space_codex_reset_redeem and Space's automatic redemption. A credit gives the account a fresh week, so it is spent only on an
 * account at its quota whose own reset is far: Nous's floor is 5% left (2/11 ntheogr's used-up week read 2%), the automatic one 1%.
 */
export const CODEX_RESET_MANUAL_LEFT = 5;
export const CODEX_RESET_AUTO_LEFT = 1;
/** A natural reset this near makes a credit a waste. */
export const CODEX_RESET_NEAR_MS = 6 * 3_600_000;

type Live = { left: number; resetAt: string | null };
export interface CodexResetState {
  id: string;
  name: string;
  credits: number;
  fiveHour: Live | null;
  week: Live | null;
  quotaExceeded: boolean;
}

const live = (window: GatewayAccount["primaryWindow"] | null, now: number): Live | null =>
  !window || window.usedPercent === null || (window.resetAt !== null && Date.parse(window.resetAt) <= now) ? null
    : { left: Math.max(0, Math.round((100 - window.usedPercent) * 10) / 10), resetAt: window.resetAt };

export function codexResetState(account: GatewayAccount, now: number): CodexResetState {
  const { fiveHour, weekly } = codexUsageWindows(account);
  return { id: account.id, name: account.alias ?? account.label, credits: account.resetCreditsAvailable ?? 0,
    fiveHour: live(fiveHour, now), week: live(weekly, now), quotaExceeded: account.status === "QUOTA_EXCEEDED" };
}

/** The windows under `floor` left (Gateway's QUOTA_EXCEEDED counts as the week), and when the last of them resets by itself. */
export function codexResetBlock(state: CodexResetState, floor: number): { blocked: boolean; backAt: number | null } {
  const blocking = [state.fiveHour, state.week].filter((window): window is Live => window !== null && window.left < floor);
  if (state.quotaExceeded && !blocking.length && state.week) blocking.push(state.week);
  const resets = blocking.map((window) => Date.parse(window.resetAt ?? ""));
  return { blocked: blocking.length > 0 || state.quotaExceeded, backAt: resets.length && resets.every(Number.isFinite) ? Math.max(...resets) : null };
}

const leftText = (window: Live | null) => window ? `${Math.round(window.left)}% left` : "no current sample";

/** Why a credit may not be spent now, or null when it may. */
export function codexResetRefusal(state: CodexResetState, now: number, floor: number, time: (iso: string) => string): string | null {
  if (state.credits < 1) return `${state.name} has no reset credit.`;
  const { blocked, backAt } = codexResetBlock(state, floor);
  if (!blocked) return `${state.name} is not used up (5-hour ${leftText(state.fiveHour)}, week ${leftText(state.week)}): a credit now would waste most of a week. `
    + `Spend one only when a window is under ${floor}% left.`;
  if (backAt !== null && backAt - now <= CODEX_RESET_NEAR_MS) return `${state.name} is back by itself ${time(new Date(backAt).toISOString())}, within 6 hours: a credit now would be wasted.`;
  return null;
}

/**
 * One key per account and week: upstream spends at most one credit for a key (redeem_request_id), so a repeat, a second caller or
 * an API restart never spends two. The reset time is rounded to the hour, as Codex's relative samples move it by seconds.
 */
export function codexResetKey(accountId: string, weekResetAt: string | null): string {
  const reset = Date.parse(weekResetAt ?? "");
  const window = Number.isFinite(reset) ? new Date(Math.round(reset / 3_600_000) * 3_600_000).toISOString() : "no-week";
  const hex = createHash("sha256").update(`codex-reset-credit:${accountId}:${window}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (parseInt(hex[16]!, 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
