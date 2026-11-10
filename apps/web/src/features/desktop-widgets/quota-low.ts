import type {
  AntigravityUsageAccountList,
  ClaudeUsageAccountList,
  CodexUsageAccountList,
} from "@space/contracts";

/** Under this share left in a subscription window, the quota icons turn red (operator 2026-10-31, plan clipboard:mjpENip0ilmC). */
export const QUOTA_LOW_PERCENT = 5;

export interface QuotaLowSources {
  codex?: CodexUsageAccountList | null;
  agy?: AntigravityUsageAccountList | null;
  claude?: ClaudeUsageAccountList | null;
}

interface Window {
  fiveHourRemainingPercent?: number | null;
  fiveHourResetAt?: string | null;
  weeklyRemainingPercent?: number | null;
  weeklyResetAt?: string | null;
}

/**
 * "Codex: 3% left (weekly)" for the lowest 5-hour or weekly window under 5% across every reporting Codex, Antigravity and Claude
 * subscription account, one entry per provider and window and never an account (operator 6/11; " · 2 more under 5%" when other
 * provider windows are); null when none is. Unknown data never counts. API
 * providers' budgets never count (operator 2/11 nous_msg:41ddfd8f3a864c62b17395f0: OpenRouter at $0.00 of $15 turned Quotas red).
 */
export function lowQuotaText(sources: QuotaLowSources | null | undefined, clock: number): string | null {
  const byWindow = new Map<string, { label: string; percent: number; window: string }>();
  const check = (label: string, percent: number | null | undefined, resetAt: string | null | undefined, window: string) => {
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent >= QUOTA_LOW_PERCENT) return;
    // A window whose reset has passed has refilled; its old sample says nothing.
    if (resetAt && Date.parse(resetAt) <= clock) return;
    // The provider's lowest account speaks for the window.
    const key = `${label}\n${window}`;
    if (percent < (byWindow.get(key)?.percent ?? Infinity)) byWindow.set(key, { label, percent, window });
  };
  const windows = (label: string, quota: Window | null | undefined) => {
    check(label, quota?.fiveHourRemainingPercent, quota?.fiveHourResetAt, "5h");
    check(label, quota?.weeklyRemainingPercent, quota?.weeklyResetAt, "weekly");
  };
  for (const account of sources?.codex?.data ?? []) windows("Codex", account);
  for (const account of sources?.agy?.data ?? []) {
    if (account.status !== "CONNECTED") continue;
    windows("Antigravity Gemini", account.gemini);
    windows("Antigravity Claude · GPT", account.claude);
  }
  for (const account of claudeSubscriptionAccounts(sources?.claude)) windows("Claude", account);
  const low = [...byWindow.values()].sort((left, right) => left.percent - right.percent);
  const first = low[0];
  if (!first) return null;
  const more = low.length > 1 ? ` · ${low.length - 1} more under ${QUOTA_LOW_PERCENT}%` : "";
  return `${first.label}: ${Math.floor(first.percent)}% left (${first.window})${more}`;
}

/** The Claude subscription accounts with their windows, each once: the gateway's pool lists the CONNECTED profiles' accounts again, by alias or email's local part. */
export function claudeSubscriptionAccounts(list: ClaudeUsageAccountList | null | undefined): Array<Window & { label: string }> {
  const claude = list?.data ?? [];
  const seen = new Set<string>();
  const accounts: Array<Window & { label: string }> = [];
  for (const account of claude) {
    if (account.status !== "CONNECTED") continue;
    accounts.push(account);
    for (const key of [account.label, account.email, account.email?.split("@")[0]]) if (key) seen.add(key.toLowerCase());
  }
  for (const member of claude.flatMap((account) => account.pool ?? [])) {
    if (member.signInRequired || seen.has(member.label.toLowerCase())) continue;
    seen.add(member.label.toLowerCase());
    accounts.push(member);
  }
  return accounts;
}
