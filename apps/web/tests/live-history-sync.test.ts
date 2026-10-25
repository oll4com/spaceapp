import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveHistorySync } from "../src/features/live-pane/live-history-sync.js";
const turn = { id: "one", role: "user" as const, roomId: "room:a", text: "ναι", timestamp: "", createdAtMs: 1 };
const owned: Array<ReturnType<typeof createLiveHistorySync>> = [];
afterEach(() => { for (const item of owned.splice(0)) item.dispose(); vi.useRealTimers(); });
function fixture(overrides: Partial<Parameters<typeof createLiveHistorySync>[0]> = {}) {
  const saved: any[] = [];
  const save = vi.fn(async (turns: any[]) => { saved.push(...turns); return { receipts: turns.map(turn => ({ id: turn.item.id, sessionId: turn.item.sessionId, accepted: true })) }; });
  const sync = createLiveHistorySync({ load: async () => ({ items: [], epochs: {} }), save, clear: async () => ({ ok: true, epoch: 1 }), ...overrides }); owned.push(sync); return { sync, save, saved };
}
describe("Live history outbox", () => {
  it("coalesces streaming deltas and retries stable turn identities", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.sync.setOwner("owner:a");
    f.sync.enqueue(turn); f.sync.enqueue({ ...turn, text: "ναι πάλι" }); await vi.advanceTimersByTimeAsync(751);
    expect(f.save).toHaveBeenCalledTimes(1); expect(f.saved[0].item).toMatchObject({ id: "one", revision: 2, text: "ναι πάλι" });
  });
  it("restores an offline outbox after refresh and rejects entries from a cleared epoch", async () => {
    const records = new Map(); const storage = { getItem: (key: string) => records.get(key), setItem: (key: string, value: string) => records.set(key, value) };
    const f = fixture({ storage }); await f.sync.setOwner("owner:a"); f.sync.enqueue(turn); f.sync.dispose();
    const restored = fixture({ storage }); expect(await restored.sync.setOwner("owner:a")).toHaveLength(1); restored.sync.dispose();
    const cleared = fixture({ storage, load: async () => ({ items: [], epochs: { "room:a": 1 } }) }); expect(await cleared.sync.setOwner("owner:a")).toEqual([]);
    await cleared.sync.flush(); expect(cleared.save).not.toHaveBeenCalled();
  });
  it("fences late deltas after clear while allowing a new turn", async () => {
    const f = fixture(); await f.sync.setOwner("owner:a"); f.sync.enqueue(turn); await f.sync.clearRoom("room:a", ["one"]);
    f.sync.enqueue({ ...turn, text: "late" }); f.sync.enqueue({ ...turn, id: "two" }); await f.sync.flush();
    expect(f.saved).toHaveLength(1); expect(f.saved[0]).toMatchObject({ epoch: 1, item: { id: "two" } });
  });
  it("retains queued data when save fails and never merges a previous owner's pending load", async () => {
    let resolve!: (value: any) => void; const f = fixture({ load: () => new Promise(r => { resolve = r; }) });
    const a = f.sync.setOwner("owner:a"); const first = resolve; const b = f.sync.setOwner("owner:b");
    first({ items: [turn], epochs: {} }); resolve({ items: [], epochs: {} }); expect(await a).toEqual([]); expect(await b).toEqual([]);
    const fail = fixture({ save: async () => { throw new Error("offline"); } }); await fail.sync.setOwner("owner:a"); fail.sync.enqueue(turn); await fail.sync.flush();
  });
  it("does not present a notification cleared while its save was in flight", async () => {
    let resolve!: (result: any) => void;
    const f = fixture({ save: () => new Promise(done => { resolve = done; }) });
    await f.sync.setOwner("owner:a");
    const pending = f.sync.persistNotification(turn);
    await f.sync.clearRoom("room:a", [turn.id]);
    resolve({ receipts: [{ id: turn.id, sessionId: "live-notifications", accepted: true }] });
    expect(await pending).toBe(false);
    expect(await f.sync.persistNotification(turn)).toBe(false);
  });
});
