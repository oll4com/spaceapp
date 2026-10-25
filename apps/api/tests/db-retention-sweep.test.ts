import { describe, expect, it, vi } from "vitest";
import { runDatabaseRetentionSweep } from "../src/app.js";

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

    expect(result).toEqual({ deletedChunks: 15, batches: 1 });
    expect(mockStore.pruneClosedPanes).not.toHaveBeenCalled();
  });
});
