import { describe, expect, it, vi } from "vitest";
import { createGatewayRealtimeController } from "../src/features/live-pane/gateway-realtime.js";

function harness(execute = vi.fn(async () => '{"status":"COMPLETED"}')) {
  const sent: any[] = [];
  const callbacks = { onReady: vi.fn(), onAudio: vi.fn(), onInterrupt: vi.fn(), onTranscript: vi.fn(), onError: vi.fn() };
  const controller = createGatewayRealtimeController({ model: "openai/gpt-realtime-mini", config: {
    instructions: "Language: el", tools: [{ type: "function", name: "space_inspect", parameters: { type: "object" } }]
  }, captureCommandRoom: () => () => "room:one", send: (data) => sent.push(JSON.parse(data)), execute, ...callbacks });
  return { ...controller, ...callbacks, sent, execute };
}
const ready = (h: ReturnType<typeof harness>) => h.receive({ type: "session-updated" });
const call = (id: string) => ({ type: "function-call-arguments-done", callId: id, name: "space_inspect", arguments: "{}", responseId: "r1" });
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };

describe("Gateway normalized Realtime protocol", () => {
  it("sends normalized setup and gates microphone/text/tools on acknowledgement", () => {
    const h = harness();
    h.start(); h.sendAudio("pcm"); h.receive(call("c1")); h.receive({ type: "session-created" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ type: "session-update", config: { instructions: "Language: el" } });
    expect(h.onReady).not.toHaveBeenCalled();
    expect(() => h.sendText("hello")).toThrow("not ready");
    ready(h); ready(h); h.sendAudio("pcm");
    expect(h.onReady).toHaveBeenCalledTimes(1);
    expect(h.sent[1]).toEqual({ type: "input-audio-append", audio: "pcm" });
    expect(h.execute).not.toHaveBeenCalled();
  });
  it("deduplicates and serializes a 20-tool batch, then resumes once after the response ends", async () => {
    const h = harness(); ready(h);
    h.receive({ type: "speech-started" });
    h.receive({ type: "response-created", responseId: "r1" });
    for (let i = 0; i < 20; i++) { h.receive(call(`c${i}`)); h.receive(call(`c${i}`)); }
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(20));
    await vi.waitFor(() => expect(h.sent).toHaveLength(40));
    expect(h.execute).toHaveBeenNthCalledWith(1, "space_inspect", "{}", "c0", expect.any(Function));
    // Every duplicate receives its cached result while each side effect runs once.
    expect(h.sent).toHaveLength(40);
    expect(h.sent[0]).toMatchObject({ type: "conversation-item-create", item: { type: "function-call-output", callId: "c0", name: "space_inspect" } });
    h.receive({ type: "response-done", responseId: "r1", status: "completed" });
    expect(h.sent.filter(event => event.type === "response-create")).toHaveLength(1);
  });
  it("does not execute queued side effects after closing or retry a failed call", async () => {
    const h = harness(vi.fn(async () => { throw new Error("execution failed"); })); ready(h);
    h.receive(call("c1")); h.receive(call("c2")); await flush();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledTimes(1);
    h.receive(call("c1")); await flush();
    expect(h.execute).toHaveBeenCalledTimes(1);
    const other = harness(); ready(other); other.receive(call("c1")); other.close(); await flush();
    expect(other.execute).not.toHaveBeenCalled();
  });
  it("keeps queued tool guards across a newer input in the same room and drops them on a room change", async () => {
    const guards: Array<() => string | undefined> = [];
    let finish!: () => void;
    const first = new Promise<void>(resolve => { finish = resolve; });
    const execute = vi.fn(async (...args: unknown[]) => {
      const guard = args[3] as () => string | undefined;
      guards.push(guard);
      if (guards.length === 1) await first;
      return JSON.stringify({ room: guard() ?? null });
    });
    const h = harness(execute); ready(h); h.receive({ type: "speech-started" });
    h.receive({ type: "response-created", responseId: "r1" });
    h.receive(call("first")); h.receive(call("late"));
    await flush(); expect(guards[0]!()).toBe("room:one");
    h.receive({ type: "speech-started" });
    h.receive({ type: "response-created", responseId: "r2" });
    finish(); await flush();
    expect(guards).toHaveLength(2);
    // Talking again in the same room keeps earlier commands (operator review 2026-10-15).
    expect(guards.every(guard => guard() === "room:one")).toBe(true);
    h.receive({ ...call("new"), responseId: "r2" }); await flush();
    expect(guards[2]!()).toBe("room:one");
    h.invalidateCommands(); expect(guards.every(guard => guard() === undefined)).toBe(true);
  });
  it("rejects disabled tools and malformed arguments before execution", async () => {
    for (const invalid of [{ ...call("c1"), name: "not_enabled" }, { ...call("c1"), arguments: "[]" }, { ...call("c1"), arguments: "broken" }]) {
      const h = harness(); ready(h); h.receive(invalid); await flush();
      expect(h.execute).not.toHaveBeenCalled(); expect(h.onError).toHaveBeenCalledTimes(1);
    }
  });
  it("keeps stable transcript IDs for delta/final and handles interruption", () => {
    const h = harness(); ready(h);
    h.receive({ type: "audio-transcript-delta", itemId: "i1", delta: "Hel" });
    h.receive({ type: "audio-transcript-done", itemId: "i1", transcript: "Hello" });
    h.receive({ type: "speech-started" });
    expect(h.onTranscript.mock.calls).toEqual([["i1", "assistant", "Hel", true], ["i1", "assistant", "Hello", false]]);
    expect(h.onInterrupt).toHaveBeenCalledTimes(1);
  });
});
