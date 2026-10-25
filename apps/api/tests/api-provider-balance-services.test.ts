import { describe, expect, it, vi } from "vitest";
import type { GatewayAnthropicBillingReport } from "@space/contracts";
import {
  anthropicProviderAccount,
  createApiProviderAccountProvider,
  discoverApiProviderKeys
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
      usage: async () => [{ source: "COST", value: 12_861 }, { source: "COST", value: 5_842 }, { source: "COST", value: 1_000 }, { source: "USAGE", value: 999_999 }] } });
    expect((await provider()).data[0]).toMatchObject({ id: "anthropic", balance: "$1241.79" });
    const failing = createApiProviderAccountProvider({ anthropic: { billing: async () => { throw new Error("gateway down"); },
      settings: async () => ({ anthropicMonthlyBudgetUsd: null, anthropicCreditsUsd: null }), usage: async () => [] } });
    expect((await failing()).data[0]).toMatchObject({ id: "anthropic", status: "ERROR", detail: "Anthropic bill unavailable: gateway down" });
  });
});
