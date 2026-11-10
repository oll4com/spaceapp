import type { GatewayAccount, GatewayLostWindow } from "@space/contracts";

/**
 * Lost tokens (operator 5/11 «θελω να μην χανετε ουτε ενα tokens», Nous's research 20261105-lost-tokens-november.md): a subscription week
 * that resets with room left loses that room. The Tokens line, the daily REVIEW and the Score read the Gateway's weekly lost-token windows
 * (`weeklyLostTokens`, apps/api/src/gateway/lost-tokens.ts, the one computation of the report too), and a week about to reset with room
 * left reaches Nous as an inbox line once (`nousLosingWeeks`).
 */
/** Nous's notes that keep the held Low-spend mode and the losing weeks it was told of; never shown in its world. */
export const NOUS_TOKEN_NOTE_PREFIX = "token-state:";
export const NOUS_LOSING_WEEK = { withinMs: 86_400_000, freePercent: 15 } as const;

export const tokenCount = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)}B` : value >= 1e6 ? `${Math.round(value / 1e6)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);
export type NousLostRow = Pick<GatewayLostWindow, "label" | "quotaKey" | "resetAt" | "lostPercent" | "lostTokens" | "lostCostUsd">;
const lostName = (row: NousLostRow) => `${row.label}${row.quotaKey ? ` (${row.quotaKey})` : ""}`;

/** "ops 31% at 1 Nov, 16:00 ≈ 5.8B tokens, $1,630; 2 other resets used in full; total 69 points ≈ 5.8B tokens, $1,630". */
export function lostAtResetText(rows: NousLostRow[], when: (value: string) => string): string {
  if (!rows.length) return "no weekly reset sampled";
  const lost = rows.filter((row) => row.lostPercent >= 1);
  const worth = (tokens: number | null, costUsd: number | null) => tokens === null ? "" : ` ≈ ${tokenCount(tokens)} tokens, $${Math.round(costUsd ?? 0).toLocaleString("en-US")}`;
  const priced = lost.filter((row) => row.lostTokens !== null);
  const full = rows.length - lost.length;
  return [lost.map((row) => `${lostName(row)} ${row.lostPercent}% at ${when(row.resetAt)}${worth(row.lostTokens, row.lostCostUsd)}`).join("; ") || "no week left room",
    ...(full ? [`${full} other reset${full === 1 ? "" : "s"} used in full`] : []),
    ...(lost.length ? [`total ${Math.round(lost.reduce((sum, row) => sum + row.lostPercent, 0) * 10) / 10} points${priced.length
      ? worth(priced.reduce((sum, row) => sum + row.lostTokens!, 0), priced.reduce((sum, row) => sum + (row.lostCostUsd ?? 0), 0)) : ""}`] : [])].join("; ");
}

/** Every subscription week (an Antigravity quota group's too) that resets within a day with more than 15% free now. */
export function nousLosingWeeks(accounts: GatewayAccount[] | null, now: number): Array<{ key: string; name: string; provider: string; freePercent: number; resetAt: string }> {
  return (accounts ?? []).filter((account) => account.planType !== "api" && !["PAUSED", "DEACTIVATED"].includes(account.status)).flatMap((account) => {
    const scopes = account.quotaGroups?.length ? account.quotaGroups.map((group) => ({ group: group.key, windows: group })) : [{ group: null, windows: account }];
    return scopes.flatMap(({ group, windows }) => {
      const week = [windows.primaryWindow, windows.secondaryWindow].find((window) => window.windowMinutes === 10_080 && window.usedPercent !== null && window.resetAt);
      const reset = Date.parse(week?.resetAt ?? "");
      if (!week || !(reset > now) || reset - now > NOUS_LOSING_WEEK.withinMs || 100 - week.usedPercent! <= NOUS_LOSING_WEEK.freePercent) return [];
      // The reset hour names the week: its reset time moves by milliseconds between samples.
      return [{ key: `${account.id}:${group ?? ""}:${Math.round(reset / 3_600_000)}`, name: `${account.alias ?? account.label}${group ? ` (${group})` : ""}`,
        provider: account.provider, freePercent: Math.round(100 - week.usedPercent!), resetAt: week.resetAt! }];
    });
  });
}
