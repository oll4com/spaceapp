// Operator 5/11 «θελω να μην χανετε ουτε ενα tokens» (Nous's research 20261105-lost-tokens-november.md): what each subscription week left
// unused at its reset, in the Tokens line, the REVIEW and the Score, and a week about to reset with room told to Nous once.
import { describe, expect, it } from "vitest";
import type { GatewayAccountRecord } from "@space/db";
import { nousLowSpendSettingsSchema, type GatewayAccount, type GatewayLostWindow, type NousTurnFacts } from "@space/contracts";
import { lostAtResetText, nousLosingWeeks } from "../src/nous/lost-tokens.js";
import { renderTokenReview } from "../src/nous/token-review.js";
import { nousScore, type NousScoreInput } from "../src/nous/score.js";
import { computeNousTokens, renderNousTokenSummary } from "../src/nous/tokens.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
const iso = (at: number) => new Date(at).toISOString();
const record = (id: string, provider: GatewayAccountRecord["provider"], label: string): GatewayAccountRecord => ({
  id, provider, label, alias: null, email: null, planType: "max5x", status: "ACTIVE", statusReason: null, priority: 100, warmupEnabled: false, resetCreditsAvailable: null,
  primaryWindow: { usedPercent: 0, resetAt: null, windowMinutes: 300 }, secondaryWindow: { usedPercent: 0, resetAt: null, windowMinutes: 10080 }, lastRefreshAt: null, lastUsedAt: null,
  createdAt: iso(now - 30 * DAY), externalAccountId: id, credentialsEncrypted: "v1.secret", credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, blockedUntil: null
});
// A window as the Gateway's weeklyLostTokens gives it (its own test: gateway-lost-tokens.test.ts).
const lostWindow = (label: string, provider: GatewayLostWindow["provider"], quotaKey: string, resetAt: number, usedPercent: number,
  lostTokens: number | null, lostCostUsd: number | null): GatewayLostWindow => ({ accountId: `gw_account:${label}`, label, provider, planType: "max5x", quotaKey,
  week: iso(resetAt).slice(0, 10), resetAt: iso(resetAt), lastSampleAt: iso(resetAt - HOUR), usedPercent, lostPercent: 100 - usedPercent,
  tokensPerPercent: null, costUsdPerPercent: null, rateFrom: lostTokens === null ? null : "own", lostTokens, lostCostUsd });

describe("lost tokens at weekly resets", () => {
  it("names each ended week's unused share with its worth in the Tokens line, the REVIEW and the Score", () => {
    const opsReset = now - 2 * DAY;
    const rows = [lostWindow("spaceappdv", "ANTIGRAVITY", "claude", now - 3 * DAY, 11, null, null), lostWindow("ops", "CLAUDE", "", opsReset, 69, 310_000_000, 1550),
      lostWindow("crew", "CLAUDE", "", now - DAY, 100, 0, 0)];
    const text = lostAtResetText(rows, (at) => at.slice(0, 10));
    expect(text).toBe(`spaceappdv (claude) 89% at ${iso(now - 3 * DAY).slice(0, 10)}; ops 31% at ${iso(opsReset).slice(0, 10)} ≈ 310M tokens, $1,550; `
      + "1 other reset used in full; total 120 points ≈ 310M tokens, $1,550");
    expect(lostAtResetText([], String)).toBe("no weekly reset sampled");

    // The Tokens line, the REVIEW and the Score read the same rows.
    const tokens = { ...computeNousTokens({ accounts: [], settings: nousLowSpendSettingsSchema.parse({}), now }), lost: rows };
    expect(renderNousTokenSummary(tokens, "UTC", now)).toContain("; lost at weekly resets, last 7 days (UTC): spaceappdv (claude) 89% at ");
    const review = renderTokenReview({ facts: [] as NousTurnFacts[], projects: [], accounts: [], names: new Map(), since: iso(now - 30 * HOUR), day: iso(now - DAY).slice(0, 10), lost: rows });
    expect(review).toContain(`- Lost at weekly resets (room a week left unused when it reset; UTC), last 24 h: no week left room; 1 other reset used in full; last 7 days: spaceappdv (claude) 89%`);
    expect(review).toContain("The Score's Lost tokens variable: -11400 points for these 7 days (-95 a point).");
    const score = nousScore({ now, plans: [], completedPlans: [], requests: [], done: [], utilization: null, scorecard: null, panes: [], goals: [], dailyErrors: [], timeZone: "UTC",
      dailyTasks: [], taskRuns: [], messages: [], programs: [], projects: [], paneDays: [], lostAtResets: rows } satisfies NousScoreInput);
    // Operator 5/11 (nous_msg:b489788c): its own variable, Lost tokens, never inside Utilization.
    const lostTile = score.tiles.find((tile) => tile.key === "lostTokens")!;
    expect(lostTile.items.map((item) => [item.label, item.points])).toEqual([
      [`spaceappdv (claude) left 89% of its week at its reset ${iso(now - 3 * DAY).slice(0, 10)}`, -8455],
      [`ops left 31% of its week at its reset ${iso(opsReset).slice(0, 10)}`, -2945]]);
    expect(lostTile.detail).toBe("120 points of weeks left unused at their resets in 7 days ≈ 310M tokens, $1550");
    expect(score.tiles.find((tile) => tile.key === "utilization")).toMatchObject({ points: 0, items: [], detail: "no sample yet" });
  });

  it("names every week that resets within a day with more than 15% free, an Antigravity group's too", () => {
    const week = (usedPercent: number, inHours: number) => ({ usedPercent, resetAt: iso(now + inHours * HOUR), windowMinutes: 10080 });
    const fiveHour = { usedPercent: 0, resetAt: null, windowMinutes: 300 };
    const account = (id: string, extra: Partial<GatewayAccount>): GatewayAccount => ({ ...record(id, "CLAUDE", id), ...extra }) as GatewayAccount;
    const weeks = nousLosingWeeks([
      account("crew", { secondaryWindow: week(60, 10) }), account("dev", { secondaryWindow: week(90, 10) }), account("ops", { secondaryWindow: week(10, 30) }),
      account("paused", { status: "PAUSED", secondaryWindow: week(0, 2) }),
      account("agy", { provider: "ANTIGRAVITY", label: "spaceappdv", quotaGroups: [{ key: "claude", primaryWindow: fiveHour, secondaryWindow: week(52, 5) },
        { key: "gemini", primaryWindow: fiveHour, secondaryWindow: week(0, 50) }] } as Partial<GatewayAccount>)
    ], now);
    expect(weeks.map((entry) => [entry.name, entry.provider, entry.freePercent])).toEqual([["crew", "CLAUDE", 40], ["spaceappdv (claude)", "ANTIGRAVITY", 48]]);
    // The key names the week by its reset hour, so a few milliseconds of drift never tell it twice.
    expect(weeks[0]!.key).toBe(`crew::${Math.round((now + 10 * HOUR) / HOUR)}`);
  });
});
