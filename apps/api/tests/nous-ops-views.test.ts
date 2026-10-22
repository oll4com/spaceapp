import { describe, expect, it } from "vitest";
import { nousOpsServicesText, nousOpsUsageText } from "../src/nous/ops-views.js";
import { createNousTools, nousToolDefinitions, type NousToolDeps } from "../src/nous/tools.js";

// Read-only ops views for Nous (plan clipboard:8s0ZNiO3q5ZT S5).
const health = {
  sampledAt: "2026-10-17T13:20:00.000Z", metrics: [], uptimeSeconds: 100, coreCount: 20,
  services: [
    { id: "api", label: "Space API", status: "healthy", detail: "", checkedAt: "2026-10-17T13:20:00.000Z", values: [] },
    { id: "pg", label: "PostgreSQL", status: "warning", detail: "Slow  queries\nlast minute", checkedAt: "2026-10-17T13:20:00.000Z", values: [] },
    { id: "vpn", label: "VPN", status: "disabled", detail: "", checkedAt: "2026-10-17T13:20:00.000Z", values: [] }
  ],
  requests: { windowSeconds: 300, requestCount: 1200, errorCount: 6, errorRatePercent: 0.5, p95Ms: 182.4, sampledAt: "2026-10-17T13:20:00.000Z" }
};
const unit = (name: string, activeState: string, unitFileState = "enabled") =>
  ({ unit: name, description: null, type: "service", loadState: "loaded", activeState, subState: activeState, unitFileState, timerActivates: null, timerNextElapse: null, timerLastTrigger: null });
const services = { units: [unit("space-api.service", "active"), unit("space-merge-queue.service", "failed"), unit("space-memory-worker.service", "inactive"), unit("old.service", "inactive", "disabled")],
  summary: { total: 4, active: 1, inactive: 2, failed: 1, services: 4, timers: 0, enabled: 3, disabled: 1 }, sampledAt: "2026-10-17T13:20:00.000Z" };
const model = (modelId: string, costUsd: number | null) => ({ providerId: "anthropic", modelId, tokensIn: 1_250_000, tokensOut: 40_000, costUsd, completedTurns: 12 });
const usage = { range: "24h", models: [model("claude-sonnet-5-5", 1.5), model("claude-opus-5-5", 12.25)],
  routes: { gateway: { tokensIn: 2_000_000, tokensOut: 50_000, tokensReasoning: 0, costUsd: 9, unpricedTurns: 0 }, direct: { tokensIn: 500, tokensOut: 20, tokensReasoning: 0, costUsd: 0.01, unpricedTurns: 0 } } };
const gateway = { service: { state: "RUNNING", version: "1.4.0", startedAt: null, inFlightRequests: 0, listen: null, error: null },
  accounts: { total: 5, active: 4, byProvider: [{ provider: "ANTHROPIC", total: 3, active: 3 }, { provider: "OPENAI", total: 2, active: 1 }] },
  apiKeys: { total: 6, active: 5 }, last24h: { requests: 900, errors: 3, inputTokens: 2_000_000, outputTokens: 50_000, costUsd: 9, compressionTokensSaved: 0 },
  settings: { secretish: "never shown" } };

describe("Nous's read-only ops views", () => {
  it("reports unhealthy checks, recent API errors and failed or stopped services", async () => {
    const text = await nousOpsServicesText({ health: { snapshot: async () => health as never }, services: async () => services as never });
    expect(text.split("\n")).toEqual([
      "Health 2026-10-17T13:20 UTC: 2 of 3 checks healthy.",
      "- PostgreSQL: warning (Slow queries last minute)",
      "API requests in the last 5 minutes: 1200, errors 6 (0.5%), p95 182 ms.",
      "Services: 1 active, 1 failed of 4 units.",
      "- failed: space-merge-queue.service",
      "- enabled but not running: space-memory-worker.service"
    ]);
    expect(await nousOpsServicesText({ health: { snapshot: async () => { throw new Error("down"); } } })).toBe("Health checks could not be read now.\nService units could not be read now.");
  });

  it("reports token usage per model and Space Gateway status, never its settings", async () => {
    const text = await nousOpsUsageText({ tokenUsage: async () => usage as never, gateway: async () => gateway as never }, "7d");
    expect(text.split("\n")).toEqual([
      "Token usage, last 7d: Space Gateway 2.0M tokens $9.00, direct 520 tokens $0.01 (API value).",
      "- anthropic/claude-opus-5-5: in 1.3M, out 40.0k, $12.25, 12 turns",
      "- anthropic/claude-sonnet-5-5: in 1.3M, out 40.0k, $1.50, 12 turns",
      "Space Gateway: RUNNING 1.4.0; accounts 4/5 active (ANTHROPIC 3/3, OPENAI 1/2); keys 5/6 active.",
      "Gateway last 24 h: 900 requests, 3 errors, 2.0M in, 50.0k out, $9.00."
    ]);
    expect(text).not.toContain("never shown");
    expect(await nousOpsUsageText({})).toBe("Token usage could not be read now.\nSpace Gateway status could not be read now.");
  });

  it("serves both views as read-only Nous tools", async () => {
    const ranges: string[] = [];
    const tools = createNousTools({ ops: { health: { snapshot: async () => health as never }, services: async () => services as never,
      tokenUsage: async (range: string) => { ranges.push(range); return usage as never; }, gateway: async () => gateway as never } } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:o1", callId: "toolu_o", traceId: "trace:o" };
    expect(await tools.execute("space_ops_services", {}, ctx)).toMatchObject({ ok: true, display: "Checked the services" });
    expect((await tools.execute("space_ops_usage", { range: "30d" }, ctx)).result).toContain("Token usage, last 30d");
    expect((await tools.execute("space_ops_usage", {}, ctx)).result).toContain("Token usage, last 24h");
    expect(ranges).toEqual(["30d", "24h"]);
    expect((await tools.execute("space_ops_usage", { range: "10m" }, ctx)).ok).toBe(false);
    expect((await createNousTools({} as NousToolDeps).execute("space_ops_services", {}, ctx)).ok).toBe(false);
    expect(nousToolDefinitions({ copilots: false }).map((tool) => tool.name)).toEqual(expect.arrayContaining(["space_ops_services", "space_ops_usage"]));
  });
});
