import { describe, expect, it } from "vitest";
import { InMemorySpaceStore } from "../src/store.js";
import type { SetupExecutionState } from "@space/contracts";

const initial: SetupExecutionState = {
  ownerId: "user:owner", revision: 0, draft: null, plans: [], runs: [], tasks: [],
  receipts: [], events: [], runIdempotency: []
};

describe("in-memory first-setup state", () => {
  it("creates once and uses revision CAS to reject stale tabs", async () => {
    const store = new InMemorySpaceStore();
    expect(await store.getSetupExecutionState(initial.ownerId)).toBeNull();
    expect(await store.compareAndSwapSetupExecutionState(initial.ownerId, null, initial)).toBe(true);
    expect(await store.compareAndSwapSetupExecutionState(initial.ownerId, null, initial)).toBe(false);
    const next = { ...initial, revision: 1 };
    expect(await store.compareAndSwapSetupExecutionState(initial.ownerId, 0, next)).toBe(true);
    expect(await store.compareAndSwapSetupExecutionState(initial.ownerId, 0, next)).toBe(false);
    expect((await store.getSetupExecutionState(initial.ownerId))?.revision).toBe(1);
  });

  it("returns independent snapshots and rejects wrong owner or revision jumps", async () => {
    const store = new InMemorySpaceStore();
    await store.compareAndSwapSetupExecutionState(initial.ownerId, null, initial);
    const read = await store.getSetupExecutionState(initial.ownerId);
    read!.revision = 99;
    expect((await store.getSetupExecutionState(initial.ownerId))?.revision).toBe(0);
    expect(() => store.compareAndSwapSetupExecutionState("user:other", null, initial)).toThrow();
    expect(() => store.compareAndSwapSetupExecutionState(initial.ownerId, 0, { ...initial, revision: 3 })).toThrow();
  });
});
