// Token usage figures from SQL groups instead of every model-event row in the API heap (stable 2026-10-19: 7d/30d
// read 226k/293k rows). The expected figures were produced by the per-event implementation before the change
// (fixtures/token-usage-models-expected.json); the in-memory store and a disposable PostgreSQL must both match them.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemorySystemAnalyticsRepository,
  PostgresSystemAnalyticsRepository,
  type SystemAnalyticsModelEventRecord,
  type SystemAnalyticsRepository
} from "@space/db";
import type { SpaceStore } from "@space/runtime";
import { applyPendingMigrations } from "../../../packages/db/src/migration-runner.js";
import { loadMigrations } from "../../../packages/db/src/migrations.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../../packages/db/tests/support/disposable-postgres.js";
import { SystemAnalyticsService, type SystemAnalyticsLiveSession } from "../src/system-analytics-service.js";

const now = "2027-01-15T08:00:00.000Z";
const at = (hoursAgo: number) => new Date(Date.parse(now) - hoursAgo * 3_600_000).toISOString();
const expectedPath = new URL("./fixtures/token-usage-models-expected.json", import.meta.url);
const historyRoot = mkdtempSync(join(tmpdir(), "space-token-usage-sql-"));
afterAll(() => rmSync(historyRoot, { recursive: true, force: true }));

const live = (cliSessionId: string, runtimeId: string, modelId: string | null): SystemAnalyticsLiveSession => ({
  cliSessionId, paneId: `pane:${cliSessionId}`, roomId: "room:tokens", runtimeId, codexThreadId: null, modelId, reasoningEffort: null,
  pid: 100, status: "RUNNING", attachmentCount: 1, startedAt: at(2), detachedAt: null, endedAt: null
});
const liveSessions = [live("s1", "cli:claude", "claude-sonnet-5-5"), live("s2", "cli:codex", "gpt-5.6-sol"), live("s3", "cli:codex", null)];

function event(eventKey: string, hoursAgo: number, extra: Partial<SystemAnalyticsModelEventRecord> = {}): SystemAnalyticsModelEventRecord {
  return {
    eventKey, source: "codex", runtimeId: "cli:codex", providerId: "codex", modelId: "gpt-5.6-sol", roomId: "room:tokens", paneId: "pane:tokens",
    sessionId: null, turnId: null, status: "COMPLETED", coverage: "NATIVE", turnCount: 1, startedAt: at(hoursAgo), endedAt: at(hoursAgo - 0.01),
    tokensIn: 0, tokensOut: 0, tokensReasoning: null, ttftMs: null, durationMs: null, updatedAt: at(hoursAgo - 0.01), route: null, accountKey: null,
    costUsd: null, tokensCacheRead: null, tokensCacheWrite: null, ...extra
  };
}

const claude = { source: "claude", runtimeId: "cli:claude", providerId: "anthropic" } as const;
const gateway = { source: "gateway", runtimeId: "gateway", providerId: "anthropic", route: "GATEWAY", accountKey: "gw_account:1" } as const;
const events: SystemAnalyticsModelEventRecord[] = [
  // One turn read twice: the copy that knows its route wins over the fuller one; without routes the fullest wins.
  event("codex:pane:t1", 30, { turnId: "t1", tokensIn: 100, tokensOut: 10, costUsd: 0.0012 }),
  event("codex:global:t1", 29, { turnId: "t1", tokensIn: 90, tokensOut: 9, route: "DIRECT", accountKey: "cli:codex/main", costUsd: 0.0011, ttftMs: 200, durationMs: 1500 }),
  event("codex:pane:t2", 20, { turnId: "t2", tokensIn: 50, tokensOut: 5 }),
  event("codex:global:t2", 19, { turnId: "t2", tokensIn: 80, tokensOut: 8, tokensReasoning: 7, accountKey: "cli:codex/main", costUsd: 0.0008 }),
  event("gateway:1", 48, { ...gateway, modelId: "claude-opus-5-5", tokensIn: 1500, tokensOut: 300, tokensCacheRead: 1000, tokensCacheWrite: 200, costUsd: 0.25, ttftMs: 900, durationMs: 4000 }),
  event("gateway:2", 100, { ...gateway, modelId: "claude-haiku-5-5", tokensIn: 1000, tokensOut: 100, tokensCacheRead: 1200, costUsd: 0.01 }),
  // A gateway call's transcript copy: not counted, but it still names the live session's model.
  event("claude:msg_1", 10, { ...claude, modelId: "claude-sonnet-5-5", route: "GATEWAY", sessionId: "s1", tokensIn: 2000, tokensOut: 200 }),
  event("claude:msg_2", 72, { ...claude, modelId: "claude-sonnet-5-5", route: "DIRECT", accountKey: "cli:claude/main", sessionId: "s1", tokensIn: 400, tokensOut: 40, ttftMs: 500, durationMs: 2000 }),
  event("claude:msg_3", 0.1, { ...claude, modelId: "claude-opus-5-5", status: "RUNNING", sessionId: "s1", tokensIn: 10, tokensOut: 1, endedAt: null, updatedAt: now }),
  event("claude:msg_4", 0.2, { ...claude, modelId: "claude-opus-5-5", status: "RUNNING", sessionId: "s9", tokensIn: 999, tokensOut: 99, endedAt: null, updatedAt: now }),
  event("root:1", 3, { source: "session", runtimeId: "cli:root", providerId: "root", modelId: "root", tokensIn: 5, tokensOut: 5 }),
  event("codex:unknown", 5, { providerId: "codex-lb", modelId: "unknown", tokensIn: 30, tokensOut: 3, costUsd: 0.0003 }),
  event("opencode:old", 480, { source: "opencode", runtimeId: "cli:opencode", providerId: "opencode", modelId: "big-pickle", status: "ABORTED", turnCount: 2, turnId: "o1", ttftMs: 300, tokensIn: 700, tokensOut: 70, accountKey: "cli:opencode/main", costUsd: 0 }),
  event("session:s1", 2, { source: "session", runtimeId: "cli:claude", providerId: "anthropic", modelId: "claude-sonnet-5-5", status: "SESSION", coverage: "SESSION_ONLY", turnCount: 0, sessionId: "s1", tokensIn: null, tokensOut: null }),
  // RUNNING since before the window: listed (updated lately), but outside the timeline.
  event("claude:running-old", 960, { ...claude, modelId: "claude-sonnet-5-5", status: "RUNNING", sessionId: "s1", tokensIn: 5, tokensOut: 0, endedAt: null, updatedAt: now }),
  event("codex:zero-turn", 1, { turnId: "t3", turnCount: 0, ttftMs: 100, accountKey: "cli:codex/main" }),
  event("codex:noend", 3, { turnId: "t4", endedAt: null, updatedAt: at(2), tokensIn: 20, tokensOut: 2, route: "DIRECT", accountKey: "cli:codex/main" }),
  event("codex:s2:t5", 0.2, { turnId: "t5", status: "RUNNING", sessionId: "s2", tokensIn: 15, tokensOut: 1, endedAt: null, updatedAt: now }),
  event("codex:s2:t6", 1, { turnId: "t6", modelId: "gpt-6-astra", sessionId: "s2", tokensIn: 25, tokensOut: 2 }),
  event("codex:s3:a", 6, { turnId: "t7", modelId: "gpt-6-astra", sessionId: "s3", tokensIn: 12, tokensOut: 1 }),
  event("codex:s3:b", 4, { turnId: "t8", sessionId: "s3", tokensIn: 13, tokensOut: 1 }),
  // A transcript message lists before every turn of its session, so it names s3's model although it is newer.
  event("claude:s3", 1.5, { ...claude, modelId: "claude-haiku-5-5", sessionId: "s3", tokensIn: 7, tokensOut: 1 })
];

const store = { listRooms: () => [], listPanes: () => [], listActivePaneCliSessions: () => [], listActivePaneCliSessionsForRuntimes: () => [], listPaneCliSessions: () => [] } as unknown as SpaceStore;

async function figures(repository: SystemAnalyticsRepository) {
  const service = new SystemAnalyticsService({
    codexHome: historyRoot, stateRoot: historyRoot, hermesHome: historyRoot, repository, store, liveSessions: async () => liveSessions,
    now: () => new Date(now), coreCount: 1, readProcessTable: async () => [], readMeminfo: async () => "MemTotal: 1024 kB\nMemAvailable: 1024 kB\n",
    readProcStat: async () => "cpu 0 0 0 100 0 0 0 0 0 0\n"
  });
  try {
    await service.sample();
    const result: Record<string, unknown> = {};
    for (const range of ["24h", "7d", "30d"] as const) {
      for (const route of ["all", "gateway", "direct"] as const) result[`${range}/${route}`] = await service.models(range, route);
    }
    return result;
  } finally {
    await service.dispose();
  }
}

describe("Token usage from SQL groups", () => {
  it("gives the per-event figures from the in-memory store", async () => {
    const repository = new InMemorySystemAnalyticsRepository();
    await repository.upsertModelEvents(events);
    const result = await figures(repository);
    expect(result).toEqual(JSON.parse(readFileSync(expectedPath, "utf8")));
  });

  const unavailable = disposablePostgresUnavailableReason();
  describe.skipIf(unavailable !== null)(`on PostgreSQL${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
    let server: DisposablePostgres;
    let pool: pg.Pool;

    beforeAll(async () => {
      server = await startDisposablePostgres("tokensql");
      await server.createDatabase("space_tokensql");
      pool = server.pool("space_tokensql", 4);
      const client = await pool.connect();
      try {
        await applyPendingMigrations(client, await loadMigrations());
      } finally {
        client.release();
      }
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      await server?.stop();
    });

    it("gives the same figures", async () => {
      const repository = new PostgresSystemAnalyticsRepository(pool);
      await repository.upsertModelEvents(events);
      expect(await figures(repository)).toEqual(JSON.parse(readFileSync(expectedPath, "utf8")));
    }, 60_000);
  });
});
