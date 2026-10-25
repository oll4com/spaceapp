import { describe, expect, it, vi } from "vitest";
import { chatgptAuthHeaders, codexUsageUrl, CodexUsageError, consumeResetCredit, fetchCodexUsage, parseCodexUsage, remainingPercent } from "../src/providers/codex/usage.js";

const payload = {
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 42.5, reset_at: 1_900_000_000, limit_window_seconds: 18_000, reset_after_seconds: 3600 },
    secondary_window: { used_percent: 10, reset_at: 1_900_500_000, limit_window_seconds: 604_800 }
  },
  credits: { has_credits: true, unlimited: false, balance: "12.5" },
  rate_limit_reset_credits: { available_count: 1 },
  additional_rate_limits: [{ limit_name: "gpt-6", metered_feature: "codex", rate_limit: { primary_window: { used_percent: 5 } } }, { bad: true }]
};

describe("Codex usage (codex-lb parity)", () => {
  it("parses windows, credits, reset credits and additional limits", () => {
    const usage = parseCodexUsage(payload);
    expect(usage.planType).toBe("plus");
    expect(usage.primary).toEqual({ usedPercent: 42.5, resetAt: 1_900_000_000, limitWindowSeconds: 18_000, resetAfterSeconds: 3600 });
    expect(usage.secondary?.usedPercent).toBe(10);
    expect(usage.credits).toEqual({ hasCredits: true, unlimited: false, balance: "12.5" });
    expect(usage.resetCreditsAvailable).toBe(1);
    expect(usage.additional).toEqual([{ limitName: "gpt-6", meteredFeature: "codex", primary: { usedPercent: 5, resetAt: null, limitWindowSeconds: null, resetAfterSeconds: null }, secondary: null }]);
    expect(remainingPercent(usage.primary)).toBe(57.5);
    expect(parseCodexUsage(null)).toMatchObject({ primary: null, secondary: null, additional: [] });
  });

  it("builds the backend-api URL and ChatGPT headers", () => {
    expect(codexUsageUrl()).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(codexUsageUrl("https://chatgpt.com/")).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(chatgptAuthHeaders("tok", "acct-1")).toEqual({ authorization: "Bearer tok", accept: "application/json", "chatgpt-account-id": "acct-1" });
    expect(chatgptAuthHeaders("tok", "email_abc")).not.toHaveProperty("chatgpt-account-id");
  });

  it("retries transient statuses and reports upstream errors", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    expect((await fetchCodexUsage({ accessToken: "t", accountId: "a", fetchImpl, sleep })).planType).toBe("plus");
    expect(sleep).toHaveBeenCalledWith(500);
    const denied = vi.fn(async () => new Response(JSON.stringify({ error: { code: "Token_Expired", message: "expired" } }), { status: 401 }));
    await expect(fetchCodexUsage({ accessToken: "t", accountId: "a", fetchImpl: denied, sleep })).rejects.toMatchObject({ statusCode: 401, code: "token_expired", message: "expired" });
    const down = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(fetchCodexUsage({ accessToken: "t", accountId: "a", fetchImpl: down, sleep, maxRetries: 1 })).rejects.toBeInstanceOf(CodexUsageError);
    expect(down).toHaveBeenCalledTimes(2);
  });

  it("spends a reset credit with an idempotent request id", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "reset", windows_reset: 2 })));
    expect(await consumeResetCredit({ accessToken: "t", accountId: "acct", redeemRequestId: "req-12345678", fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toEqual({ code: "reset", windowsReset: 2 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
    expect(JSON.parse(String(init.body))).toEqual({ redeem_request_id: "req-12345678" });
    await expect(consumeResetCredit({ accessToken: "t", accountId: "a", redeemRequestId: "r-12345678",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ code: "weird" }))) as unknown as typeof fetch })).rejects.toBeInstanceOf(CodexUsageError);
  });
});
