import { gatewayWeekResetCredits, type GatewayAccount, type GatewayResetGrant } from "@space/contracts";
import { codexUsageWindows } from "@space/gateway";

/**
 * When a Codex or Claude reset credit is worth spending (brief 20261102-codex-reset-credits), as space_codex_reset_credits shows it.
 * Only the operator spends one, with the Resources button (operator 14/11 «Τα reset τα κανω μονο εγω!!!»). A credit gives the account a
 * fresh week, so it is worth it only on an account at its quota (a window under 5% left) whose own reset is far.
 */
export const CODEX_RESET_MANUAL_LEFT = 5;
/** A natural reset this near makes a credit a waste. */
export const CODEX_RESET_NEAR_MS = 6 * 3_600_000;

type Live = { left: number; resetAt: string | null };
export interface CodexResetState {
  id: string;
  provider: GatewayAccount["provider"];
  name: string;
  /** Week resets: Claude's weekly and full grants only (a Fable reset never gives a week, dev@ 14/11). */
  credits: number;
  grants: GatewayResetGrant[] | null;
  fiveHour: Live | null;
  week: Live | null;
  quotaExceeded: boolean;
}

const live = (window: GatewayAccount["primaryWindow"] | null, now: number): Live | null =>
  !window || window.usedPercent === null || (window.resetAt !== null && Date.parse(window.resetAt) <= now) ? null
    : { left: Math.max(0, Math.round((100 - window.usedPercent) * 10) / 10), resetAt: window.resetAt };

export function codexResetState(account: GatewayAccount, now: number): CodexResetState {
  const { fiveHour, weekly } = codexUsageWindows(account);
  return { id: account.id, provider: account.provider, name: account.alias ?? account.label, credits: gatewayWeekResetCredits(account), grants: account.resetCreditGrants ?? null,
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
  if (state.credits < 1) return `${state.name} has no week reset credit.`;
  const { blocked, backAt } = codexResetBlock(state, floor);
  if (!blocked) return `${state.name} is not used up (5-hour ${leftText(state.fiveHour)}, week ${leftText(state.week)}): a credit now would waste most of a week. `
    + `Spend one only when a window is under ${floor}% left.`;
  if (backAt !== null && backAt - now <= CODEX_RESET_NEAR_MS) return `${state.name} is back by itself ${time(new Date(backAt).toISOString())}, within 6 hours: a credit now would be wasted.`;
  return null;
}
