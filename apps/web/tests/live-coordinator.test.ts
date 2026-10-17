import { createLiveHistorySync } from "../src/features/live-pane/live-history-sync.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveCoordinator } from "../src/features/live-pane/live-coordinator.js";
import { getLiveSessionStats } from "../src/features/live-pane/live-stats.js";
import { noteLiveUserTurn } from "../src/features/live-pane/live-command-origin.js";
import type { LiveSessionCallbacks, LiveSessionHandle, LiveSessionOptions } from "../src/features/live-pane/live-session.js";
import type { LiveRoomContext } from "@space/contracts";
const context = (roomId: string, revision = roomId): LiveRoomContext => ({ roomId, name: roomId, description: null, objective: null, panes: [], revision, checkedAt: "2026-09-26" });
const handle = (): LiveSessionHandle => ({ close: vi.fn(), setMuted: vi.fn(), isMuted: () => false, sendTextMessage: vi.fn(), updateContext: vi.fn() });
const owned: Array<ReturnType<typeof createLiveCoordinator>> = [];
function fixture(overrides: Partial<Parameters<typeof createLiveCoordinator>[0]> = {}) {
  let callbacks!: LiveSessionCallbacks, options!: LiveSessionOptions;
  const transport = handle();
  const open = vi.fn(async (opts: LiveSessionOptions, cb: LiveSessionCallbacks) => { options = opts; callbacks = cb; cb.onStatusChange?.("active"); return transport; });
  const coordinator = createLiveCoordinator({ open, context: async id => context(id), config: () => ({ model: "gpt-live-1" }), ...overrides });
  coordinator.setOwner("user:one"); coordinator.setRoom("room:a"); owned.push(coordinator);
  return { coordinator, transport, open, callbacks: () => callbacks, options: () => options };
}
afterEach(() => { for (const item of owned.splice(0)) item.dispose(); vi.useRealTimers(); });
describe("application Live coordinator", () => {
  it("keeps queued commands while the user keeps talking, and drops them after a refusal, navigation away and back, or stop", async () => {
    const f = fixture(); await f.coordinator.start();
    f.callbacks().onInputStart?.();
    const first = f.options().captureCommandRoom!();
    expect(first()).toBe("room:a");
    // "Can you hear me?" in the same room keeps the command (operator review 2026-10-15).
    f.callbacks().onInputEnd?.(); noteLiveUserTurn(); f.callbacks().onInputStart?.();
    f.callbacks().onTranscriptUpdate?.({ id: "hear", role: "user", text: "Can you hear me?", timestamp: "" });
    expect(first()).toBe("room:a");
    // A later "no, wait" drops it.
    f.callbacks().onInputEnd?.(); noteLiveUserTurn(); f.callbacks().onInputStart?.();
    f.callbacks().onTranscriptUpdate?.({ id: "wait", role: "user", text: "Όχι, περίμενε", timestamp: "" });
    expect(first()).toBeUndefined();
    const second = f.options().captureCommandRoom!();
    f.coordinator.setRoom("room:b"); await f.coordinator.refreshContext();
    f.coordinator.setRoom("room:a"); await f.coordinator.refreshContext();
    expect(second()).toBeUndefined();
    f.coordinator.send([{ type: "text", text: "Read this room" }]);
    const typed = f.options().captureCommandRoom!(); expect(typed()).toBe("room:a");
    f.coordinator.send([{ type: "text", text: "Read it again" }]); expect(typed()).toBe("room:a");
    const stopped = f.options().captureCommandRoom!(); f.coordinator.stop(); expect(stopped()).toBeUndefined();
  });
  it("switches rooms without reacquiring audio and blocks an utterance crossing rooms", async () => {
    const f = fixture(); await f.coordinator.start();
    f.callbacks().onInputStart?.(); expect(f.options().getCommandRoom?.()).toBe("room:a");
    f.coordinator.setRoom("room:b"); expect(f.options().getCommandRoom?.()).toBeUndefined();
    await f.coordinator.refreshContext();
    expect(f.transport.close).not.toHaveBeenCalled(); expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.transport.updateContext).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room:b" }));
    expect(f.options().getCommandRoom?.()).toBeUndefined();
    f.callbacks().onTranscriptUpdate?.({ id: "a", role: "assistant", text: "Previous room response", timestamp: "" });
    expect(f.coordinator.getSnapshot().transcripts[0]?.roomId).toBe("room:a");
    f.callbacks().onInputEnd?.(); f.callbacks().onInputStart?.(); expect(f.options().getCommandRoom?.()).toBe("room:b");
  });
  it("closes a late microphone grant after stop but retains it after a room switch", async () => {
    let resolve!: (h: LiveSessionHandle) => void;
    const f = fixture({ open: () => new Promise(r => { resolve = r; }) });
    const start = f.coordinator.start(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    f.coordinator.setRoom("room:b"); const h = handle(); resolve(h); await start;
    expect(h.close).not.toHaveBeenCalled();
    f.coordinator.stop(); expect(h.close).toHaveBeenCalledTimes(1);
    resolve = undefined as any; const next = f.coordinator.start(); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    f.coordinator.stop(); const late = handle(); resolve(late); await next; expect(late.close).toHaveBeenCalledTimes(1);
  });
  it("disconnects instead of reconnecting when the provider rejected the session configuration", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.coordinator.start();
    f.callbacks().onError?.("Responses configuration validation failed.", { retryable: false });
    f.callbacks().onStatusChange?.("error");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.transport.close).toHaveBeenCalledTimes(1);
    expect(f.coordinator.getSnapshot()).toMatchObject({ enabled: false, status: "error", error: "Responses configuration validation failed." });
    f.coordinator.toggle(); await vi.advanceTimersByTimeAsync(0);
    expect(f.open).toHaveBeenCalledTimes(2);
  });
  it("ignores stale room context responses", async () => {
    let resolve!: (c: LiveRoomContext) => void;
    const f = fixture({ context: id => id === "room:a" ? new Promise(r => { resolve = r; }) : Promise.resolve(context(id)) });
    const pending = f.coordinator.start(); f.coordinator.setRoom("room:b"); await f.coordinator.refreshContext();
    resolve(context("room:a")); await pending;
    expect(f.coordinator.getSnapshot().context?.roomId).toBe("room:b");
  });
  it("coalesces event bursts and performs a trailing refresh during an in-flight read", async () => {
    vi.useFakeTimers(); let resolve!: (c: LiveRoomContext) => void;
    const read = vi.fn(async id => context(id)); const f = fixture({ context: read }); await f.coordinator.start();
    read.mockImplementationOnce(id => new Promise(r => { resolve = r; }));
    for (let i = 0; i < 20; i++) f.coordinator.invalidate("room:a");
    await vi.advanceTimersByTimeAsync(250); f.coordinator.invalidate("room:a");
    resolve(context("room:a", "changed")); await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("restores enabled/mute across refresh, isolates owners and preserves repeated phrases", async () => {
    const records = new Map<string, string>(); const storage = { getItem: (k: string) => records.get(k) ?? null, setItem: (k: string, v: string) => { records.set(k, v); } };
    const f = fixture({ storage }); await f.coordinator.start(); f.coordinator.setMuted(true);
    f.callbacks().onInputStart?.();
    for (const id of ["one", "two"]) f.callbacks().onTranscriptUpdate?.({ id, role: "user", text: "ναι", timestamp: "" });
    f.coordinator.dispose(); const next = fixture({ storage }); await next.coordinator.start();
    expect(next.coordinator.getSnapshot()).toMatchObject({ enabled: true, muted: true });
    expect(next.coordinator.getSnapshot().transcripts).toHaveLength(2); expect(next.transport.setMuted).toHaveBeenCalledWith(true);
    next.coordinator.setOwner("user:two"); expect(next.coordinator.getSnapshot().transcripts).toHaveLength(0);
    expect(next.coordinator.getSnapshot().enabled).toBe(false);
  });
  it("uses provider resumption, retaining its callback generation and suppressing stale callbacks after stop", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.coordinator.start(); const next = handle(); const resume = vi.fn(async () => next);
    f.callbacks().onReconnect?.(resume); await vi.advanceTimersByTimeAsync(500);
    expect(resume).toHaveBeenCalledTimes(1); expect(f.open).toHaveBeenCalledTimes(1);
    f.callbacks().onStatusChange?.("listening"); expect(f.coordinator.getSnapshot().status).toBe("listening");
    f.coordinator.stop(); f.callbacks().onStatusChange?.("active"); expect(f.coordinator.getSnapshot().status).toBe("idle");
  });
  it("releases microphone ownership after cancellation while acquisition is pending", async () => {
    let grant!: (release: () => void) => void;
    const acquireMicrophone = vi.fn(() => new Promise<() => void>(resolve => { grant = resolve; }));
    const f = fixture({ acquireMicrophone }); const start = f.coordinator.start();
    await vi.waitFor(() => expect(acquireMicrophone).toHaveBeenCalledTimes(1));
    f.coordinator.stop(); const release = vi.fn(); grant(release); await start;
    expect(release).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled();
  });
  it("persists cross-room notifications before ack, retries failed ack once visually and waits for speech", async () => {
    vi.useFakeTimers(); const saved: any[] = [];
    const history = createLiveHistorySync({ load: async () => ({ items: [], epochs: {} }), save: async turns => { saved.push(...turns); return { receipts: turns.map(turn => ({ id: turn.item.id, sessionId: turn.item.sessionId, accepted: true })) }; }, clear: async () => ({ ok: true, epoch: 1 }) });
    const list = vi.fn(async () => [{ id: "watch:one", roomId: "room:origin", paneId: "pane:worker", status: "VERIFIED", reason: null }] as any);
    const ack = vi.fn(async () => { expect(saved).toHaveLength(1); }).mockRejectedValueOnce(new Error("offline"));
    const f = fixture({ history, notifications: { list, ack, visible: () => true } }); await f.coordinator.start();
    f.callbacks().onInputStart?.(); await vi.advanceTimersByTimeAsync(2000); expect(list).not.toHaveBeenCalled();
    f.callbacks().onInputEnd?.(); await vi.advanceTimersByTimeAsync(2000); expect(ack).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000); expect(ack).toHaveBeenCalledTimes(2); expect(saved).toHaveLength(1);
    expect(f.coordinator.getSnapshot().transcripts).toMatchObject([{ id: "watch:watch:one", roomId: "room:origin" }]);
  });
  it("opens the session without waiting for the room context, then hands it over, and records connect and reply latency", async () => {
    let resolveContext!: (value: LiveRoomContext) => void;
    const f = fixture({ context: () => new Promise(resolve => { resolveContext = resolve; }) });
    await f.coordinator.start();
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.options().roomContext).toBeUndefined();
    expect(getLiveSessionStats().connectMs).toBeGreaterThanOrEqual(0);
    resolveContext(context("room:a")); await f.coordinator.refreshContext();
    expect(f.transport.updateContext).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room:a" }));
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    f.callbacks().onInputEnd?.();
    vi.setSystemTime(10_420);
    f.callbacks().onStatusChange?.("speaking");
    expect(getLiveSessionStats().lastReplyMs).toBe(420);
  });
  it("acknowledges a watch cancelled by its pane closing without showing or speaking it, and still speaks a finished task", async () => {
    vi.useFakeTimers();
    const history = createLiveHistorySync({ load: async () => ({ items: [], epochs: {} }), save: async turns => ({ receipts: turns.map(turn => ({ id: turn.item.id, sessionId: turn.item.sessionId, accepted: true })) }), clear: async () => ({ ok: true, epoch: 1 }) });
    const acked = new Set<string>();
    const watches = [
      { id: "closed", roomId: "room:a", paneId: "pane:bob", status: "CANCELLED", reason: "Target pane was closed." },
      { id: "done", roomId: "room:a", paneId: "pane:andy", status: "VERIFIED", reason: null }
    ];
    const list = vi.fn(async () => watches.filter(watch => !acked.has(watch.id)) as any);
    const ack = vi.fn(async (_roomId: string, id: string) => { acked.add(id); });
    const f = fixture({ history, notifications: { list, ack, visible: () => true } });
    const notify = vi.fn(); (f.transport as any).notify = notify;
    await f.coordinator.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(ack).toHaveBeenCalledWith("room:a", "closed");
    // A cancelled watch is acknowledged only: no conversation entry (agents' test rooms raised dozens of them).
    expect(f.coordinator.getSnapshot().transcripts.map(item => item.id)).toEqual(["watch:done"]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Task completed"), "watch:done");
  });
  it("speaks the Room Agent's questions once, after watches, and marks them announced", async () => {
    vi.useFakeTimers(); const saved: any[] = [];
    const history = createLiveHistorySync({ load: async () => ({ items: [], epochs: {} }), save: async turns => { saved.push(...turns); return { receipts: turns.map(turn => ({ id: turn.item.id, sessionId: turn.item.sessionId, accepted: true })) }; }, clear: async () => ({ ok: true, epoch: 1 }) });
    const announced = new Set<string>();
    const announcements = {
      list: vi.fn(async () => [{ id: "room_agent_event:ask", roomId: "room:origin", roomName: "Alex", text: "Room Agent: Dana is waiting: Permission prompt." }].filter(item => !announced.has(item.id))),
      ack: vi.fn((id: string) => { announced.add(id); })
    };
    const f = fixture({ history, notifications: { list: vi.fn(async () => []), ack: vi.fn(async () => undefined), visible: () => true }, announcements });
    await f.coordinator.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(announcements.ack).toHaveBeenCalledWith("room_agent_event:ask");
    expect(f.coordinator.getSnapshot().transcripts).toMatchObject([{ id: "room-agent:room_agent_event:ask", roomName: "Alex", text: "Room Agent: Dana is waiting: Permission prompt." }]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.coordinator.getSnapshot().transcripts).toHaveLength(1);
    expect(saved).toHaveLength(1);
  });
  it("supports StrictMode effect replay without losing restored enabled state", async () => {
    const f = fixture(); await f.coordinator.start(); f.coordinator.dispose(); f.coordinator.activate(); f.coordinator.setRoom("room:a");
    await f.coordinator.start(); await Promise.resolve();
    expect(f.open).toHaveBeenCalledTimes(2);
  });
});
