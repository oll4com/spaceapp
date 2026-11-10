import { describe, expect, it, vi } from "vitest";
import type { ApiProviderAccount, GatewayAnthropicBillingReport } from "@space/contracts";
import {
  anthropicProviderAccount,
  createApiProviderAccountProvider,
  discoverApiProviderKeys,
  gatewayPoolProviderAccounts,
  makeProviderAccount,
  withGatewayOpenAi
} from "../src/api-provider-balance-services.js";

const now = Date.parse("2026-10-24T12:00:00.000Z");
const day = (d: string, reported: boolean, organizationUsd: number, gatewayEstimateUsd: number) =>
  ({ day: d, reported, organizationUsd, workspaceUsd: organizationUsd, gatewayEstimateUsd, gatewayBilledUsd: gatewayEstimateUsd, models: [] });
const bill = (lastError: string | null = null): GatewayAnthropicBillingReport => ({
  status: { configured: true, keyHint: "…pgAA", savedAt: null, lastSyncAt: "2026-10-24T11:50:00.000Z", lastError, upstream: [] },
  // Today unposted counts the estimate; September is outside the month but inside 31 days.
  days: [day("2026-10-24", false, 0, 61.18), day("2026-10-18", true, 128.61, 130.65), day("2026-10-10", true, 58.42, 0), day("2026-09-28", true, 10, 0)]
});

describe("api provider balance services", () => {
  it("discovers keys from environment and files", async () => {
    // Hermetic: the environment wins over the key files, so the host's own keys are not needed.
    vi.stubEnv("OPENROUTER_API_KEY", " test-openrouter-key ");
    try {
      expect((await discoverApiProviderKeys()).openrouter).toBe("test-openrouter-key");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fetches provider accounts list without unhandled errors", async () => {
    const provider = createApiProviderAccountProvider();
    const result = await provider();
    expect(result).toBeDefined();
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);

    const deepseek = result.data.find((a) => a.providerId === "deepseek");
    if (deepseek) {
      expect(deepseek.label).toBe("DeepSeek");
      expect(["CONNECTED", "UNCONFIGURED", "ERROR", "EXHAUSTED"]).toContain(deepseek.status);
      if (deepseek.status === "CONNECTED") {
        expect(deepseek.balance).toBeDefined();
      }
    }

    const openrouter = result.data.find((a) => a.providerId === "openrouter");
    if (openrouter) {
      expect(openrouter.label).toBe("OpenRouter");
      expect(["CONNECTED", "UNCONFIGURED", "ERROR", "EXHAUSTED"]).toContain(openrouter.status);
    }

    const vercel = result.data.find((a) => a.providerId === "vercel-gateway");
    if (vercel) {
      expect(vercel.label).toBe("Vercel AI Gateway");
      expect(["CONNECTED", "UNCONFIGURED", "ERROR", "EXHAUSTED"]).toContain(vercel.status);
      if (vercel.status === "CONNECTED") {
        expect(vercel.balance).toBeDefined();
      }
    }

    const google = result.data.find((a) => a.providerId === "google");
    if (google) {
      expect(google.label).toContain("Google Gemini");
      expect(["CONNECTED", "UNCONFIGURED", "ERROR", "EXHAUSTED"]).toContain(google.status);
    }
  });

  it("lists the Claude API's Anthropic bill, its monthly budget and the Console credits left", async () => {
    const none = { budgetUsd: null, creditsUsd: null };
    expect(anthropicProviderAccount(bill(), none, 197.03, now)).toMatchObject({
      providerId: "anthropic", status: "CONNECTED", balance: null, usage: "$248.21", limit: null, remainingPercent: null,
      detail: "Today $61.18 (estimate) · 7 days $189.79 · 31 days $258.21", sampledAt: "2026-10-24T11:50:00.000Z"
    });
    expect(anthropicProviderAccount(bill(), { budgetUsd: 1000, creditsUsd: null }, 197.03, now)).toMatchObject({ status: "CONNECTED", limit: "$1000.00", remainingPercent: 75 });
    expect(anthropicProviderAccount(bill("anthropic_http_429"), { budgetUsd: 200, creditsUsd: null }, 197.03, now)).toMatchObject({
      status: "EXHAUSTED", remainingPercent: 0, detail: expect.stringContaining("Budget $200.00: $0.00 left · Last sync failed: anthropic_http_429")
    });
    // Credits: every posted cost row plus today's unposted estimate is used, as the Console counts it.
    expect(anthropicProviderAccount(bill(), { budgetUsd: null, creditsUsd: 1500 }, 197.03, now)).toMatchObject({
      status: "CONNECTED", balance: "$1241.79", usage: "$258.21", limit: "$1500.00", remainingPercent: 83,
      detail: "Credits used $258.21 · Today $61.18 (estimate) · 7 days $189.79 · This month $248.21"
    });
    expect(anthropicProviderAccount(bill(), { budgetUsd: null, creditsUsd: 200 }, 197.03, now)).toMatchObject({ status: "EXHAUSTED", balance: "$-58.21", remainingPercent: 0 });
    expect(anthropicProviderAccount({ status: { ...bill().status, configured: false }, days: [] }, none, 0, now)).toMatchObject({ status: "UNCONFIGURED", sampledAt: null });

    const provider = createApiProviderAccountProvider({ now: () => new Date(now), anthropic: { billing: async () => bill(),
      settings: async () => ({ anthropicMonthlyBudgetUsd: null, anthropicCreditsUsd: 1500 }),
      // Cents, as Anthropic's cost report stores them; usage rows hold tokens and are not money.
      usage: async () => [{ source: "COST", value: 12_861 }, { source: "COST", value: 5_842 }, { source: "COST", value: 1_000 }, { source: "USAGE", value: 999_999 }], configured: async () => true } });
    expect((await provider()).data[0]).toMatchObject({ id: "anthropic", balance: "$1241.79" });
    const failing = (configured: () => Promise<boolean>) => createApiProviderAccountProvider({ anthropic: { billing: async () => { throw new Error("gateway down"); },
      settings: async () => ({ anthropicMonthlyBudgetUsd: null, anthropicCreditsUsd: null }), usage: async () => [], configured } });
    expect((await failing(async () => true)()).data[0]).toMatchObject({ id: "anthropic", status: "ERROR", detail: "Anthropic bill unavailable: gateway down" });
    // A clean install (no Anthropic key) whose read fails keeps the card hidden; so does one where even the key check fails.
    expect((await failing(async () => false)()).data[0]).toMatchObject({ id: "anthropic", status: "UNCONFIGURED" });
    expect((await failing(async () => { throw new Error("db down"); })()).data[0]).toMatchObject({ id: "anthropic", status: "UNCONFIGURED" });
  });

  it("meters Make credits against the allowance Make reports, never a fixed figure", () => {
    // Org 9526068 on 5/11: the Free plan, 10.00 credits used of 1,000.
    const org = { id: 9526068, name: "My Organization", productName: "Free", centicreditsConsumed: "1000",
      nextReset: "2026-12-04T11:35:06.808Z", license: { operations: 1000 } };
    expect(makeProviderAccount(org, "2026-11-05T08:00:00.000Z")).toMatchObject({
      id: "make-9526068", providerId: "make", status: "CONNECTED", usage: "10 credits", limit: "1,000 credits", remainingPercent: 99,
      detail: "Free plan · My Organization · 10 of 1,000 credits used · Resets 2026-12-04"
    });
    // A paid plan shows its own allowance; a spent allowance reads exhausted.
    expect(makeProviderAccount({ ...org, productName: "Teams", license: { operations: 80_000 } }, "2026-11-05T08:00:00.000Z"))
      .toMatchObject({ limit: "80,000 credits", remainingPercent: 100, detail: expect.stringContaining("Teams plan") });
    expect(makeProviderAccount({ ...org, centicreditsConsumed: "100050" }, "2026-11-05T08:00:00.000Z"))
      .toMatchObject({ status: "EXHAUSTED", usage: "1,000.5 credits", remainingPercent: 0 });
  });

  it("lists Space Gateway's key pools one row per provider; Pause in the Gateway takes one out (operator 6/11 21:49 BKK, nous_msg:71a41c2e)", async () => {
    const at = "2026-11-06T15:00:00.000Z";
    const rows = gatewayPoolProviderAccounts([
      { provider: "ADAPTION", status: "ACTIVE" }, { provider: "ADAPTION", status: "QUOTA_EXCEEDED" },
      { provider: "AMD_TOKEN_LAB", status: "PAUSED" }, { provider: "NVIDIA", status: "RATE_LIMITED" }, { provider: "GROQ", status: "QUOTA_EXCEEDED" },
      { provider: "CLOUDFLARE_AI", status: "REAUTH_REQUIRED" }, { provider: "CLOUDFLARE_AI", status: "DEACTIVATED" },
      // Subscriptions and keys a balance service already reads are not pools here.
      { provider: "CLAUDE", status: "ACTIVE" }, { provider: "OPENROUTER", status: "ACTIVE" }, { provider: "DEEPSEEK", status: "ACTIVE" }
    ], at);
    expect(rows.map((row) => [row.label, row.status, row.detail])).toEqual([
      ["Adaption Labs", "CONNECTED", "Space Gateway key pool"], ["NVIDIA NIM", "CONNECTED", "Space Gateway key pool"],
      ["Groq", "EXHAUSTED", "Space Gateway key pool · out of credits"], ["Cloudflare Workers AI", "ERROR", "Space Gateway key pool · its key needs replacing in Space Gateway"]]);
    expect(rows[0]).toMatchObject({ id: "gateway-adaption", providerId: "adaption", balance: null, sampledAt: at });
    // Resumed, it is back by itself, next to the balance services' rows.
    const list = createApiProviderAccountProvider({ now: () => new Date(at), gatewayAccounts: async () => [{ provider: "AMD_TOKEN_LAB", status: "ACTIVE" }] });
    expect((await list()).data.filter((row) => row.id.startsWith("gateway-")).map((row) => row.label)).toEqual(["AMD Token Lab"]);
  });

  it("lists the OpenAI key as out of credit while none of Space Gateway's OpenAI accounts serves (nous_msg:71a41c2e)", () => {
    // Its own check only lists the models, which a key with no credit still can: it said "Configured" with the gateway QUOTA_EXCEEDED.
    const openai: ApiProviderAccount = { id: "openai", providerId: "openai", label: "OpenAI", status: "CONNECTED", balance: "Configured", currency: null, sampledAt: null };
    const deepseek: ApiProviderAccount = { id: "deepseek", providerId: "deepseek", label: "DeepSeek", status: "CONNECTED", balance: "$4.00", currency: null, sampledAt: null };
    for (const status of ["QUOTA_EXCEEDED", "PAUSED"] as const) {
      expect(withGatewayOpenAi([openai, deepseek], [{ provider: "OPENAI_API", status }]).map((row) => [row.id, row.status, row.balance]))
        .toEqual([["openai", "EXHAUSTED", null], ["deepseek", "CONNECTED", "$4.00"]]);
    }
    // One serving account, or no gateway account (or a failed gateway read: none), leaves the row as its check found it.
    for (const gateway of [[{ provider: "OPENAI_API" as const, status: "PAUSED" as const }, { provider: "OPENAI_API" as const, status: "ACTIVE" as const }], []]) {
      expect(withGatewayOpenAi([openai], gateway)[0]).toBe(openai);
    }
  });
});
