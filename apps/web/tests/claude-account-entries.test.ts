import { describe, expect, it } from "vitest";
import type { ClaudeUsageAccount, GatewayAnthropicBillingReport } from "@space/contracts";
import { anthropicBillLines, claudeAccountEntries, claudeApiKeyHint, claudeStatusLabel } from "../src/features/toolbar-metrics/account-entries.js";
import { cliAccountAvailability } from "../src/features/cli-accounts/cli-account-availability.js";

const clock = Date.parse("2026-10-13T08:00:00.000Z");
const apiCard = (patch: Partial<ClaudeUsageAccount> = {}): ClaudeUsageAccount => ({
  id: "api", label: "api", email: null, plan: null, status: "API_KEY", fiveHourRemainingPercent: null, fiveHourResetAt: null,
  weeklyRemainingPercent: null, weeklyResetAt: null, weeklyScope: null, sampledAt: null, ...patch
});

describe("Claude API key card", () => {
  it("shows a checked key as connected and says what Space Gateway does with it", () => {
    expect(claudeStatusLabel(apiCard())).toBe("API key");
    expect(claudeStatusLabel(apiCard({ apiKeyVerified: true }))).toBe("Connected · API key");
    expect(claudeStatusLabel(apiCard({ apiKeyVerified: false }))).toBe("API key rejected");
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "ON" })))
      .toBe("Paid per token; panes never choose it automatically. Space Gateway uses it while every pooled Claude account is out of quota, and returns to the accounts at their reset.");
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "OFF" }))).toMatch(/fallback is off/);
    expect(claudeApiKeyHint(apiCard({ gatewayFallback: "NOT_ADDED" }))).toMatch(/Add it to Space Gateway/);
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: false }))).toBe("Anthropic rejected this API key.");
    // What went through the key: nothing, or how much and when.
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "ON", apiKeyUsage: { requests: 0, costUsd: 0, lastUsedAt: null } }), clock))
      .toMatch(/at their reset\. Never used by Space Gateway\.$/);
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "ON", apiKeyUsage: { requests: 3, costUsd: 0.4321, lastUsedAt: new Date(clock - 7 * 60_000).toISOString() } }), clock))
      .toMatch(/at their reset\. Used 3 times through Space Gateway \(\$0\.43\), last 7m ago\.$/);
    expect(claudeApiKeyHint(apiCard({ apiKeyVerified: true, gatewayFallback: "OFF", apiKeyUsage: { requests: 1, costUsd: 0.001, lastUsedAt: new Date(clock - 3 * 3_600_000).toISOString() } }), clock))
      .toMatch(/fallback is off .*Used 1 time through Space Gateway, last 3h ago\.$/);
    const [used] = claudeAccountEntries([apiCard({ apiKeyVerified: true, gatewayFallback: "ON", apiKeyUsage: { requests: 2, costUsd: 0.5, lastUsedAt: new Date(clock - 60_000).toISOString() } })], clock);
    expect(used!.hint).toMatch(/Used 2 times through Space Gateway \(\$0\.50\), last 1m ago\.$/);
    const [entry] = claudeAccountEntries([apiCard({ apiKeyVerified: true, gatewayFallback: "ON" })], clock);
    // Never counted as an available quota account: panes do not pick it on their own.
    expect(entry).toMatchObject({ availability: { state: "offline" }, offlineLabel: "Connected · API key", rows: [] });
  });

  it("labels the key in the pane account picker without making it a pick", () => {
    const pick = (patch: Partial<ClaudeUsageAccount>) => cliAccountAvailability({
      runtimeId: "cli:claude", profileId: "api", identity: null, clock,
      quota: { codex: null, agy: null, api: null, fetchedAt: clock, claude: { data: [apiCard(patch)], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
        source: "space-claude-profiles", isStale: false, error: null, checkedAt: new Date(clock).toISOString() } }
    });
    expect(pick({ apiKeyVerified: true, gatewayFallback: "ON" })).toMatchObject({ tone: "off", label: "Paid · ready",
      description: "Paid per token · never chosen by Auto · Space Gateway fallback on" });
    expect(pick({ apiKeyVerified: false })).toMatchObject({ tone: "off", label: "Key rejected" });
    expect(pick({})).toMatchObject({ tone: "off", label: "Paid · not used", description: "Paid per token · never chosen by Auto" });
  });
});

// The organization's bill as Space Gateway read it on 2026-10-19 (operator's check figures), at 00:14 in Bangkok on the 20th.
const anthropicBill = (patch: Partial<GatewayAnthropicBillingReport["status"]> = {}): GatewayAnthropicBillingReport => ({
  status: { configured: true, keyHint: "…pgAA", savedAt: "2026-10-18T06:43:28.523Z", lastSyncAt: "2026-10-19T17:12:16.208Z", lastError: null, upstream: [], ...patch },
  days: ([["2026-10-19", false, 0, 1.68639925], ["2026-10-18", true, 128.61044597, 130.65], ["2026-10-17", true, 80.908391835, 81.12],
    ["2026-10-16", true, 1.58218237, 1.63], ["2026-10-14", true, 0.0008693, 0.0008693], ["2026-10-11", true, 1.125208, 0], ["2026-10-10", true, 58.422290655, 0]] as const)
    .map(([day, reported, organizationUsd, gatewayEstimateUsd]) => ({ day, reported, organizationUsd, workspaceUsd: organizationUsd, gatewayEstimateUsd, gatewayBilledUsd: gatewayEstimateUsd, models: [] }))
});

describe("Anthropic bill on the Claude API key card", () => {
  const night = Date.parse("2026-10-19T17:14:00.000Z");
  const bangkok = { timeZone: "Asia/Bangkok", timeFormat: "24h" as const };

  it("adds today (an estimate until Anthropic posts it), 7 days, this month and 31 days, and the last sync", () => {
    const lines = anthropicBillLines(anthropicBill(), night, bangkok);
    expect(lines[0]).toBe("Anthropic bill: today $1.69 (estimate) · 7 days $212.79 · this month $272.34 · 31 days $272.34.");
    expect(lines[1]).toMatch(/^Synced 00:12 \S+\.$/);
    expect(lines).toHaveLength(2);
    const [entry] = claudeAccountEntries([apiCard({ apiKeyVerified: true, gatewayFallback: "ON" })], night, lines);
    expect(entry!.notes).toEqual(lines);
    // Only the API key's card carries the bill.
    expect(claudeAccountEntries([apiCard({ status: "CONNECTED" })], night, lines)[0]!.notes).toBeUndefined();
  });

  it("says when a sync failed, drops the estimate mark once the day is posted, and shows nothing without the Admin key", () => {
    const failed = anthropicBillLines(anthropicBill({ lastError: "anthropic_http_401" }), night, bangkok);
    expect(failed.at(-1)).toBe("The last sync failed (anthropic_http_401).");
    const posted = anthropicBill();
    posted.days[0] = { ...posted.days[0]!, reported: true, organizationUsd: 2 };
    expect(anthropicBillLines(posted, night, bangkok)[0]).toMatch(/^Anthropic bill: today \$2\.00 · 7 days \$213\.10 · /);
    expect(anthropicBillLines(anthropicBill({ lastSyncAt: null }), night, bangkok)[1]).toBe("Not synced with Anthropic yet.");
    expect(anthropicBillLines(anthropicBill({ configured: false }), night, bangkok)).toEqual([]);
    expect(anthropicBillLines(null, night, bangkok)).toEqual([]);
  });

  it("starts the month on the 1st of the owner's working time zone", () => {
    const report = anthropicBill();
    report.days = [{ ...report.days[0]!, day: "2026-11-01", reported: true, organizationUsd: 5 }, { ...report.days[0]!, day: "2026-10-31", reported: true, organizationUsd: 7 }];
    const early = Date.parse("2026-11-01T02:00:00.000Z");
    expect(anthropicBillLines(report, early, { timeZone: "UTC", timeFormat: "24h" })[0]).toContain("this month $5.00");
    expect(anthropicBillLines(report, early, { timeZone: "America/Los_Angeles", timeFormat: "24h" })[0]).toContain("this month $7.00");
  });
});
