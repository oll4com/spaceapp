import { describe, expect, it, vi } from "vitest";
import { quotaResetCredits, quotaResetCreditsText, subscriptionQuotaAtReset, type GatewayAccount } from "@space/contracts";
import { CODEX_RESET_AUTO_LEFT, codexResetKey, codexResetRefusal, codexResetState } from "../src/codex-reset-guard.js";
import { codexResetAutoText, createCodexResetAuto, createNousResetCredits } from "../src/nous/reset-credits.js";
import { nousProviderAdvice, nousProviderRooms, nousProviderRoomText } from "../src/nous/tokens.js";

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

  it("allows a credit only on a used-up account whose own reset is far", () => {
    expect(codexResetRefusal(codexResetState(used, now), now, 5, time)).toBeNull();
    expect(codexResetRefusal(codexResetState(used, now), now, CODEX_RESET_AUTO_LEFT, time)).toMatch(/not used up/);
    expect(codexResetRefusal(codexResetState(fresh, now), now, 5, time)).toMatch(/not used up/);
    expect(codexResetRefusal(codexResetState({ ...used, resetCreditsAvailable: 0 }, now), now, 5, time)).toMatch(/no reset credit/);
    const near = { ...used, secondaryWindow: { ...used.secondaryWindow, resetAt: new Date(now + 5 * 3_600_000).toISOString() } };
    expect(codexResetRefusal(codexResetState(near, now), now, 5, time)).toMatch(/within 6 hours/);
    expect(codexResetRefusal(codexResetState({ ...fresh, status: "QUOTA_EXCEEDED" }, now), now, 5, time)).toBeNull();
  });

  it("keys one credit per account and week, the same in the admin action", () => {
    const key = codexResetKey(used.id, weekReset);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(codexResetKey(used.id, "2026-11-04T06:43:40.001Z")).toBe(key);
    expect(codexResetKey(used.id, "2026-11-11T06:43:12.345Z")).not.toBe(key);
    expect(codexResetKey(fresh.id, weekReset)).not.toBe(key);
  });

  it("lets Nous list and spend one, refusing what would waste it, and audits each spend", async () => {
    const redeem = vi.fn(async (accountId: string) => ({ response: { accountId, outcome: "RESET" as const, completedAt: new Date(now).toISOString() },
      audit: { outcome: "RESET" as const, usageVerified: true, creditIdHash: null } }));
    const audit = vi.fn(async () => undefined);
    const nous = createNousResetCredits({ accounts: async () => [used, fresh], service: { availability: vi.fn(), redeem }, audit, zone: async () => "Asia/Bangkok", now: () => now });

    const listed = await nous.list("user:operator");
    expect(listed.result).toContain("+4 resets (≈ +200% of a week) over 2 accounts");
    expect(listed.result).toMatch(/ntheogr@gmail.com .*2 credits; week 2% left.*redeemable now/);

    expect((await nous.redeem("user:operator", { account: "nobody" })).result).toMatch(/No Codex account is named nobody/);
    const refused = await nous.redeem("user:operator", { account: fresh.label });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.result).toMatch(/not used up.*Nothing spent/);
    expect(refused.refused).toBe(true);
    expect(redeem).not.toHaveBeenCalled();

    const spent = await nous.redeem("user:operator", { account: "ntheogr" });
    expect(spent).toMatchObject({ ok: true, display: "Codex reset credit on ntheogr@gmail.com: RESET" });
    const again = await nous.redeem("user:operator", { account: "ntheogr@gmail.com" });
    expect(again.ok).toBe(true);
    expect(redeem.mock.calls.map(([, key]) => key)).toEqual([codexResetKey(used.id, weekReset), codexResetKey(used.id, weekReset)]);
    expect(audit).toHaveBeenCalledWith("user:operator", { accountId: used.id, outcome: "RESET", idempotencyKey: codexResetKey(used.id, weekReset) });
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

  it("spends one credit by itself only when an account is used up, its reset is far and Codex work waits", async () => {
    const dry = { ...used, status: "QUOTA_EXCEEDED" as const, secondaryWindow: { ...used.secondaryWindow, usedPercent: 100 } };
    const redeem = vi.fn(async (accountId: string) => ({ response: { accountId, outcome: "RESET" as const, completedAt: new Date(now).toISOString() },
      audit: { outcome: "RESET" as const, usageVerified: true, creditIdHash: null } }));
    const run = (accounts: GatewayAccount[], refused = false) => createCodexResetAuto({ accounts: async () => accounts, service: { availability: vi.fn(), redeem },
      refusedSince: async () => refused, now: () => now });

    // Exhausted, far reset, credits, no other usable account: one spend, and a second tick spends nothing.
    const auto = run([dry]);
    const spent = await auto.tick();
    expect(spent).toMatchObject({ outcome: "RESET", state: { id: used.id }, idempotencyKey: codexResetKey(used.id, weekReset) });
    expect(codexResetAutoText(spent!).title).toBe("Codex reset credit spent: ntheogr@gmail.com has a fresh week");
    expect(await auto.tick()).toBeNull();
    expect(redeem).toHaveBeenCalledTimes(1);

    // Another usable account and no Codex request refused: no demand. With a refusal: one spend.
    expect(await run([dry, fresh]).tick()).toBeNull();
    expect(await run([dry, fresh], true).tick()).toMatchObject({ outcome: "RESET" });
    // 2% left is not used up for the automatic floor (1%); a near reset or no credit spends nothing.
    expect(await run([used]).tick()).toBeNull();
    const near = { ...dry, secondaryWindow: { ...dry.secondaryWindow, resetAt: new Date(now + 5 * 3_600_000).toISOString() } };
    expect(await run([near]).tick()).toBeNull();
    expect(await run([{ ...dry, resetCreditsAvailable: 0 }]).tick()).toBeNull();
    expect(redeem).toHaveBeenCalledTimes(2);
  });

  it("tries a failed automatic spend again after 10 minutes with the same key", async () => {
    const dry = { ...used, status: "QUOTA_EXCEEDED" as const };
    let at = now;
    const redeem = vi.fn().mockRejectedValueOnce(new Error("Space Gateway is unavailable.")).mockResolvedValue({ response: { accountId: used.id, outcome: "ALREADY_REDEEMED", completedAt: "" },
      audit: { outcome: "ALREADY_REDEEMED", usageVerified: false, creditIdHash: null } });
    const auto = createCodexResetAuto({ accounts: async () => [dry], service: { availability: vi.fn(), redeem }, refusedSince: async () => false, now: () => at });
    expect(await auto.tick()).toMatchObject({ error: "Space Gateway is unavailable." });
    expect(await auto.tick()).toBeNull();
    at += 10 * 60_000 + 1;
    expect(await auto.tick()).toMatchObject({ outcome: "ALREADY_REDEEMED" });
    expect(new Set(redeem.mock.calls.map(([, key]) => key)).size).toBe(1);
  });
});
