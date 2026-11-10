// Concurrency of durable memory state on a real, disposable PostgreSQL with
// every migration applied: consolidation runs, findings and operations stay
// unique under racing writers, change sets are idempotent by ID, and live
// personal memory is a compare-and-set. Skips with a reason without Docker.
import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresLiveMemoryRepository } from "../src/live-memory-repository.js";
import { applyPendingMigrations } from "../src/migration-runner.js";
import { loadMigrations } from "../src/migrations.js";
import { PostgresSpaceStore } from "../src/space-store.js";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "./support/disposable-postgres.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const racers = 8;

const unavailable = disposablePostgresUnavailableReason();
if (unavailable) process.stderr.write(`[memory concurrency] skipped: ${unavailable}\n`);

describe.skipIf(unavailable !== null)(`memory state under concurrent writers${unavailable ? ` (skipped: ${unavailable})` : ""}`, () => {
  let server: DisposablePostgres;
  let pool: pg.Pool;
  let store: PostgresSpaceStore;

  beforeAll(async () => {
    server = await startDisposablePostgres("memory-race");
    await server.createDatabase("memory_race");
    pool = server.pool("memory_race", racers + 2);
    const client = await pool.connect();
    try {
      await applyPendingMigrations(client, await loadMigrations());
    } finally {
      client.release();
    }
    await pool.query("INSERT INTO users (id, email, role) VALUES ('user:memory-race', 'race@memory.test', 'ADMIN')");
    store = new PostgresSpaceStore(pool);
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
  }, 120_000);

  async function runningRun(label: string) {
    const created = await store.createMemoryConsolidationRun({
      mode: "REPAIR",
      triggerKind: "OPERATOR",
      workflowId: `workflow:memory-race-${label}`,
      dedupeKey: `operator:memory-race-${label}`,
      actorUserId: "user:memory-race",
      sourceHash: null
    });
    return store.updateMemoryConsolidationRun(created.id, { status: "RUNNING", sourceHash: sha256(label), progressCompleted: 0, progressTotal: 1 });
  }

  it("creates one consolidation run per dedupe key when schedulers race", async () => {
    const runs = await Promise.all(Array.from({ length: racers }, () => store.createMemoryConsolidationRun({
      mode: "AUDIT",
      triggerKind: "SCHEDULED",
      workflowId: "workflow:memory-race-daily",
      dedupeKey: "scheduled:memory-race-2026-10-11",
      sourceHash: null,
      actorUserId: null
    }).catch((error: unknown) => error)));
    const created = runs.filter((run) => !(run instanceof Error)) as Array<{ id: string }>;
    expect(created.length).toBeGreaterThan(0);
    expect(new Set(created.map((run) => run.id)).size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM memory_consolidation_runs WHERE dedupe_key = $1", ["scheduled:memory-race-2026-10-11"])).rows[0].n).toBe(1);
  });

  it("keeps one finding per issue and one operation per finding when prepare attempts overlap", async () => {
    const run = await runningRun("findings");
    const findings = await Promise.all(Array.from({ length: racers }, () => store.createMemoryConsolidationFinding({
      runId: run.id,
      issueId: "memory_issue:race-duplicate",
      findingType: "EXACT_DUPLICATE",
      severity: "WARN",
      confidence: 1,
      recordIds: ["memory:race-a", "memory:race-b"],
      sourcePath: "/tmp/race.md",
      evidence: "Same exact body"
    })));
    expect(new Set(findings.map((finding) => finding.id)).size).toBe(1);
    const operations = await Promise.all(Array.from({ length: racers }, () => store.createMemoryConsolidationOperation({
      runId: run.id,
      findingId: findings[0]!.id,
      operationKind: "ARCHIVE_EXACT_DUPLICATE",
      recordIds: ["memory:race-b"],
      reason: "Archive the later exact duplicate."
    })));
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(1);
    expect((await store.listMemoryConsolidationOperations(run.id)).map((operation) => operation.findingId)).toEqual([findings[0]!.id]);
  });

  it("stores one change set for a deterministic ID and rejects a different body under the same ID", async () => {
    const before = "## Duplicate\n- body\n\n## Duplicate\n- body\n";
    const after = "## Duplicate\n- body\n\n## Duplicate\n- body\n- lifecycle_status=ARCHIVED\n";
    const input = {
      kind: "ARCHIVE" as const,
      sourcePath: "/tmp/race.md",
      recordIds: ["memory:race-b"],
      resolvesIssueIds: ["memory_issue:race-duplicate"],
      expectedSourceHash: sha256("source"),
      beforeContentHash: sha256(before),
      afterContentHash: sha256(after),
      beforeSnapshot: before,
      afterSnapshot: after,
      reason: "Deterministic repair.",
      actorUserId: "user:memory-race"
    };
    const results = await Promise.all(Array.from({ length: racers }, () =>
      store.createMemoryChangeSet(input, "trace:memory-race", { id: "memory_change:race-deterministic" }).catch((error: unknown) => error)));
    const stored = results.filter((result) => !(result instanceof Error)) as Array<{ id: string; status: string }>;
    expect(stored.length).toBeGreaterThan(0);
    expect(new Set(stored.map((changeSet) => changeSet.id))).toEqual(new Set(["memory_change:race-deterministic"]));
    expect((await pool.query("SELECT count(*)::int AS n FROM memory_graph_change_sets WHERE id = $1", ["memory_change:race-deterministic"])).rows[0].n).toBe(1);
    await expect(store.createMemoryChangeSet({ ...input, reason: "A different plan." }, "trace:memory-race", { id: "memory_change:race-deterministic" }))
      .rejects.toThrow();
  });

  it("lets exactly one live-memory writer win each revision and journals every committed revision once", async () => {
    const repository = new PostgresLiveMemoryRepository(pool);
    const owner = "user:memory-race";
    for (let round = 0; round < 3; round += 1) {
      const head = await repository.get(owner);
      const expected = head?.revision ?? 0;
      const wins = await Promise.all(Array.from({ length: racers }, (_, writer) =>
        repository.write(owner, expected, { round, writer }, { round, writer })));
      expect(wins.filter(Boolean)).toHaveLength(1);
      const next = await repository.get(owner);
      expect(next?.revision).toBe(expected + 1);
      expect(next?.value).toEqual({ round, writer: wins.indexOf(true) });
    }
    expect((await repository.changes(owner)).map((change) => change.revision)).toEqual([3, 2, 1]);
    // A writer holding a stale revision cannot overwrite the newer head.
    expect(await repository.write(owner, 1, { stale: true }, { stale: true })).toBe(false);
    expect((await repository.get(owner))?.revision).toBe(3);
  });
});
