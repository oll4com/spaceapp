import { gatewayFreeLedgerLine } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { gatewayPoolProviderAccounts } from "../src/api-provider-balance-services.js";
import { buildFreeLedger } from "../src/gateway/free-ledger.js";
import { nousProviderRooms, renderNousProviderAdvice } from "../src/nous/tokens.js";

// Operator 7/11 (nous_msg:d9b67550): a record of the free tokens granted and of those spent, so we know what is left, per pool, everywhere the same.
const now = Date.parse("2026-11-07T12:00:00.000Z");
const usage = [
  { provider: "INCEPTION" as const, day: "2026-11-05", requests: 9, inputTokens: 9_000, outputTokens: 1_000, reasoningTokens: 0, costUsd: 0 },
  { provider: "INCEPTION" as const, day: "2026-11-07", requests: 3, inputTokens: 1_000_000, outputTokens: 234_000, reasoningTokens: 0, costUsd: 0 },
  { provider: "ADAPTION" as const, day: "2026-11-07", requests: 4, inputTokens: 21_805, outputTokens: 160, reasoningTokens: 0, costUsd: 0 },
  { provider: "AMD_TOKEN_LAB" as const, day: "2026-11-07", requests: 3, inputTokens: 22_460, outputTokens: 12, reasoningTokens: 0, costUsd: 0.0062 },
  { provider: "AZURE_OPENAI" as const, day: "2026-11-07", requests: 364, inputTokens: 1_600_000, outputTokens: 46_933, reasoningTokens: 0, costUsd: 0 },
  { provider: "GROQ" as const, day: "2026-10-01", requests: 50, inputTokens: 50_000, outputTokens: 5_000, reasoningTokens: 0, costUsd: 0 },
  { provider: "GROQ" as const, day: "2026-11-06", requests: 5, inputTokens: 7_680, outputTokens: 152, reasoningTokens: 0, costUsd: 0 }
];
const accounts = [{ provider: "INCEPTION" as const, status: "ACTIVE" }, { provider: "ADAPTION" as const, status: "ACTIVE" }, { provider: "GROQ" as const, status: "RATE_LIMITED" },
  { provider: "AMD_TOKEN_LAB" as const, status: "ACTIVE" }, { provider: "OVH" as const, status: "DEACTIVATED" }, { provider: "CLAUDE" as const, status: "ACTIVE" }];
const poolModels = { fetchedAt: "2026-11-07T11:00:00.000Z", data: [{ provider: "INCEPTION" as const, models: ["mercury-3", "mercury-2.5"], error: null },
  { provider: "ZAI" as const, models: ["glm-4.5-flash", "glm-5"], error: null }] };

describe("free-token ledger", () => {
  it("counts each grant from its start and each free tier over 30 days, and says what is left only when it is known", () => {
    const ledger = buildFreeLedger({ accounts, usage, poolModels, now });
    const row = (provider: string) => ledger.rows.find((entry) => entry.provider === provider)!;
    // Inception: 100M granted on 6/11; the 5/11 test before the grant does not count.
    expect(row("INCEPTION")).toMatchObject({ kind: "GRANT", granted: { amount: 100_000_000, unit: "tokens" }, spent: { requests: 3, tokens: 1_234_000 },
      left: 98_766_000, leftPercent: 98.8, lastUsedAt: "2026-11-07", accounts: 1, models: ["mercury-3", "mercury-2.5"] });
    expect(gatewayFreeLedgerLine(row("INCEPTION"))).toBe("100M tokens granted · 1.23M tokens used · 98.77M tokens left (99%) · last used 2026-11-07");
    // A dollar grant whose provider reports no cost: its tokens, and no "left" made up.
    expect(row("ADAPTION")).toMatchObject({ granted: { amount: 1500, unit: "usd" }, spent: { tokens: 21_965, costUsd: 0 }, left: null });
    expect(gatewayFreeLedgerLine(row("ADAPTION"))).toContain("$1500 granted · 22k tokens used · left: the provider reports no cost");
    // A grant not yet joined is still listed (0 accounts); a free tier counts its last 30 days; a deactivated pool without a grant is not ours.
    expect(row("JINA")).toMatchObject({ accounts: 0, spent: { requests: 0 }, left: 10_000_000 });
    expect(row("GROQ")).toMatchObject({ kind: "FREE_TIER", granted: null, spent: { requests: 5 }, left: null });
    expect(ledger.rows.some((entry) => entry.provider === "OVH" || entry.provider === "CLAUDE")).toBe(false);
    // Azure reports no cost: its gpt-5-mini list price makes "left" an estimate, and the line says so.
    expect(row("AZURE_OPENAI")).toMatchObject({ spent: { costUsd: 0.493866, estimated: true }, left: 199.51 });
    expect(gatewayFreeLedgerLine(row("AZURE_OPENAI"))).toContain("$200.00 granted · 1.65M tokens (about $0.49) used · about $199.51 left");
  });

  it("puts the same line on the Quotas pool rows and in Nous's provider advice", () => {
    const ledger = buildFreeLedger({ accounts, usage, poolModels, now });
    const rows = gatewayPoolProviderAccounts(accounts, "2026-11-07T12:00:00.000Z", ledger);
    const inception = rows.find((entry) => entry.id === "gateway-inception")!;
    expect(inception).toMatchObject({ label: "Inception Labs", status: "CONNECTED", remainingPercent: 98.8, models: ["mercury-3", "mercury-2.5"] });
    expect(inception.detail).toBe(gatewayFreeLedgerLine(ledger.rows.find((entry) => entry.provider === "INCEPTION")!));
    expect(rows.find((entry) => entry.id === "gateway-adaption")).toMatchObject({ balance: null, limit: "$1500.00" });
    const advice = renderNousProviderAdvice(nousProviderRooms([], rows, now), (value) => value, "UTC");
    expect(advice).toContain("Inception Labs");
    expect(advice).toContain("100M tokens granted");
  });
});
