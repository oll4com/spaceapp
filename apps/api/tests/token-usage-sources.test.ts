import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository, InMemorySystemAnalyticsRepository, type GatewayRequestLogInsert } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { SystemAnalyticsService } from "../src/system-analytics-service.js";
import {
  CLAUDE_TIME_CURSOR, GEMINI_GATEWAY_CURSOR, ingestClaudeTranscripts, ingestGatewayLogs, type TokenUsageSourceOptions
} from "../src/token-usage-sources.js";

const now = new Date("2027-02-01T12:00:00.000Z");
const lab = `gw_account:${"1".repeat(32)}`;
const pooled = `gw_account:${"2".repeat(32)}`;
const ownedRoot = mkdtempSync(join(tmpdir(), "space-token-usage-"));
afterAll(() => rmSync(ownedRoot, { recursive: true, force: true }));

function log(extra: Partial<GatewayRequestLogInsert>): GatewayRequestLogInsert {
  return {
    requestId: "req", requestedAt: "2027-02-01T10:00:00.000Z", provider: "CLAUDE", accountId: pooled, apiKeyId: null, model: "claude-opus-5-5",
    reasoningEffort: null, serviceTier: null, transport: "http", status: "success", errorCode: null, latencyMs: 2000, firstTokenMs: 300,
    inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50, reasoningTokens: null, costUsd: 0.01, compressionTokensSaved: null,
    stickyKind: null, stickyKeyHash: null, ...extra
  };
}

function message(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, at: "2027-02-01T10:00:05.000Z", sessionId: "claude-session-a", model: "claude-opus-5-5", requestId: `req_${id}`,
    inputTokens: 10, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, cacheCreation1hInputTokens: 0, outputTokens: 7,
    thinkingTokens: 0, speed: null, ...extra
  };
}

async function sources(claude: unknown[] | null, owners: Record<string, string | null> = {}) {
  const repository = new InMemorySystemAnalyticsRepository();
  const gateway = new InMemoryGatewayRepository();
  const readClaude = vi.fn(async () => claude === null ? null : {
    schema: 2, generatedAt: now.toISOString(), since: "2027-01-01T00:00:00.000Z",
    profiles: [{ profileId: "main", email: "ntheo@spaceapp.dev", lastSessionIds: ["claude-session-main"] },
      { profileId: "lab", email: "LAB@spaceapp.dev", lastSessionIds: [] }], messages: claude
  });
  const options: TokenUsageSourceOptions = {
    repository, gateway: () => gateway, readClaude, now: () => now,
    gatewayAccounts: async () => [
      { id: lab, provider: "CLAUDE", email: "lab@spaceapp.dev", label: "lab" },
      { id: pooled, provider: "CLAUDE", email: "crew@spaceapp.dev", label: "crew" }
    ],
    claudeSessionOwner: async (sessionId) => sessionId in owners
      ? { profileId: owners[sessionId] ?? null, paneSessionId: `cli_session:${sessionId}`, roomId: "room:a", paneId: "pane:a" }
      : null
  };
  return { repository, gateway, readClaude, options };
}

describe("token usage sources", () => {
  it("imports every gateway request once, after its cursor, with account and API value", async () => {
    const { repository, gateway, options } = await sources(null);
    await gateway.insertRequestLogs([
      log({ requestId: "a" }),
      log({ requestId: "warm", source: "limit_warmup" }),
      log({ requestId: "failed", status: "error", errorCode: "http_400", model: "claude-sonnet-5-5", inputTokens: null, outputTokens: null, costUsd: null }),
      log({ requestId: "g", provider: "ANTIGRAVITY", model: "gemini-3.8-flash", requestedAt: "2027-02-01T10:30:00.000Z", costUsd: null })
    ]);
    expect(await ingestGatewayLogs(options)).toBe(3);
    expect(await ingestGatewayLogs(options)).toBe(0);
    await gateway.insertRequestLogs([log({ requestId: "b", provider: "CODEX", model: "gpt-6-astra", accountId: null, costUsd: null })]);
    expect(await ingestGatewayLogs(options)).toBe(1);

    const events = await repository.listModelEvents("2027-01-01T00:00:00.000Z");
    expect(events.map((event) => [event.turnId, event.providerId, event.route, event.accountKey])).toEqual([
      ["a", "anthropic", "GATEWAY", pooled], ["failed", "anthropic", "GATEWAY", pooled], ["b", "codex", "GATEWAY", null], ["g", "google", "GATEWAY", pooled]
    ]);
    // A failed request without usage spent nothing: zero tokens, not "not reported".
    const byTurn = Object.fromEntries(events.map((event) => [event.turnId, event]));
    expect(byTurn.failed).toMatchObject({ status: "ABORTED", tokensIn: 0, tokensOut: 0 });
    expect(events[0]).toMatchObject({ source: "gateway", tokensIn: 1000, tokensOut: 50, costUsd: 0.01, tokensCacheRead: 800,
      endedAt: "2027-02-01T10:00:02.000Z" });
    expect(await repository.getCursor(GEMINI_GATEWAY_CURSOR)).toBe("2027-02-01T10:30:00.000Z");
    // A Codex request logged before its model had a price gets one on import (GPT-6 Astra: 10 / 1 cached / 50 per 1M).
    expect(byTurn.b!.costUsd).toBeCloseTo((200 * 10 + 800 * 1 + 50 * 50) / 1e6, 12);
    // A Gemini request logged before Gemini had a price gets one on import.
    expect(byTurn.g!.costUsd).toBeCloseTo((200 * 0.75 + 800 * 0.075 + 50 * 3.75) / 1e6, 12);
  });

  it("tells gateway calls in Claude transcripts apart and puts direct ones on their account", async () => {
    const { repository, gateway, readClaude, options } = await sources([
      message("via_id"),
      // A pane's session on the gateway profile whose call did not go through the gateway (the pane moved accounts).
      message("moved_account", { sessionId: "claude-session-gw", requestId: null }),
      message("direct_lab", { sessionId: "claude-session-lab", outputTokens: 9, cacheCreation1hInputTokens: 20 }),
      // The transcript's output count lags the gateway's final one; the prompt size is exact.
      message("old_gateway_log", { sessionId: null, requestId: "req_unknown", cacheReadInputTokens: 500, outputTokens: 30 }),
      message("hinted_main", { sessionId: "claude-session-main", outputTokens: 12 }),
      message("unattributed", { sessionId: null, outputTokens: 34 })
    ], { "claude-session-gw": "space-gateway", "claude-session-lab": "lab" });
    await gateway.insertRequestLogs([
      log({ requestId: "1", upstreamRequestId: "req_via_id", outputTokens: 7 }),
      // Logged before the gateway kept Anthropic's request id: matched by model, prompt size and time.
      log({ requestId: "2", inputTokens: 530, outputTokens: 33, requestedAt: "2027-02-01T09:58:00.000Z" })
    ]);

    expect(await ingestClaudeTranscripts(options)).toBe(6);
    expect(readClaude).toHaveBeenLastCalledWith(null);
    const events = Object.fromEntries((await repository.listModelEvents("2027-01-01T00:00:00.000Z")).map((event) => [event.turnId, event]));
    expect(events.via_id).toMatchObject({ source: "claude", route: "GATEWAY", accountKey: null, tokensIn: 130, tokensOut: 7, tokensCacheRead: 100 });
    expect(events.moved_account).toMatchObject({ route: "DIRECT", sessionId: "cli_session:claude-session-gw", paneId: "pane:a" });
    expect(events.direct_lab).toMatchObject({ route: "DIRECT", accountKey: lab, tokensCacheWrite: 20 });
    // Opus 5.5 at the gateway's prices: 4 $/M input, 0.2 cache read, 1h cache writes at twice the input price, 20 output.
    expect(events.direct_lab!.costUsd).toBeCloseTo((10 * 4 + 100 * 0.2 + 20 * 8 + 9 * 20) / 1e6, 12);
    expect(events.old_gateway_log).toMatchObject({ route: "GATEWAY" });
    expect(events.unattributed).toMatchObject({ route: "DIRECT", accountKey: "cli:claude/unattributed" });
    // A session outside Space panes that a profile lists as its last one goes to that profile.
    expect(events.hinted_main).toMatchObject({ route: "DIRECT", accountKey: "cli:claude/main" });
    expect(await repository.getCursor(CLAUDE_TIME_CURSOR)).toBe("2027-02-01T10:00:05.000Z");

    // The next read asks only for newer messages, with a ten-minute overlap; message ids keep it idempotent.
    await ingestClaudeTranscripts(options);
    expect(readClaude).toHaveBeenLastCalledWith("2027-02-01T09:50:05Z");
    expect(await repository.listModelEvents("2027-01-01T00:00:00.000Z")).toHaveLength(6);
  });

  it("does nothing where the helper cannot run", async () => {
    const { repository, options } = await sources(null);
    expect(await ingestClaudeTranscripts(options)).toBe(0);
    expect(await repository.getCursor(CLAUDE_TIME_CURSOR)).toBeNull();
  });

  it("counts each token once on the page, splits Gateway and direct, and lists accounts with their models", async () => {
    const repository = new InMemorySystemAnalyticsRepository();
    // The Claude session ran in a pane that is closed now: only its revision's latest session row names the profile.
    const store = {
      listRooms: () => [], listPanes: () => [], listActivePaneCliSessions: () => [], listActivePaneCliSessionsForRuntimes: () => [],
      listPaneCliSessions: () => [],
      getCliTaskRevisionByNativeRef: (_runtime: string, ref: string) => ref === "claude-session-a" ? { revisionId: "rev:a", latestSpaceSessionId: "cli_session:closed" } : null,
      getPaneCliSession: (id: string) => id === "cli_session:closed"
        ? { sessionId: id, paneId: "pane:closed", roomId: "room:old", accountProfileId: "lab", startedAt: "2027-02-01T08:00:00.000Z" } : null
    } as unknown as SpaceStore;
    const gateway = new InMemoryGatewayRepository();
    await gateway.insertRequestLogs([log({ requestId: "1", upstreamRequestId: "req_via_id", outputTokens: 7, inputTokens: 130 })]);
    const service = new SystemAnalyticsService({
      codexHome: ownedRoot, stateRoot: ownedRoot, hermesHome: ownedRoot, repository, store, liveSessions: async () => [], now: () => now,
      coreCount: 1, readProcessTable: async () => [], readMeminfo: async () => "MemTotal: 1000 kB\nMemAvailable: 400 kB\n",
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n",
      tokenUsage: {
        gateway: () => gateway,
        gatewayAccounts: async () => [{ id: pooled, provider: "CLAUDE", email: "crew@spaceapp.dev", label: "crew",
          // Two days of the week left: 71% passed (plan clipboard:nUloPOH3blDT).
          primaryWindow: { usedPercent: 40, resetAt: null, windowMinutes: 300 },
          secondaryWindow: { usedPercent: 54, resetAt: new Date(now.getTime() + 2 * 86_400_000).toISOString(), windowMinutes: 10080 } },
          { id: lab, provider: "CLAUDE", email: "lab@spaceapp.dev", label: "lab" }],
        readClaude: async () => ({ schema: 2, generatedAt: now.toISOString(), profiles: [{ profileId: "lab", email: "lab@spaceapp.dev" }],
          messages: [message("via_id"), message("direct", { requestId: "req_direct", outputTokens: 20 })] })
      }
    });
    // An event stored before routes existed keeps counting.
    await repository.upsertModelEvents([{
      eventKey: "codex:global:old", source: "codex", runtimeId: "cli:codex", providerId: "codex", modelId: "gpt-6-astra", roomId: null,
      paneId: null, sessionId: null, turnId: "old", status: "COMPLETED", coverage: "NATIVE", turnCount: 1, startedAt: "2027-02-01T09:00:00.000Z",
      endedAt: "2027-02-01T09:00:00.000Z", tokensIn: 1000, tokensOut: 100, tokensReasoning: 0, ttftMs: null, durationMs: null, updatedAt: now.toISOString()
    }, {
      // A turn stored under its pane's key before routes existed, and the same turn read again after the pane closed:
      // it went through the gateway, so neither copy counts as direct.
      eventKey: "codex:cli_session:gone:t9", source: "codex", runtimeId: "cli:codex", providerId: "codex", modelId: "gpt-6-astra", roomId: null,
      paneId: null, sessionId: "cli_session:gone", turnId: "t9", status: "COMPLETED", coverage: "NATIVE", turnCount: 1, startedAt: "2027-02-01T09:30:00.000Z",
      endedAt: "2027-02-01T09:30:00.000Z", tokensIn: 500, tokensOut: 50, tokensReasoning: 0, ttftMs: null, durationMs: null, updatedAt: now.toISOString()
    }, {
      eventKey: "codex:global:t9", source: "codex", runtimeId: "cli:codex", providerId: "codex", modelId: "gpt-6-astra", roomId: null,
      paneId: null, sessionId: null, turnId: "t9", status: "COMPLETED", coverage: "NATIVE", turnCount: 1, startedAt: "2027-02-01T09:30:00.000Z",
      endedAt: "2027-02-01T09:30:00.000Z", tokensIn: 500, tokensOut: 50, tokensReasoning: 0, ttftMs: null, durationMs: null, updatedAt: now.toISOString(),
      route: "GATEWAY"
    }]);
    await service.ingestTokenSources();

    const all = await service.models("24h");
    expect(all.routes).toEqual({
      gateway: { tokensIn: 130, tokensOut: 7, tokensReasoning: 0, costUsd: 0.01, unpricedTurns: 0 },
      direct: expect.objectContaining({ tokensIn: 1130, tokensOut: 120, unpricedTurns: 1 })
    });
    // The bars over time add up to the same totals, hour by hour.
    expect(all.timeline!.bucketSeconds).toBe(3600);
    expect(all.timeline!.points.reduce((sum, point) => sum + point.gatewayTokens, 0)).toBe(137);
    expect(all.timeline!.points.reduce((sum, point) => sum + point.directTokens, 0)).toBe(1250);
    expect(all.composition).toMatchObject({ cacheRead: 900, cacheWrite: 20, output: 127 });
    const opus = all.models.find((model) => model.modelId === "claude-opus-5-5")!;
    expect([opus.tokensIn, opus.tokensOut]).toEqual([260, 27]);
    expect(opus.costUsd).toBeCloseTo(0.01 + (10 * 4 + 100 * 0.2 + 20 * 5 + 20 * 20) / 1e6, 9);
    expect(all.accounts?.map((account) => [account.label, account.route, account.tokensIn + account.tokensOut])).toEqual([
      ["codex · Codex CLI (direct)", "DIRECT", 1100], ["lab · Claude", "DIRECT", 150], ["crew · Claude", "GATEWAY", 137]
    ]);
    // Each subscription account's week: used % minus the share passed; no windows, no pace.
    expect(all.accounts?.find((account) => account.label === "crew · Claude")?.weeklyPace).toMatchObject({ usedPercent: 54, passedPercent: 71, points: -17, pace: "UNDER" });
    expect(all.accounts?.find((account) => account.label === "lab · Claude")?.weeklyPace).toBeNull();

    const direct = await service.models("24h", "direct");
    expect(direct.models.map((model) => [model.modelId, model.tokensOut])).toEqual(expect.arrayContaining([["claude-opus-5-5", 20], ["gpt-6-astra", 100]]));
    expect((await service.models("24h", "gateway")).models.map((model) => [model.modelId, model.tokensOut])).toEqual([["claude-opus-5-5", 7]]);
    await service.dispose();
  });

  it("counts the Codex turns of owner-only rollouts once, from the helper's whole-file read", async () => {
    const repository = new InMemorySystemAnalyticsRepository();
    const store = {
      listRooms: () => [], listPanes: () => [], listActivePaneCliSessions: () => [], listActivePaneCliSessionsForRuntimes: () => [],
      listPaneCliSessions: () => [], getCliTaskRevisionByNativeRef: () => null
    } as unknown as SpaceStore;
    const turn = (turnId: string, provider: string, tokensIn: number, tokensOut: number) => ({ turnId, provider, model: "gpt-6-astra",
      startedAt: "2027-01-20T08:00:00.000Z", endedAt: "2027-01-20T08:05:00.000Z", status: "COMPLETED", tokensIn, tokensOut, tokensReasoning: 0, tokensCacheRead: 0 });
    const service = new SystemAnalyticsService({
      codexHome: ownedRoot, stateRoot: ownedRoot, hermesHome: ownedRoot, repository, store, liveSessions: async () => [], now: () => now,
      coreCount: 1, readProcessTable: async () => [], readMeminfo: async () => "MemTotal: 1000 kB\nMemAvailable: 400 kB\n",
      readProcStat: async () => "cpu  100 0 100 800 0 0 0 0 0 0\n",
      tokenUsage: {
        gateway: () => new InMemoryGatewayRepository(), gatewayAccounts: async () => [], readClaude: async () => null,
        readCodexHistory: async () => ({ schema: 2, generatedAt: now.toISOString(),
          codexTurns: [turn("t1", "codex-lb", 3000, 300), turn("t3", "space-gateway", 400, 40)] })
      }
    });
    // What the live tail read of the time stored for t1: part of the turn, under its pane's key, without a route.
    await repository.upsertModelEvents([{
      eventKey: "codex:cli_session:gone:t1", source: "codex", runtimeId: "cli:codex", providerId: "codex", modelId: "gpt-6-astra", roomId: null,
      paneId: null, sessionId: "cli_session:gone", turnId: "t1", status: "COMPLETED", coverage: "NATIVE", turnCount: 1,
      startedAt: "2027-01-20T08:00:00.000Z", endedAt: "2027-01-20T08:05:00.000Z", tokensIn: 100, tokensOut: 10, tokensReasoning: 0,
      ttftMs: null, durationMs: null, updatedAt: now.toISOString()
    }]);
    await service.backfill();

    const month = await service.models("30d");
    expect(month.accounts?.map((account) => [account.label, account.route, account.tokensIn + account.tokensOut])).toEqual([
      ["codex-lb · Codex CLI (direct)", "DIRECT", 3300]
    ]);
    // GPT-6 Astra: 10 $/M input, 50 output.
    expect(month.routes!.direct.costUsd).toBeCloseTo((3000 * 10 + 300 * 50) / 1e6, 9);
    expect(month.routes!.gateway.tokensIn).toBe(0);
    await service.dispose();
  });
});
