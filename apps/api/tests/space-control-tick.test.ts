import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryControlRepository, PostgresControlRepository, type ControlRepository } from "@space/db";
import { controlExecuteSchema } from "@space/contracts";
import { createSpaceControl } from "../src/space-control.js";

const actor = { id: "operator:one", role: "ADMIN" as const };

function fixture(repository: ControlRepository = new InMemoryControlRepository()) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Control tick", initialPaneCount: 0, kind: "AGENT_PROOF" });
  const [pane] = store.createPanes([{ roomId: room.id, title: "A", mode: "TERMINAL" as const, terminalRuntimeId: "cli:codex" }]);
  const observation = {
    paneId: pane!.id, title: "A", runtimeId: "cli:codex", sessionId: "session:one", state: "IDLE" as const,
    nativeTaskRef: "native:one", modelId: "test", nativeMode: "default", checkedAt: new Date().toISOString(), tasks: []
  };
  const controller = {
    catalog: vi.fn(async () => ({ types: [], unavailable: [] })), inspect: vi.fn(async () => observation),
    configure: vi.fn(async () => ({})), command: vi.fn(async () => ({})), start: vi.fn(async () => ({})),
    resume: vi.fn(async () => ({})), interrupt: vi.fn(async () => ({}))
  };
  const send = vi.fn(async () => ({ submitted: true }));
  const service = createSpaceControl({
    store, repository, controller, send, publish: vi.fn(async () => {}),
    resolveActor: async () => actor, checkQuota: async () => ({ allowed: true, reason: "available" })
  });
  const command = controlExecuteSchema.parse({
    roomId: room.id, requestId: "scheduled", actions: [{ kind: "pane", operation: "continue", target: { paneIds: [pane!.id] } }]
  });
  return { store, repository, service, room, pane: pane!, send, command };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Space control tick", () => {
  it("lists only active watch, schedule and operation records and ignores settled history", async () => {
    const repository = new InMemoryControlRepository();
    const c = fixture(repository);
    // Settled records, one of them no longer schema-valid: the old tick parsed
    // every listed record and aborted on it before reaching active work.
    await repository.write({ kind: "watch", actorId: actor.id, key: "settled", roomId: c.room.id, version: 1,
      value: { id: "settled", status: "VERIFIED", legacyField: true } }, 0);
    await repository.write({ kind: "operation", actorId: actor.id, key: "done", roomId: c.room.id, version: 1,
      value: { id: "done", status: "COMPLETED" } }, 0);
    const scheduled = await c.service.schedules(actor, c.room.id, "create", undefined, new Date(Date.now() + 1000).toISOString(), c.command) as { id: string };
    const saved = (await repository.get("schedule", actor.id, scheduled.id))!;
    await repository.write({ ...saved, value: { ...(saved.value as object), dueAt: new Date(Date.now() - 100).toISOString() } }, saved.version);
    const listActive = vi.spyOn(repository, "listActive");
    const list = vi.spyOn(repository, "list");

    await c.service.tick();

    expect(listActive.mock.calls).toEqual([
      ["watch", ["PENDING", "RUNNING", "VERIFYING"]],
      ["schedule", ["SCHEDULED", "RUNNING"]],
      ["operation", ["RUNNING"]]
    ]);
    expect(list.mock.calls.filter(([kind, actorId]) => actorId === null && kind !== "audit")).toEqual([]);
    // The due schedule was still advanced (and executed its continuation).
    expect(c.send).toHaveBeenCalledOnce();
    expect((await c.service.schedules(actor, c.room.id, "list") as Array<{ status: string }>)[0]!.status).toBe("COMPLETED");
  });

  it("falls back to the full listing for repositories without listActive", async () => {
    const inner = new InMemoryControlRepository();
    const legacy: ControlRepository = {
      get: (kind, actorId, key) => inner.get(kind, actorId, key),
      list: vi.fn((kind, actorId, roomId) => inner.list(kind, actorId, roomId)),
      write: (record, expectedVersion) => inner.write(record, expectedVersion),
      withLock: (key, work, timeoutMs) => inner.withLock(key, work, timeoutMs),
      dispose: () => inner.dispose()
    };
    const c = fixture(legacy);
    const scheduled = await c.service.schedules(actor, c.room.id, "create", undefined, new Date(Date.now() + 1000).toISOString(), c.command) as { id: string };
    const saved = (await inner.get("schedule", actor.id, scheduled.id))!;
    await inner.write({ ...saved, value: { ...(saved.value as object), dueAt: new Date(Date.now() - 100).toISOString() } }, saved.version);

    await c.service.tick();

    expect(legacy.list).toHaveBeenCalledWith("schedule", null);
    expect(c.send).toHaveBeenCalledOnce();
  });

  it("idles the 1 s timer without work and wakes on the next second after a work write", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const repository = new InMemoryControlRepository();
    const listActive = vi.spyOn(repository, "listActive");
    const c = fixture(repository);
    await c.service.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(listActive).toHaveBeenCalledTimes(3);
    // Nothing active and nothing written: the timer skips the listings.
    await vi.advanceTimersByTimeAsync(5000);
    expect(listActive).toHaveBeenCalledTimes(3);

    // Creating a schedule (a work write) wakes the loop within one tick, and an
    // active record keeps it polling every second (due times need no write).
    const scheduled = await c.service.schedules(actor, c.room.id, "create", undefined, new Date(Date.now() + 3_600_000).toISOString(), c.command) as { id: string };
    await vi.advanceTimersByTimeAsync(1000);
    expect(listActive).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(2000);
    expect(listActive).toHaveBeenCalledTimes(12);

    // Cancelling settles the last active record; the loop goes idle again but
    // still rechecks every 10 s as a safety net.
    await c.service.schedules(actor, c.room.id, "cancel", scheduled.id);
    await vi.advanceTimersByTimeAsync(2000);
    const settled = listActive.mock.calls.length;
    await vi.advanceTimersByTimeAsync(8000);
    expect(listActive).toHaveBeenCalledTimes(settled);
    await vi.advanceTimersByTimeAsync(2000);
    expect(listActive).toHaveBeenCalledTimes(settled + 3);

    // A direct tick() is never skipped.
    await c.service.tick();
    expect(listActive).toHaveBeenCalledTimes(settled + 6);
    await c.service.close();
  }, 30_000);

  it("filters by JSON status in SQL and selects only the mapped columns", async () => {
    const query = vi.fn(async (_sql: string, _values: unknown[]) => ({ rows: [{ kind: "watch", actor_id: "a", record_key: "k", room_id: "r", version: 2, value: { status: "RUNNING" }, dot_id: null }] }));
    const repository = new PostgresControlRepository({ query } as never);

    await expect(repository.listActive("watch", ["PENDING", "RUNNING"])).resolves.toEqual([
      { kind: "watch", actorId: "a", key: "k", roomId: "r", version: 2, value: { status: "RUNNING" } }
    ]);
    expect(query).toHaveBeenCalledWith(
      "SELECT kind,actor_id,record_key,room_id,version,value,dot_id FROM space_control_records WHERE kind=$1 AND value->>'status'=ANY($2::text[]) ORDER BY updated_at DESC LIMIT 1000",
      ["watch", ["PENDING", "RUNNING"]]
    );
  });
});
