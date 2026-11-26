import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gatewayPaceDay, gatewayWeekResetCredits, quotaResetCredits, quotaResetCreditsText, subscriptionQuotaAtReset, type GatewayAccount } from "@space/contracts";
import * as guard from "../src/codex-reset-guard.js";
import { codexResetRefusal, codexResetState } from "../src/codex-reset-guard.js";
import * as resetCredits from "../src/nous/reset-credits.js";
import { createNousResetCredits } from "../src/nous/reset-credits.js";
import { NOUS_SUBAGENT_EXCLUDED } from "../src/nous/subagents.js";
import { nousToolDefinitions } from "../src/nous/tools.js";
import { nousProviderAdvice, nousProviderRooms, nousProviderRoomText } from "../src/nous/tokens.js";

const adminScript = new URL("../../../scripts/space-admin-action.mjs", import.meta.url);
// The operator's admin actions are not exported: the public tree checks the API side alone.
const admin = existsSync(adminScript) ? await import(adminScript.href) : null;

// 2/11 15:38 BKK: ntheogr's week used up (2% left), back Wed 4/11 13:43 BKK, 2 credits.
const now = Date.parse("2026-11-02T09:00:00Z");
const weekReset = "2026-11-04T06:43:12.345Z";
const account = (id: string, weekUsed: number, extra: Partial<GatewayAccount> = {}): GatewayAccount => ({
  id, provider: "CODEX", label: `${id.slice(-4)}@gmail.com`, alias: null, email: `${id.slice(-4)}@gmail.com`, planType: "plus", status: "ACTIVE", statusReason: null,
  priority: 0, warmupEnabled: false, resetCreditsAvailable: 2, lastRefreshAt: null, lastUsedAt: null, createdAt: new Date(now).toISOString(),
  primaryWindow: { usedPercent: 0, resetAt: "2026-11-02T13:00:00.000Z", windowMinutes: 300 },
  secondaryWindow: { usedPercent: weekUsed, resetAt: weekReset, windowMinutes: 10080 }, ...extra
});
const used = account(`gw_account:${"a".repeat(32)}`, 98, { label: "ntheogr@gmail.com", email: "ntheogr@gmail.com" });
const fresh = account(`gw_account:${"b".repeat(32)}`, 40);
const time = (iso: string) => iso;

describe("Codex reset credits", () => {
  it("counts the pool's credits as weeks", () => {
    const total = quotaResetCredits([{ resetCredits: 2 }, { resetCredits: 2 }, { resetCredits: null }, { resetCredits: 0 }]);
    expect(total).toEqual({ credits: 4, accounts: 4, weekPercent: 100 });
    expect(quotaResetCreditsText(total!)).toBe("+4 resets (≈ +100% of a week)");
    expect(quotaResetCredits([{ resetCredits: 0 }])).toBeNull();
  });

  it("calls a credit worth spending only on a used-up account whose own reset is far", () => {
    expect(codexResetRefusal(codexResetState(used, now), now, 5, time)).toBeNull();
    expect(codexResetRefusal(codexResetState(fresh, now), now, 5, time)).toMatch(/not used up/);
    expect(codexResetRefusal(codexResetState({ ...used, resetCreditsAvailable: 0 }, now), now, 5, time)).toMatch(/no week reset credit/);
    const near = { ...used, secondaryWindow: { ...used.secondaryWindow, resetAt: new Date(now + 5 * 3_600_000).toISOString() } };
    expect(codexResetRefusal(codexResetState(near, now), now, 5, time)).toMatch(/within 6 hours/);
    expect(codexResetRefusal(codexResetState({ ...fresh, status: "QUOTA_EXCEEDED" }, now), now, 5, time)).toBeNull();
  });

  it("the admin action reads the same view, and Nous lists the credits read only", async () => {
    if (admin) expect(admin.codexResetView(used, now)).toMatchObject({ credits: 2, weekLeft: 2, redeemable: true });
    if (admin) expect(admin.codexResetView(fresh, now)).toMatchObject({ redeemable: false, why: expect.stringMatching(/not used up/) });
    const nous = createNousResetCredits({ accounts: async () => [used, fresh], zone: async () => "Asia/Bangkok", now: () => now });
    expect(Object.keys(nous)).toEqual(["list"]);
    const listed = await nous.list("user:operator");
    expect(listed.result).toContain("+4 resets (≈ +200% of a week) over 2 Codex and Claude accounts");
    expect(listed.result).toContain("only the operator spends one, with the Resources button; you never spend one or ask anyone to");
    expect(listed.result).toMatch(/ntheogr@gmail.com .*2 credits; week 2% left.*worth spending now \(the operator's call\)/);
    expect(listed.result).not.toMatch(/space_codex_reset_redeem|spends them by itself/);
  });

  // Operator 14/11 «Τα reset τα κανω μονο εγω!!!»: only the Resources button spends a credit.
  it("leaves no automatic, Nous, helper or agent path that spends a credit", () => {
    const names = nousToolDefinitions({ copilots: true }).map((tool) => tool.name);
    expect(names).toContain("space_codex_reset_credits");
    expect(names).not.toContain("space_codex_reset_redeem");
    expect(NOUS_SUBAGENT_EXCLUDED.has("space_codex_reset_redeem")).toBe(false);
    expect(Object.keys(resetCredits).filter((name) => /redeem|auto/i.test(name))).toEqual([]);
    expect(Object.keys(guard).filter((name) => /AUTO|Key$/.test(name))).toEqual([]);
    if (admin) expect(admin.actions["codex-reset-redeem"]).toBeUndefined();
    if (admin) expect(admin.actions["codex-reset-credits"]).toBeTypeOf("function");
  });

  it("counts the credits in the at-reset figure and Nous's provider room, never as no room", () => {
    expect(subscriptionQuotaAtReset("codex", [{ weeklyRemainingPercent: 2, weeklyResetAt: weekReset, resetCredits: 2 }, { weeklyRemainingPercent: 60, weeklyResetAt: weekReset, resetCredits: 2 }], now)[0])
      .toMatchObject({ resetCredits: { credits: 4, accounts: 2, weekPercent: 200 } });
    expect(subscriptionQuotaAtReset("codex", [{ weeklyRemainingPercent: 2, weeklyResetAt: weekReset, resetCredits: 0 }], now)[0]).not.toHaveProperty("resetCredits");
    const dry = { ...used, status: "QUOTA_EXCEEDED" as const };
    const codex = nousProviderRooms([dry, { ...dry, id: fresh.id }], null, now).find((room) => room.key === "codex")!;
    expect(codex.resetCredits).toEqual({ credits: 4, accounts: 2, weekPercent: 200 });
    expect(nousProviderRoomText(codex)).toContain("+4 resets (≈ +200% of a week)");
    expect(nousProviderAdvice([codex]).avoid).toEqual([]);
    const spentOut = nousProviderRooms([{ ...dry, resetCreditsAvailable: 0 }], null, now).find((room) => room.key === "codex")!;
    expect(nousProviderAdvice([spentOut]).avoid.map((entry) => entry.why)).toEqual(["no room now"]);
  });

  // Operator 14/11 11:06 BKK: crew@ at 100% of its week (back 16/11) holds Claude limit resets that Space ignored.
  it("counts Claude limit resets that give a week, and lists them read only", async () => {
    const grants = [{ kind: "session" as const, left: 3, endsAt: null }, { kind: "full" as const, left: 2, endsAt: "2026-12-01T00:00:00.000Z" }];
    const crew = account(`gw_account:${"c".repeat(32)}`, 100, { provider: "CLAUDE", label: "crew@spaceapp.dev", email: "crew@spaceapp.dev", planType: "max20x",
      resetCreditsAvailable: 5, resetCreditGrants: grants });
    expect(gatewayWeekResetCredits(crew)).toBe(2);
    expect(gatewayWeekResetCredits({ resetCreditGrants: [{ kind: "fable", left: 1, endsAt: "2027-03-09T07:59:00.000Z" }] })).toBe(0);
    expect(gatewayWeekResetCredits({ resetCreditsAvailable: 2 })).toBe(2);
    // Today's share grows by one week per credit: (100 × 3 - 90) / 3 days, not (100 - 90) / 3.
    const reset = now + 2.5 * 86_400_000;
    expect(gatewayPaceDay({ usedPercent: 90, resetAt: reset, credits: 2 }, null, now)).toMatchObject({ allowancePercent: 70, capped: false });
    expect(gatewayPaceDay({ usedPercent: 90, resetAt: reset }, null, now)?.allowancePercent).toBeCloseTo(10 / 3);
    // The at-reset figure counts each pool member once, even when a signed-in profile counted the account first.
    const member = { label: "crew", signInRequired: false, weeklyRemainingPercent: 0, weeklyResetAt: weekReset, resetCredits: 2 };
    expect(subscriptionQuotaAtReset("claude", [{ status: "CONNECTED", label: "crew", weeklyRemainingPercent: 0, weeklyResetAt: weekReset, pool: [member, member] }], now)[0])
      .toMatchObject({ resetCredits: { credits: 2, accounts: 1, weekPercent: 200 } });

    const nous = createNousResetCredits({ accounts: async () => [crew], zone: async () => "Asia/Bangkok", now: () => now });
    expect((await nous.list("user:operator")).result).toMatch(/crew@spaceapp\.dev \[gw_account:c+, Claude\]: 2 full resets \(5-hour window and a fresh week\), 3 session resets \(5-hour window only\); week 0% left/);
  });

  // dev@ 14/11: "Reset credit applied" left the week at 93%; the live accounts hold only Fable grants, which the "+80% of a week" counted.
  it("never counts a Fable grant as a week: Nous's total, its lines, the guard and the provider room", async () => {
    const fable = (digit: string) => account(`gw_account:${digit.repeat(32)}`, 100, { provider: "CLAUDE", label: `${digit}@spaceapp.dev`, planType: "max20x",
      resetCreditsAvailable: 1, resetCreditGrants: [{ kind: "fable" as const, left: 1, endsAt: "2027-03-09T07:59:00.000Z" }] });
    const pool = ["c", "d", "e", "f"].map(fable);
    const listed = (await createNousResetCredits({ accounts: async () => pool, zone: async () => "Asia/Bangkok", now: () => now }).list("user:operator")).result;
    expect(listed).toContain("Week reset credits: none over 4 Codex and Claude accounts");
    expect(listed).toMatch(/c@spaceapp\.dev .*: 1 Fable reset \(Fable usage only, never a week\); week 0% left.*not worth spending now \(c@spaceapp\.dev has no week reset credit\.\)/);
    if (admin) expect(admin.codexResetView(pool[0], now)).toMatchObject({ credits: 0, grants: [{ kind: "fable", left: 1 }], redeemable: false, why: "no week reset credit" });
    const claude = nousProviderRooms(pool, null, now).find((room) => room.key === "claude")!;
    expect(claude.resetCredits ?? null).toBeNull();
    expect(nousProviderRoomText(claude)).not.toMatch(/of a week/);
  });
});
