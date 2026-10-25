import { describe, expect, it, vi } from "vitest";
import {
  InMemorySystemAnalyticsRepository,
  PostgresSystemAnalyticsRepository,
  type SystemAnalyticsModelEventRecord,
  type SystemAnalyticsResourceSample
} from "../src/system-analytics-repository.js";
import type { PgPoolLike } from "../src/space-store.js";

const now = "2026-08-11T08:00:09.000Z";

function hostSample(sampledAt: string, cpu: number, rss: number): SystemAnalyticsResourceSample {
  return {
    sampledAt,
    entityType: "HOST",
    entityId: "host",
    roomId: null,
    roomName: null,
    paneId: null,
    paneTitle: null,
    sessionId: null,
    runtimeId: null,
    runtimeName: null,
    providerId: null,
    modelId: null,
    processCount: 100,
    cpuOneCorePercent: cpu,
    rssBytes: rss,
    memoryTotalBytes: 1_000,
    memoryAvailableBytes: 400,
    swapTotalBytes: 200,
    swapUsedBytes: 50,
    pageCacheBytes: 100,
    pressure: false
  };
}

describe("system analytics repositories", () => {
  it("aggregates in-memory samples into deterministic 10-second buckets", async () => {
    const repository = new InMemorySystemAnalyticsRepository();
    await repository.insertResourceSamples([
      hostSample("2026-08-11T08:00:01.000Z", 10, 400),
      hostSample(now, 30, 600)
    ]);

    await expect(repository.listResourceBuckets({
      since: "2026-08-11T08:00:00.000Z",
      resolutionSeconds: 10
    })).resolves.toEqual([
      expect.objectContaining({
        bucketAt: "2026-08-11T08:00:00.000Z",
        sampleCount: 2,
        cpuMin: 10,
        cpuSum: 40,
        cpuMax: 30,
        rssMin: 400,
        rssSum: 1_000,
        rssMax: 600
      })
    ]);
  });

  it("keeps every model event (token usage, operator rule 2026-10-18) and leaves orphan RUNNING turns out of the lists", async () => {
    const repository = new InMemorySystemAnalyticsRepository();
    await repository.upsertModelEvents([{
      eventKey: "codex:orphan:turn",
      source: "codex",
      runtimeId: "cli:codex",
      providerId: "codex-lb",
      modelId: "gpt-5.6-sol",
      roomId: null,
      paneId: null,
      sessionId: "cli_session:orphan",
      turnId: "turn:orphan",
      status: "RUNNING",
      coverage: "NATIVE",
      turnCount: 1,
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: null,
      tokensIn: 1,
      tokensOut: 1,
      tokensReasoning: 0,
      ttftMs: null,
      durationMs: null,
      updatedAt: "2026-06-01T00:00:00.000Z"
    }]);

    // Older than the 31 days the sweep used to keep.
    await repository.upsertModelEvents([modelEvent("codex:old", { startedAt: "2026-07-01T00:00:00.000Z", endedAt: "2026-07-01T00:01:00.000Z" })]);

    await repository.rollupAndSweep(now);
    await expect(repository.listModelEvents("2026-06-15T00:00:00.000Z")).resolves.toEqual([expect.objectContaining({ eventKey: "codex:old", tokensIn: 10 })]);
    await expect(repository.listModelEvents("2026-01-01T00:00:00.000Z")).resolves.toEqual([
      expect.objectContaining({ eventKey: "codex:orphan:turn", tokensIn: 1 }), expect.objectContaining({ eventKey: "codex:old" })
    ]);
  });

  const modelEvent = (eventKey: string, extra: Partial<SystemAnalyticsModelEventRecord> = {}): SystemAnalyticsModelEventRecord => ({
    eventKey, source: "codex", runtimeId: "cli:codex", providerId: "codex", modelId: "gpt-6-astra", roomId: null, paneId: null,
    sessionId: null, turnId: null, status: "COMPLETED", coverage: "NATIVE", turnCount: 1, startedAt: now, endedAt: now,
    tokensIn: 10, tokensOut: 2, tokensReasoning: null, ttftMs: null, durationMs: null, updatedAt: now, ...extra
  });

  it("keeps a stored route, account and API value when a later read does not know them", async () => {
    const repository = new InMemorySystemAnalyticsRepository();
    await repository.upsertModelEvents([modelEvent("codex:a", { route: "GATEWAY", accountKey: "gw_account:1", costUsd: 0.5, tokensCacheRead: 4 })]);
    await repository.upsertModelEvents([modelEvent("codex:a", { tokensOut: 3 })]);
    await expect(repository.listModelEvents("2026-01-01T00:00:00.000Z")).resolves.toEqual([
      expect.objectContaining({ tokensOut: 3, route: "GATEWAY", accountKey: "gw_account:1", costUsd: 0.5, tokensCacheRead: 4, tokensCacheWrite: null })
    ]);
  });

  it("lists model events of the given providers only, or of all when none are given", async () => {
    const memory = new InMemorySystemAnalyticsRepository();
    await memory.upsertModelEvents([modelEvent("codex:a"), modelEvent("opencode:a", { providerId: "opencode" })]);
    await expect(memory.listModelEvents("2026-01-01T00:00:00.000Z", ["opencode"])).resolves.toEqual([expect.objectContaining({ eventKey: "opencode:a" })]);
    await expect(memory.listModelEvents("2026-01-01T00:00:00.000Z")).resolves.toHaveLength(2);
    const { pool, queries } = recordingPool();
    const repository = new PostgresSystemAnalyticsRepository(pool);
    await repository.listModelEvents("2026-01-01T00:00:00.000Z", ["opencode"]);
    await repository.listModelEvents("2026-01-01T00:00:00.000Z");
    expect(queries.map((entry) => entry.values[1])).toEqual([["opencode"], null]);
    expect(queries[0]!.sql).toContain("AND ($2::text[] IS NULL OR provider_id = ANY($2::text[]))");
  });

  it("upserts model events in batches of 500 with one row per key, keeping stored routes", async () => {
    const { pool, queries } = recordingPool();
    const repository = new PostgresSystemAnalyticsRepository(pool);
    const events = Array.from({ length: 1001 }, (_, index) => modelEvent(`claude:msg_${index}`, { source: "claude" }));
    await repository.upsertModelEvents([...events, modelEvent("claude:msg_0", { source: "claude", route: "DIRECT" })]);
    expect(queries.map((entry) => entry.values.length)).toEqual([500 * 25, 500 * 25, 25]);
    expect(queries[0]!.values[20]).toBe("DIRECT");
    expect(queries[0]!.sql).toContain("route = COALESCE(EXCLUDED.route, system_analytics_model_events.route)");
  });

  it("uses conflict-safe inserts and transactional multi-resolution Postgres rollups", async () => {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      query,
      connect: vi.fn(async () => ({ query, release }))
    } as unknown as PgPoolLike;
    const repository = new PostgresSystemAnalyticsRepository(pool);

    await repository.insertResourceSamples([hostSample(now, 25, 500)]);
    expect(queries[0]?.sql).toContain("ON CONFLICT (resolution_seconds, bucket_at, entity_type, entity_id) DO UPDATE");
    expect(queries[0]?.sql).toContain("jsonb_to_recordset($1::jsonb)");
    expect(queries[0]?.sql).toContain("s.rss::bigint, s.rss::numeric, s.rss::bigint");
    expect(queries[0]?.values).toHaveLength(1);
    expect(JSON.parse(String(queries[0]?.values[0]))).toEqual([expect.objectContaining({
      bucket_at: "2026-08-11T08:00:00.000Z",
      entity_type: "HOST",
      entity_id: "host",
      cpu: 25,
      rss: 500
    })]);

    queries.length = 0;
    await repository.rollupAndSweep(now);
    const sql = queries.map((entry) => entry.sql).join("\n");
    expect(queries[0]?.sql).toBe("BEGIN");
    expect(sql.match(/INSERT INTO system_analytics_resource_buckets/g)).toHaveLength(2);
    expect(sql).toContain("resolution_seconds = 10");
    expect(sql).toContain("resolution_seconds = 60");
    expect(sql).toContain("resolution_seconds = 900");
    expect(sql).toContain("$1::integer");
    expect(sql).toContain("$2::integer");
    expect(sql).not.toMatch(/DELETE FROM system_analytics_model_events/);
    expect(sql).toContain(") IS DISTINCT FROM (");
    expect(queries.at(-1)?.sql).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  function recordingPool(failOn?: (sql: string) => boolean) {
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (failOn?.(sql)) throw new Error("simulated failure");
      return { rows: [] };
    });
    const pool = { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as PgPoolLike;
    const rollupSinces = () => queries
      .filter((entry) => entry.sql.includes("GROUP BY 2, entity_type, entity_id"))
      .map((entry) => [entry.values[0], entry.values[2]]);
    return { pool, queries, rollupSinces };
  }

  it("writes one multi-row upsert per sampling tick and splits repeated bucket keys into ordered rounds", async () => {
    const { pool, queries } = recordingPool();
    const repository = new PostgresSystemAnalyticsRepository(pool);
    const session = { ...hostSample(now, 5, 50), entityType: "CLI_SESSION" as const, entityId: "cli_session:a" };

    await repository.insertResourceSamples([]);
    expect(queries).toHaveLength(0);

    await repository.insertResourceSamples([hostSample(now, 25, 500), session]);
    expect(queries).toHaveLength(1);
    expect(JSON.parse(String(queries[0]?.values[0]))).toHaveLength(2);

    queries.length = 0;
    // Same 10 s bucket for the host twice: the second row must accumulate in a
    // later statement, never conflict with itself inside one INSERT.
    await repository.insertResourceSamples([
      hostSample("2026-08-11T08:00:01.000Z", 10, 400),
      session,
      hostSample("2026-08-11T08:00:02.000Z", 30, 600)
    ]);
    expect(queries).toHaveLength(2);
    expect(JSON.parse(String(queries[0]?.values[0])).map((row: { entity_id: string; cpu: number }) => [row.entity_id, row.cpu]))
      .toEqual([["host", 10], ["cli_session:a", 5]]);
    expect(JSON.parse(String(queries[1]?.values[0])).map((row: { entity_id: string; cpu: number }) => [row.entity_id, row.cpu]))
      .toEqual([["host", 30]]);
  });

  it("catches up over the original windows first, then re-aggregates only buckets that can still change", async () => {
    const { pool, rollupSinces } = recordingPool();
    const repository = new PostgresSystemAnalyticsRepository(pool);

    await repository.rollupAndSweep("2026-08-11T08:00:09.000Z");
    await repository.rollupAndSweep("2026-08-11T08:01:10.000Z");

    expect(rollupSinces()).toEqual([
      [60, "2026-08-11T05:00:09.000Z"],
      [900, "2026-08-08T08:00:09.000Z"],
      [60, "2026-08-11T07:55:00.000Z"],
      [900, "2026-08-11T07:30:00.000Z"]
    ]);

    // A new process (no watermark) catches up over the original windows again.
    const restarted = recordingPool();
    await new PostgresSystemAnalyticsRepository(restarted.pool).rollupAndSweep("2026-08-11T09:00:00.000Z");
    expect(restarted.rollupSinces()).toEqual([
      [60, "2026-08-11T06:00:00.000Z"],
      [900, "2026-08-08T09:00:00.000Z"]
    ]);
  });

  it("advances the rollup watermark only after a committed rollup", async () => {
    let failSweep = false;
    const { pool, rollupSinces, queries } = recordingPool((sql) => failSweep && sql.includes("resolution_seconds = 900 AND bucket_at <"));
    const repository = new PostgresSystemAnalyticsRepository(pool);

    await repository.rollupAndSweep("2026-08-11T08:00:09.000Z");
    failSweep = true;
    await expect(repository.rollupAndSweep("2026-08-11T08:01:10.000Z")).rejects.toThrow("simulated failure");
    expect(queries.at(-1)?.sql).toBe("ROLLBACK");
    failSweep = false;
    await repository.rollupAndSweep("2026-08-11T08:02:10.000Z");

    // The failed run did not move the watermark, so the next window still
    // starts from the last committed rollup (08:00:09).
    expect(rollupSinces().slice(-2)).toEqual([
      [60, "2026-08-11T07:55:00.000Z"],
      [900, "2026-08-11T07:30:00.000Z"]
    ]);
  });
});
