import { describe, expect, it } from "vitest";
import { InMemoryGatewayRepository, type GatewayRequestLogInsert } from "@space/db";
import { keyCategory, renderTokenUsage, tokenUsageBreakdown, tokenUsageWorldLines, type TokenUsageSources } from "../src/nous/token-usage.js";

// Operator 5/11 17:26 BKK (plan clipboard:qH5emwVaV6yO): token usage by process and provider, days in the owner's zone, from Space Gateway's logs only.
const log = (requestedAt: string, project: string | null, provider: GatewayRequestLogInsert["provider"], accountId: string | null, inputTokens: number, outputTokens: number,
  extra: Partial<GatewayRequestLogInsert> = {}): GatewayRequestLogInsert => ({ requestId: `req_${requestedAt}`, requestedAt, provider, accountId, apiKeyId: null, model: "m",
  reasoningEffort: null, requestedServiceTier: null, serviceTier: null, transport: "http", upstreamTransport: "http", status: "success", errorCode: null, errorMessage: null,
  latencyMs: 1, firstTokenMs: null, inputTokens, cachedInputTokens: 0, outputTokens, reasoningTokens: null, costUsd: 0.5, compressionTokensSaved: null, stickyKind: null,
  stickyKeyHash: null, planType: null, stickyKeySource: null, cacheCreationTokens: null, clientName: "Claude Code", project, compressionTokensBefore: null,
  compressionTokensAfter: null, compressionDetail: null, source: null, cacheBust: null, ...extra });

describe("token usage by process and provider", () => {
  it("counts Bangkok days, the same span before, Nous turn kinds by minute, labels and risers; warm-ups left out", async () => {
    const repository = new InMemoryGatewayRepository();
    await repository.insertRequestLogs([
      // 00:30 Bangkok on 5/11 (still 4/11 in UTC): today.
      log("2026-11-04T17:30:00.000Z", "pane:p1", "CLAUDE", "acc1", 1000, 10, { cachedInputTokens: 900, cacheCreationTokens: 50 }),
      log("2026-11-05T09:10:30.000Z", "nous", "CLAUDE", "acc1", 500, 5),
      log("2026-11-05T09:20:00.000Z", "nous", "CLAUDE", "acc1", 300, 0),
      log("2026-11-05T09:30:00.000Z", "nous-operator", "ANTIGRAVITY", null, 200, 0),
      log("2026-11-05T09:40:00.000Z", "pane:p1", "CLAUDE", "acc1", 9_999, 0, { source: "limit_warmup" }),
      // 23:59 Bangkok on 4/11: neither today nor inside yesterday's span up to 17:00.
      log("2026-11-04T16:59:00.000Z", "pane:p1", "CLAUDE", "acc1", 7_777, 0),
      // 08:00 Bangkok on 4/11: the span before (4/11 00:00-17:00 Bangkok).
      log("2026-11-04T01:00:00.000Z", "pane:p1", "CLAUDE", "acc1", 100, 0)
    ]);
    const sources: TokenUsageSources = {
      projectUsage: (...args) => repository.projectUsage(...args),
      turns: async () => [{ reason: "INBOX", startedAt: "2026-11-05T09:10:00.000Z", endedAt: "2026-11-05T09:12:00.000Z" }],
      pane: async (id) => id === "pane:p1" ? { room: "Bruno", title: "Bob", mode: "TERMINAL" } : null
    };
    const now = Date.parse("2026-11-05T10:00:00.000Z");
    const day = await tokenUsageBreakdown(sources, "user:operator", "day", "Asia/Bangkok", now);
    expect(day).toMatchObject({ since: "2026-11-04T17:00:00.000Z", until: "2026-11-05T10:00:00.000Z", previousSince: "2026-11-03T17:00:00.000Z",
      previousUntil: "2026-11-04T10:00:00.000Z", totals: { requests: 4, inputTokens: 2000, cachedInputTokens: 900, cacheCreationTokens: 50, outputTokens: 15, costUsd: 2 },
      previousTotals: { requests: 1, inputTokens: 100 } });
    expect(day.processes.map(({ key, label, kind, detail, inputTokens }) => ({ key, label, kind, detail, inputTokens }))).toEqual([
      { key: "mode:TERMINAL", label: "CLI panes", kind: "pane", detail: "1 pane", inputTokens: 1000 },
      { key: "nous:INBOX", label: "Nous · inbox turns", kind: "nous", detail: null, inputTokens: 500 },
      { key: "nous:OTHER", label: "Nous · between recorded turns", kind: "nous", detail: null, inputTokens: 300 },
      { key: "nous:OPERATOR", label: "Nous · operator turns", kind: "nous", detail: null, inputTokens: 200 }]);
    expect(day.providers.map(({ key, inputTokens }) => [key, inputTokens])).toEqual([["CLAUDE", 1800], ["ANTIGRAVITY", 200]]);
    // Operator 6/11 (nous_msg:781819c5): per provider only, never per account.
    expect(day).not.toHaveProperty("accounts");
    expect(day.days).toEqual([{ day: "2026-11-05", providers: { CLAUDE: 1815, ANTIGRAVITY: 200 } }]);
    expect(day.risers[0]).toEqual({ key: "mode:TERMINAL", label: "CLI panes", kind: "pane", tokens: 1010, before: 100 });

    // A week spans 30/10-5/11 in Bangkok: the 23:59 row of 4/11 counts there, by its Bangkok day.
    const week = await tokenUsageBreakdown(sources, "user:operator", "week", "Asia/Bangkok", now);
    expect(week.since).toBe("2026-10-29T17:00:00.000Z");
    expect(week.days.map((entry) => entry.day)).toEqual(["2026-11-04", "2026-11-05"]);
    expect(week.days[0]!.providers.CLAUDE).toBe(7_877);
    expect(tokenUsageWorldLines(day, week)).toContain("Today so far: 2k tokens, 4 requests, $2");
    expect(renderTokenUsage(day)).toContain("- CLI panes [1 pane] (mode:TERMINAL):");
  });

  it("narrows to one provider with its models (operator 9/11, nous_msg:d818e183): processes, days, totals and the span before of that provider only", async () => {
    const repository = new InMemoryGatewayRepository();
    await repository.insertRequestLogs([
      log("2026-11-05T09:00:00.000Z", "pane:p1", "CLAUDE", "acc1", 100, 0, { model: "claude-opus" }),
      log("2026-11-05T09:01:00.000Z", "pane:p1", "CLAUDE", "acc2", 40, 0, { model: "claude-sonnet" }),
      log("2026-11-05T09:02:00.000Z", "nous", "DEEPSEEK", null, 500, 0, { model: "deepseek-chat" }),
      log("2026-11-04T09:00:00.000Z", "pane:p1", "CLAUDE", "acc1", 70, 0, { model: "claude-opus" }),
      log("2026-11-04T09:01:00.000Z", "nous", "DEEPSEEK", null, 900, 0, { model: "deepseek-chat" })]);
    const sources: TokenUsageSources = { projectUsage: (...args) => repository.projectUsage(...args), turns: async () => [],
      pane: async () => ({ room: "R", title: "t", mode: "TERMINAL" }) };
    const now = Date.parse("2026-11-05T10:00:00.000Z");
    const claude = await tokenUsageBreakdown(sources, "user:operator", "day", "Asia/Bangkok", now, "CLAUDE");
    expect(claude).toMatchObject({ provider: "CLAUDE", totals: { requests: 2, inputTokens: 140 }, previousTotals: { requests: 1, inputTokens: 70 } });
    expect(claude.providers.map((row) => row.key)).toEqual(["CLAUDE"]);
    // Per model, never per account (operator 5/11): two accounts of one model stay one row.
    expect(claude.models!.map(({ key, inputTokens }) => [key, inputTokens])).toEqual([["claude-opus", 100], ["claude-sonnet", 40]]);
    expect(claude.processes.map((row) => row.key)).toEqual(["mode:TERMINAL"]);
    expect(claude.days).toEqual([{ day: "2026-11-05", providers: { CLAUDE: 140 } }]);
    const all = await tokenUsageBreakdown(sources, "user:operator", "day", "Asia/Bangkok", now);
    expect(all).not.toHaveProperty("provider");
    expect(all.totals.inputTokens).toBe(640);
    expect(all.models!.map((row) => row.key)).toEqual(["deepseek-chat", "claude-opus", "claude-sonnet"]);
    expect(renderTokenUsage(claude)).toContain("- claude-opus: 100");
  });

  it("groups panes by category, never by room or pane name, closed panes together and keys of one name together", async () => {
    const repository = new InMemoryGatewayRepository();
    await repository.insertRequestLogs([
      log("2026-11-05T09:00:00.000Z", "pane:oscar", "CLAUDE", null, 100, 0), log("2026-11-05T09:01:00.000Z", "pane:iris", "CLAUDE", null, 200, 0),
      log("2026-11-05T09:02:00.000Z", "pane:gone1", "CLAUDE", null, 40, 0), log("2026-11-05T09:03:00.000Z", "pane:gone2", "CLAUDE", null, 30, 0),
      log("2026-11-05T09:04:00.000Z", "pane:finn", "CLAUDE", null, 10, 0), log("2026-11-05T09:05:00.000Z", null, "CLAUDE", null, 5, 0, { clientName: "Other" }),
      log("2026-11-05T09:06:00.000Z", null, "CLAUDE", null, 8, 0, { apiKeyId: "gw_key:k1", clientName: "OpenCode" }),
      log("2026-11-05T09:06:30.000Z", null, "CLAUDE", null, 1, 0, { apiKeyId: "gw_key:k2", clientName: "OpenCode" }),
      log("2026-11-05T09:07:00.000Z", null, "ANTIGRAVITY", null, 7, 0, { clientName: "Antigravity" })]);
    const modes: Record<string, string> = { "pane:oscar": "APP_STUDIO", "pane:iris": "APP_STUDIO", "pane:finn": "FREELANCE_COPILOT" };
    const day = await tokenUsageBreakdown({ projectUsage: (...args) => repository.projectUsage(...args), turns: async () => [],
      pane: async (id) => modes[id] ? { room: "Cleo", title: id.slice(5), mode: modes[id]! } : null,
      apiKeys: async () => [{ id: "gw_key:k1", name: "Claude API credits (CLIs)" }, { id: "gw_key:k2", name: "Claude API credits (CLIs)" }] }, "user:operator", "day", "Asia/Bangkok", Date.parse("2026-11-05T10:00:00.000Z"));
    expect(day.processes.map(({ key, label, kind, detail, inputTokens }) => ({ key, label, kind, detail, inputTokens }))).toEqual([
      { key: "mode:APP_STUDIO", label: "App Studio", kind: "copilot", detail: "2 panes", inputTokens: 300 },
      { key: "mode:CLOSED", label: "Closed or removed panes", kind: "pane", detail: "2 closed panes", inputTokens: 70 },
      { key: "group:cli", label: "CLI outside panes", kind: "other", detail: null, inputTokens: 16 },
      { key: "mode:FREELANCE_COPILOT", label: "Freelance Copilot", kind: "copilot", detail: "1 pane", inputTokens: 10 },
      { key: "", label: "Other (unattributed)", kind: "other", detail: null, inputTokens: 5 }]);
    expect(day.processes.find((row) => row.key === "group:cli")!.parts!.map(({ label, inputTokens }) => [label, inputTokens]))
      .toEqual([["Claude API credits (CLIs)", 9], ["Antigravity (no key)", 7]]);
    expect(day.risers.map((riser) => riser.label)).toEqual(["App Studio", "Closed or removed panes", "CLI outside panes", "Freelance Copilot", "Other (unattributed)"]);
  });

  it("puts untagged keys into categories (operator 5/11 20:25 BKK): pane CLIs, lab, CLIs outside panes, Space internal", async () => {
    expect(keyCategory("Claude Code (panes)")).toEqual({ key: "mode:TERMINAL", label: "CLI panes", kind: "pane", part: "without pane tag" });
    for (const name of ["spaceapp-pilot-rehearsal-vm231", "spaceapp-pilot-rehearsal-k3-claude", "lab-codex-225"]) expect(keyCategory(name)?.key).toBe("group:lab");
    for (const name of ["Codex CLI", "Claude API credits (CLIs)", "OpenCode", "Oh My Pi", "Hermes", "DeepSeek Harness", "Reasonix (DeepSeek CLI)", "T3 Code"])
      expect(keyCategory(name)).toEqual({ key: "group:cli", label: "CLI outside panes", kind: "other", part: name });
    for (const name of ["Space internal", "Mission Control", "MC crm-director", "space-summary-tools", "groq-free-proof", "nbpro-test-indg"])
      expect(keyCategory(name)?.key).toBe("group:internal");
    for (const name of ["public-host oll4 public agent", "payagent-demo", "operator-free-pools"]) expect(keyCategory(name)).toBeNull();

    const repository = new InMemoryGatewayRepository();
    await repository.insertRequestLogs([
      log("2026-11-05T09:00:00.000Z", "pane:t1", "CLAUDE", null, 100, 0),
      log("2026-11-05T09:01:00.000Z", null, "CLAUDE", null, 50, 0, { apiKeyId: "gw_key:panes" }),
      log("2026-11-05T09:02:00.000Z", null, "CLAUDE", null, 4, 0, { apiKeyId: "gw_key:vm1" }),
      log("2026-11-05T09:03:00.000Z", null, "CLAUDE", null, 3, 0, { apiKeyId: "gw_key:vm2" }),
      log("2026-11-05T09:04:00.000Z", "claude-code", "CLAUDE", null, 2, 0),
      log("2026-11-05T09:05:00.000Z", null, "CLAUDE", null, 1, 0, { apiKeyId: "gw_key:internal" })]);
    const day = await tokenUsageBreakdown({ projectUsage: (...args) => repository.projectUsage(...args), turns: async () => [],
      pane: async () => ({ room: "R", title: "t", mode: "TERMINAL" }),
      apiKeys: async () => [{ id: "gw_key:panes", name: "Claude Code (panes)" }, { id: "gw_key:vm1", name: "spaceapp-pilot-rehearsal-vm1" },
        { id: "gw_key:vm2", name: "spaceapp-pilot-rehearsal-vm2" }, { id: "gw_key:internal", name: "Space internal" }] },
    "user:operator", "day", "Asia/Bangkok", Date.parse("2026-11-05T10:00:00.000Z"));
    expect(day.processes.map(({ key, detail, inputTokens, parts }) => [key, detail, inputTokens, parts?.map((part) => [part.label, part.inputTokens])])).toEqual([
      ["mode:TERMINAL", "1 pane", 150, [["without pane tag", 50]]],
      ["group:lab", null, 7, [["spaceapp-pilot-rehearsal-vm1", 4], ["spaceapp-pilot-rehearsal-vm2", 3]]],
      ["group:cli", null, 2, [["Claude Code (outside panes)", 2]]],
      ["group:internal", null, 1, [["Space internal", 1]]]]);
    expect(renderTokenUsage(day)).toContain("  - without pane tag: 50");
  });
});
