// Lifecycle and concurrency of memory consolidation (REPAIR) around the
// canonical source: concurrent prepares, a canonical save racing the repair,
// and invalidation of the persisted snapshot once a repair is applied.
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildMemoryGraphSnapshot, calculateMemoryGraphSourceHash, createMemoryGraphSnapshotStore } from "@space/memory-graph";
import { InMemorySpaceStore } from "@space/runtime";
import {
  finalizeMemoryRepair,
  prepareMemoryConsolidation,
  refreshMemoryGraphSnapshot
} from "../src/memory-maintenance-activities.js";
import { executePersistedMemoryChangeSet } from "../src/memory-mutation-activity.js";

const env = {
  SPACE_MEMORY_GRAPH_ENABLED: "true",
  SPACE_MEMORY_MAINTENANCE_ENABLED: "true",
  SPACE_MEMORY_MUTATIONS_ENABLED: "true"
};

const monthlyContent = [
  "<!-- space-memory:id=memory:duplicate-a -->",
  "## 2026-07-13 05:00 EEST - Duplicate",
  "- Same exact body",
  "",
  "<!-- space-memory:id=memory:duplicate-b -->",
  "## 2026-07-13 05:00 EEST - Duplicate",
  "- Same exact body",
  "",
  "<!-- space-memory:id=memory:conflict-a -->",
  "## 2026-07-13 05:10 EEST - Conflict",
  "- conflicts_with=memory:duplicate-a",
  ""
].join("\n");

/** Every store call yields to the event loop first, the way a PostgreSQL
 * round trip does, so concurrent activities interleave between calls. */
function withRoundTrips<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await new Promise((resolve) => setImmediate(resolve));
        return value.apply(target, args);
      };
    }
  });
}

async function repairFixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `space-memory-lifecycle-${label}-`));
  const snapshotRoot = join(root, "snapshot");
  const indexPath = join(root, "gemini_history.md");
  const monthlyPath = join(root, "gemini_history_2026-07.md");
  const indexContent = "# Canonical memory\n";
  await writeFile(indexPath, indexContent, "utf8");
  await writeFile(monthlyPath, monthlyContent, "utf8");
  const sources = [
    { path: indexPath, kind: "INDEX" as const },
    { path: monthlyPath, kind: "MONTHLY" as const }
  ];
  const snapshot = buildMemoryGraphSnapshot({
    generatedAt: "2026-07-13T02:15:00.000Z",
    sources: [
      { path: indexPath, kind: "INDEX", content: indexContent },
      { path: monthlyPath, kind: "MONTHLY", content: monthlyContent }
    ]
  });
  await createMemoryGraphSnapshotStore({ rootDir: snapshotRoot }).write(snapshot);
  const memory = new InMemorySpaceStore();
  memory.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
  let runCounter = 0;
  const createRun = () => {
    runCounter += 1;
    return memory.createMemoryConsolidationRun({
      mode: "REPAIR",
      triggerKind: "OPERATOR",
      workflowId: `workflow:memory-lifecycle-${label}-${runCounter}`,
      dedupeKey: `operator:memory-lifecycle-${label}-${runCounter}`,
      actorUserId: "user:operator",
      sourceHash: null
    });
  };
  const coreOptions = { sources, journalRoot: join(root, "journals"), lockPath: join(root, "memory.lock") };
  const currentSourceHash = async () => calculateMemoryGraphSourceHash(await Promise.all(sources.map(async (source) => ({
    ...source,
    content: await readFile(source.path, "utf8")
  }))));
  return { root, snapshotRoot, indexPath, monthlyPath, sources, snapshot, memory, store: withRoundTrips(memory), createRun, coreOptions, currentSourceHash };
}

function operationsPerFinding(memory: InMemorySpaceStore, runId: string): number[] {
  const counts = new Map<string, number>();
  for (const operation of memory.listMemoryConsolidationOperations(runId)) {
    counts.set(operation.findingId ?? "none", (counts.get(operation.findingId ?? "none") ?? 0) + 1);
  }
  return [...counts.values()];
}

describe("memory consolidation lifecycle", () => {
  it.each([
    ["a queued run", false],
    ["a run an earlier attempt already marked RUNNING", true]
  ])("records one finding, one operation and one change set per issue when two prepares of %s race", async (_label, alreadyRunning) => {
    const fixture = await repairFixture(alreadyRunning ? "race-running" : "race-queued");
    const run = fixture.createRun();
    if (alreadyRunning) {
      // An attempt that crashed after claiming the run; a retry now overlaps a slow second attempt.
      fixture.memory.updateMemoryConsolidationRun(run.id, { status: "RUNNING", sourceHash: fixture.snapshot.sourceHash, progressCompleted: 0, progressTotal: 2 });
    }
    const input = { runId: run.id, traceId: "trace:memory-lifecycle-race" };
    const options = { env, rootDir: fixture.snapshotRoot, store: fixture.store, sources: fixture.sources };

    const attempts = await Promise.allSettled([
      prepareMemoryConsolidation(input, options),
      prepareMemoryConsolidation(input, options)
    ]);
    // A losing attempt may fail closed (an activity retry then reuses the
    // winner's state), but it must never create a second copy of anything.
    const prepared = attempts.flatMap((attempt) => attempt.status === "fulfilled" ? [attempt.value] : []);
    expect(prepared.length).toBeGreaterThan(0);
    const retried = await prepareMemoryConsolidation(input, options);
    expect(new Set([...prepared, retried].map((item) => item.changeSetId))).toEqual(new Set([retried.changeSetId]));
    expect(retried.changeSetId).toEqual(expect.any(String));

    const findings = fixture.memory.listMemoryConsolidationFindings(run.id);
    expect(findings.map((finding) => finding.findingType).sort()).toEqual(["CONFLICT", "EXACT_DUPLICATE"]);
    expect(operationsPerFinding(fixture.memory, run.id)).toEqual([1, 1]);

    const mutationResult = await executePersistedMemoryChangeSet(
      { changeSetId: retried.changeSetId!, traceId: "trace:memory-lifecycle-race-execute" },
      { env, store: fixture.store, coreOptions: fixture.coreOptions }
    );
    const [first, second] = await Promise.all([
      finalizeMemoryRepair({ runId: run.id, changeSetId: retried.changeSetId!, mutationResult }, { store: fixture.store }),
      finalizeMemoryRepair({ runId: run.id, changeSetId: retried.changeSetId!, mutationResult }, { store: fixture.store })
    ].map((promise) => promise.catch((error: unknown) => error)));
    const completed = [first, second].find((result) => !(result instanceof Error));
    expect(completed).toMatchObject({ status: "SUCCEEDED", findingCount: 2, appliedOperationCount: 1, skippedOperationCount: 1, failedOperationCount: 0 });
    expect(fixture.memory.getMemoryConsolidationRun(run.id)).toMatchObject({ status: "SUCCEEDED", appliedOperationCount: 1 });
    expect((await readFile(fixture.monthlyPath, "utf8")).match(/lifecycle_status=ARCHIVED/g)).toHaveLength(1);
  });

  it("fails the repair closed when a canonical save lands between prepare and execution", async () => {
    const fixture = await repairFixture("save-race");
    const run = fixture.createRun();
    const prepared = await prepareMemoryConsolidation(
      { runId: run.id, traceId: "trace:memory-lifecycle-save-race" },
      { env, rootDir: fixture.snapshotRoot, store: fixture.store, sources: fixture.sources }
    );
    expect(prepared.changeSetId).toEqual(expect.any(String));

    // memory-save appends a new durable record after the repair was planned.
    const saved = `${monthlyContent}\n<!-- space-memory:id=memory:saved-later -->\n## 2026-07-13 06:00 EEST - Saved later\n- new fact\n`;
    await writeFile(fixture.monthlyPath, saved, "utf8");

    const mutationResult = await executePersistedMemoryChangeSet(
      { changeSetId: prepared.changeSetId!, traceId: "trace:memory-lifecycle-save-race-execute" },
      { env, store: fixture.store, coreOptions: fixture.coreOptions }
    );
    expect(mutationResult).toMatchObject({ status: "FAILED", resultingSourceHash: null });
    expect(await readFile(fixture.monthlyPath, "utf8")).toBe(saved);
    expect(fixture.memory.getMemoryChangeSet(prepared.changeSetId!)).toMatchObject({ status: "FAILED" });
    expect(await readdir(fixture.coreOptions.journalRoot).catch(() => [])).toEqual([]);

    const finalized = await finalizeMemoryRepair(
      { runId: run.id, changeSetId: prepared.changeSetId!, mutationResult },
      { store: fixture.store }
    );
    expect(finalized).toMatchObject({ status: "FAILED", appliedOperationCount: 0, failedOperationCount: 1 });
    expect(fixture.memory.listMemoryConsolidationFindings(run.id).map((finding) => [finding.findingType, finding.status]).sort())
      .toEqual([["CONFLICT", "SKIPPED"], ["EXACT_DUPLICATE", "SKIPPED"]]);
  });

  it("invalidates the snapshot once a repair is applied, refuses stale plans and converges after a refresh", async () => {
    const fixture = await repairFixture("converge");
    const run = fixture.createRun();
    const options = { env, rootDir: fixture.snapshotRoot, store: fixture.store, sources: fixture.sources };
    const prepared = await prepareMemoryConsolidation({ runId: run.id, traceId: "trace:memory-lifecycle-converge" }, options);
    const mutationResult = await executePersistedMemoryChangeSet(
      { changeSetId: prepared.changeSetId!, traceId: "trace:memory-lifecycle-converge-execute" },
      { env, store: fixture.store, coreOptions: fixture.coreOptions }
    );
    expect(mutationResult.status).toBe("APPLIED");
    await finalizeMemoryRepair({ runId: run.id, changeSetId: prepared.changeSetId!, mutationResult }, { store: fixture.store });

    // The persisted snapshot now describes the pre-repair source.
    const persisted = await createMemoryGraphSnapshotStore({ rootDir: fixture.snapshotRoot }).read();
    expect(persisted?.sourceHash).toBe(fixture.snapshot.sourceHash);
    expect(await fixture.currentSourceHash()).toBe(mutationResult.resultingSourceHash);
    expect(mutationResult.resultingSourceHash).not.toBe(fixture.snapshot.sourceHash);

    // A new plan against the stale snapshot is refused instead of repairing twice.
    const staleRun = fixture.createRun();
    await expect(prepareMemoryConsolidation({ runId: staleRun.id, traceId: "trace:memory-lifecycle-stale" }, options))
      .rejects.toThrow(/changed after the persisted snapshot/);

    const refreshed = await refreshMemoryGraphSnapshot(
      { scheduledAt: "2026-07-13T03:00:00.000Z", traceId: "trace:memory-lifecycle-refresh" },
      { env: {}, rootDir: fixture.snapshotRoot, indexPath: fixture.indexPath, monthlyPath: fixture.monthlyPath, now: () => new Date("2026-07-13T03:00:01.000Z") }
    );
    expect(refreshed).toMatchObject({ status: "REFRESHED", sourceHash: mutationResult.resultingSourceHash, previousSourceHash: fixture.snapshot.sourceHash });
    const rebuilt = await createMemoryGraphSnapshotStore({ rootDir: fixture.snapshotRoot }).read();
    expect(rebuilt?.issues.map((issue) => issue.type)).not.toContain("EXACT_DUPLICATE");

    const nextRun = fixture.createRun();
    const next = await prepareMemoryConsolidation({ runId: nextRun.id, traceId: "trace:memory-lifecycle-next" }, options);
    expect(next.changeSetId).toBeNull();
    expect(fixture.memory.getMemoryConsolidationRun(nextRun.id)).toMatchObject({ status: "SUCCEEDED", appliedOperationCount: 0 });
    expect((await readFile(fixture.monthlyPath, "utf8")).match(/lifecycle_status=ARCHIVED/g)).toHaveLength(1);
  });
});
