import { describe, expect, it, vi } from "vitest";
import { runDatabaseRetentionSweep } from "../src/app.js";
import { createRetentionSweeps } from "../src/retention-sweeps.js";

describe("Database Retention Sweep", () => {
  it("iterates in bounded batches until fewer than batchLimit are pruned", async () => {
    let callCount = 0;
    const mockStore: any = {
      pruneExpiredCliTranscriptChunks: vi.fn(async ({ olderThanDays, batchSize }) => {
        callCount++;
        if (callCount === 1) return { deletedChunks: 500 };
        if (callCount === 2) return { deletedChunks: 500 };
        return { deletedChunks: 120 };
      })
    };

    const result = await runDatabaseRetentionSweep({
      store: mockStore,
      olderThanDays: 7,
      batchLimit: 500,
      maxBatches: 10
    });

    expect(result.deletedChunks).toBe(1120);
    expect(result.batches).toBe(3);
    expect(mockStore.pruneExpiredCliTranscriptChunks).toHaveBeenCalledTimes(3);
    expect(mockStore.pruneExpiredCliTranscriptChunks).toHaveBeenCalledWith({
      olderThanDays: 7,
      batchSize: 500
    });
  });

  it("respects maxBatches bound to prevent runaway sweeps", async () => {
    const mockStore: any = {
      pruneExpiredCliTranscriptChunks: vi.fn(async () => ({ deletedChunks: 500 }))
    };

    const result = await runDatabaseRetentionSweep({
      store: mockStore,
      olderThanDays: 7,
      batchLimit: 500,
      maxBatches: 4
    });

    expect(result.deletedChunks).toBe(2000);
    expect(result.batches).toBe(4);
    expect(mockStore.pruneExpiredCliTranscriptChunks).toHaveBeenCalledTimes(4);
  });

  it("never deletes closed panes: they go only by an explicit prune or with their room (Record Retention Invariant)", async () => {
    const mockStore: any = {
      pruneExpiredCliTranscriptChunks: vi.fn(async () => ({ deletedChunks: 15 })),
      pruneClosedPanes: vi.fn(async () => ({ deletedPanes: 25 }))
    };

    const result = await runDatabaseRetentionSweep({ store: mockStore, olderThanDays: 7, batchLimit: 500, maxBatches: 5 });

    expect(result).toEqual({ deletedChunks: 15, batches: 1, stoppedCopilotRuns: [] });
    expect(mockStore.pruneClosedPanes).not.toHaveBeenCalled();
  });

  it("skips a sweep while its previous run is going, honours the DB sweep switch and logs failures", async () => {
    let finish!: (value: { deletedChunks: number }) => void;
    const store: any = { pruneExpiredCliTranscriptChunks: vi.fn(() => new Promise((resolve) => { finish = resolve; })) };
    const log = { info: vi.fn(), error: vi.fn() };
    const appDiagnosticsService: any = { sweepExpired: vi.fn(async () => { throw new Error("boom"); }) };
    const sweeps = (enableDbSweep: boolean) =>
      createRetentionSweeps({ log } as any, { config: { enableDbSweep } as any, store, appDiagnosticsService });

    await sweeps(false).executeDatabaseRetentionSweep();
    expect(store.pruneExpiredCliTranscriptChunks).not.toHaveBeenCalled();

    const { executeDatabaseRetentionSweep, runAppDiagnosticsRetentionSweep } = sweeps(true);
    const first = executeDatabaseRetentionSweep();
    await executeDatabaseRetentionSweep();
    finish({ deletedChunks: 3 });
    await first;
    expect(store.pruneExpiredCliTranscriptChunks).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ deletedChunks: 3, batches: 1 }, "Database retention sweep completed.");

    await runAppDiagnosticsRetentionSweep();
    expect(log.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "App diagnostics retention sweep failed.");
  });

  it("stops the copilot runs whose pane is gone (DATA-001) and reports them; a store without it reports none", async () => {
    const stopped = [{ table: "job_apply_runs", id: "jobrun:5AUgZFutZ5wZ" }];
    const store = { pruneExpiredCliTranscriptChunks: vi.fn(async () => ({ deletedChunks: 0 })), stopOrphanedCopilotRuns: vi.fn(async () => ({ stopped })) };
    expect((await runDatabaseRetentionSweep({ store: store as never })).stoppedCopilotRuns).toEqual(stopped);
    expect(store.stopOrphanedCopilotRuns).toHaveBeenCalledTimes(1);
    expect((await runDatabaseRetentionSweep({ store: { pruneExpiredCliTranscriptChunks: vi.fn(async () => ({ deletedChunks: 0 })) } as never })).stoppedCopilotRuns).toEqual([]);
  });
});
