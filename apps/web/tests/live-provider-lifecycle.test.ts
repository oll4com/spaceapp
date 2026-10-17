// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { createTranscriptDeduper, openGoogleGeminiConversationSession, openVercelLiveConversationSession, openLiveConversationSession } from "../src/features/live-pane/live-session.js";
import { createIdentifiedLiveCommandOrigins } from "../src/features/live-pane/live-command-origin.js";

function openAIHarness() {
  const handlers = new Map<string, (event: any) => unknown>();
  const track = { enabled: true, stop: vi.fn(), kind: "audio" };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const channel = { readyState: "open", send: vi.fn(), close: vi.fn(), addEventListener: vi.fn((type, fn) => handlers.set(type, fn)) };
  const connection = {
    createDataChannel: () => channel, addEventListener: vi.fn(), addTrack: vi.fn(), getTransceivers: () => [],
    createOffer: async () => ({ type: "offer", sdp: "v=0" }), setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}), iceGatheringState: "complete", localDescription: { sdp: "v=0" },
    getSenders: () => [], close: vi.fn()
  };
  const inspectRoomMission = vi.fn(async (roomId: string) => ({ roomId, snapshot: null }));
  installSpaceRuntime({ ...liveRuntime, api: { createVoiceRealtimeCall: vi.fn(async () => ({ answerSdp: "v=0" })),
    inspectRoomMission, reportLiveVoiceLog: vi.fn(async () => ({})) } as any,
    platform: { ...liveRuntime.platform, userMediaSupported: true, peerConnectionSupported: true,
      getUserMedia: vi.fn(async () => stream as any), createPeerConnection: () => connection as any } });
  const emitTrack = (event: object) => connection.addEventListener.mock.calls.filter(([type]) => type === "track").forEach(([, fn]) => (fn as (event: object) => void)(event));
  return { sent: channel.send, channel, inspectRoomMission, emitTrack, open: () => handlers.get("open")?.({}), receive: (data: object) => handlers.get("message")?.({ data: JSON.stringify(data) }) };
}

function harness(protocol: "google-live" | "gateway-realtime") {
  const processors: any[] = [];
  const contexts: any[] = [];
  const track = { enabled: true, stop: vi.fn() };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Context {
    state = "running"; sampleRate = 48000; destination = {}; currentTime = 0;
    close = vi.fn(async () => { this.state = "closed"; });
    resume = vi.fn(async () => {});
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createScriptProcessor() { const node = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: undefined }; processors.push(node); return node; }
    createGain() { return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }; }
  }
  const sockets: Socket[] = [];
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0; bufferedAmount = 0; binaryType = "";
    onopen?: (event: any) => void; onmessage?: (event: any) => void; onclose?: (event: any) => void; onerror?: (event: any) => void;
    send = vi.fn(); close = vi.fn(() => { this.readyState = 3; });
    constructor() { sockets.push(this); }
  }
  vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("AudioContext", Context);
  const createVoiceRealtimeCall = vi.fn(async () => ({ protocol, model: protocol === "google-live" ? "gemini-3.8-live" : "openai/gpt-realtime-mini", websocketUrl: "/api/voice/ws-proxy/test" }));
  const getUserMedia = vi.fn(async () => stream as unknown as MediaStream);
  const inspectRoomMission = vi.fn(async (roomId: string) => ({ roomId, snapshot: null }));
  const delegateVoiceIntent = vi.fn(async (_input: unknown): Promise<any> => ({ message: "No action" }));
  installSpaceRuntime({ ...liveRuntime, api: { createVoiceRealtimeCall, inspectRoomMission, delegateVoiceIntent, reportLiveVoiceLog: vi.fn(async () => ({})) } as any, platform: { ...liveRuntime.platform, userMediaSupported: true, getUserMedia } });
  const processAudio = (level = 0) => processors[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(100).fill(level) } });
  const open = () => { sockets[0]!.readyState = 1; sockets[0]!.onopen?.({}); };
  const receive = (data: object) => sockets[0]!.onmessage?.({ data: JSON.stringify(data) });
  return { contexts, processors, track, sockets, open, receive, processAudio, createVoiceRealtimeCall, getUserMedia, inspectRoomMission, delegateVoiceIntent };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); installSpaceRuntime(liveRuntime); });

describe("voice provider readiness and cleanup", () => {
  it("plays the OpenAI reply through one path only, so echo cancellation sees one source", async () => {
    const h = openAIHarness();
    const webAudioSources = vi.fn();
    vi.stubGlobal("AudioContext", class { state = "running"; destination = {};
      createMediaStreamSource(stream: unknown) { webAudioSources(stream); return { connect: vi.fn() }; }
      createAnalyser() { return { fftSize: 0, frequencyBinCount: 1, getByteFrequencyData: vi.fn(), getByteTimeDomainData: vi.fn(), connect: vi.fn() }; }
      resume = vi.fn(async () => {}); close = vi.fn(async () => {}); });
    const onRemoteStream = vi.fn();
    const remote = { id: "remote" };
    const session = await openLiveConversationSession({ model: "gpt-realtime-mini", getCommandRoom: () => "room:a" }, { onRemoteStream });
    const audioBefore = document.querySelectorAll("audio").length;
    try {
      h.emitTrack({ streams: [remote] });
      expect(onRemoteStream).toHaveBeenCalledExactlyOnceWith(remote);
      expect(document.querySelectorAll("audio")).toHaveLength(audioBefore);
      expect(webAudioSources).not.toHaveBeenCalledWith(remote);
    } finally { session.close(); }
  });
  it("rejects late legacy Gateway delegation and resumes after a completed turn", async () => {
    const h = harness("gateway-realtime"); let room = "room:a";
    const session = await openVercelLiveConversationSession({ model: "openai/gpt-live-1", getCommandRoom: () => room });
    const delegate = (id: string) => ({ type: "session.delegation.created", delegation_id: id, name: "space_plan_mission", arguments: '{"action":"status"}' });
    try {
      h.open(); await h.receive({ type: "session.started" });
      await session.sendInput?.([{ type: "text", text: "First" }]);
      room = "room:b";
      await session.sendInput?.([{ type: "text", text: "Second" }]);
      await h.receive(delegate("late"));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(h.inspectRoomMission).not.toHaveBeenCalled();
      await h.receive({ type: "session.output_transcript.done" });
      await session.sendInput?.([{ type: "text", text: "Fresh" }]);
      await h.receive(delegate("fresh"));
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(h.inspectRoomMission).toHaveBeenCalledExactlyOnceWith("room:b");
    } finally { session.close(); }
  });

  it("keeps legacy intent resolution attached to its original input across the await", async () => {
    const h = harness("gateway-realtime"); let room = "room:a", resolve!: (value: any) => void;
    h.delegateVoiceIntent.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const session = await openVercelLiveConversationSession({ model: "openai/gpt-live-1", getCommandRoom: () => room });
    try {
      h.open(); await h.receive({ type: "session.started" });
      await h.receive({ type: "session.input_transcript.delta", delta: "Inspect the mission" });
      const pending = h.receive({ type: "session.delegation.created", delegation_id: "old:intent" });
      expect(h.delegateVoiceIntent).toHaveBeenCalledWith(expect.objectContaining({ roomId: "room:a" }));
      room = "room:b";
      await h.receive({ type: "session.input_audio.speech_started" });
      resolve({ toolCall: { name: "space_plan_mission", args: { action: "status" } } });
      await pending;
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(h.inspectRoomMission).not.toHaveBeenCalled();
      const result = h.sockets[0]!.send.mock.calls.map(([raw]) => JSON.parse(raw)).find(m => m.type === "session.commentary.append" && m.delegation_id === "old:intent");
      expect(result.content).toContain("LIVE_ROOM_CONTEXT_UNSET");
    } finally { session.close(); }
  });

  it("binds late OpenAI tool calls to their response ID instead of a newer input", async () => {
    const h = openAIHarness(); let room = "room:a";
    const session = await openLiveConversationSession({ model: "gpt-realtime-mini", getCommandRoom: () => room });
    try {
      h.open(); await h.receive({ type: "session.created" });
      await session.sendInput?.([{ type: "text", text: "First mission" }]);
      await h.receive({ type: "response.created", response: { id: "response:first" } });
      room = "room:b";
      await session.sendInput?.([{ type: "text", text: "Second mission" }]);
      await h.receive({ type: "response.created", response: { id: "response:second" } });
      const tool = (response_id: string, call_id: string) => ({ type: "response.function_call_arguments.done", response_id, call_id, name: "space_plan_mission", arguments: '{"action":"status"}' });
      await h.receive(tool("response:first", "call:old"));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(h.inspectRoomMission).not.toHaveBeenCalled();
      const rejected = h.sent.mock.calls.map(([raw]) => JSON.parse(raw)).find(m => m.item?.call_id === "call:old");
      expect(rejected.item.output).toContain("LIVE_ROOM_CONTEXT_UNSET");
      await h.receive(tool("response:second", "call:new"));
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(h.inspectRoomMission).toHaveBeenCalledExactlyOnceWith("room:b");
      await h.receive(tool("response:second", "call:new"));
      expect(h.inspectRoomMission).toHaveBeenCalledTimes(1);
    } finally { session.close(); }
  });

  it.each([false, true])("runs a delayed OpenAI response after two inputs, reconnecting only when they were in different rooms (room changed: %s)", async changed => {
    const h = openAIHarness();
    const onError = vi.fn();
    let room = "room:a";
    const session = await openLiveConversationSession({ model: "gpt-realtime-mini", getCommandRoom: () => room }, { onError });
    try {
      h.open(); await h.receive({ type: "session.created" });
      await h.receive({ type: "input_audio_buffer.speech_started", item_id: "input:1" });
      if (changed) room = "room:b";
      await h.receive({ type: "input_audio_buffer.speech_started", item_id: "input:2" });
      await h.receive({ type: "response.created", response: { id: "response:late" } });
      await h.receive({ type: "response.done", response: { id: "response:late", output: [{ type: "function_call", call_id: "call:late", name: "space_plan_mission", arguments: '{"action":"status"}' }] } });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      if (changed) {
        expect(h.inspectRoomMission).not.toHaveBeenCalled();
        expect(h.channel.close).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(expect.stringContaining("Overlapping voice commands"));
      } else {
        // "Can you hear me?" while a command is on its way must not cancel it (operator review 2026-10-15).
        expect(h.inspectRoomMission).toHaveBeenCalledExactlyOnceWith("room:a");
        expect(onError).not.toHaveBeenCalled();
      }
    } finally { session.close(); }
  });

  it("splits GPT-Live's unmarked transcript stream into turns and runs its tool calls in the speaker's room", async () => {
    vi.useFakeTimers();
    const h = openAIHarness();
    const onTranscriptUpdate = vi.fn(), onInputStart = vi.fn(), onInputEnd = vi.fn();
    const session = await openLiveConversationSession({ model: "gpt-live-1", getCommandRoom: () => "room:a" }, { onTranscriptUpdate, onInputStart, onInputEnd });
    try {
      h.open(); await h.receive({ type: "session.started" });
      await h.receive({ type: "session.input_transcript.delta", delta: "Open a Claude", start_ms: 0, end_ms: 400 });
      await h.receive({ type: "session.input_transcript.delta", delta: " pane", start_ms: 400, end_ms: 600 });
      await h.receive({ type: "session.output_transcript.delta", delta: "Opening it." });
      await h.receive({ type: "session.input_transcript.delta", delta: "Can you hear me?", start_ms: 3000, end_ms: 3400 });
      await h.receive({ type: "response.created", response: { id: "delegation:1" } });
      await h.receive({ type: "response.done", response: { id: "delegation:1", output: [{ type: "function_call", call_id: "call:open", name: "space_plan_mission", arguments: '{"action":"status"}' }] } });
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.inspectRoomMission).toHaveBeenCalledExactlyOnceWith("room:a");
      const finals = onTranscriptUpdate.mock.calls.map(([item]) => item).filter(item => item.role === "user" && !item.isDelta);
      expect(finals.map(item => item.text)).toEqual(["Open a Claude pane", "Can you hear me?"]);
      expect(new Set(finals.map(item => item.id)).size).toBe(2);
      expect(onInputStart).toHaveBeenCalledTimes(2);
      expect(onInputEnd).toHaveBeenCalledTimes(2);
    } finally { session.close(); }
  });

  it("keeps overlapping GPT-Live speech whole and shows a delegated reply once, as spoken", async () => {
    vi.useFakeTimers();
    const h = openAIHarness();
    const onTranscriptUpdate = vi.fn();
    const session = await openLiveConversationSession({ model: "gpt-live-1", getCommandRoom: () => "room:a" }, { onTranscriptUpdate });
    try {
      h.open(); await h.receive({ type: "session.started" });
      // The 2026-10-15 dialogue: Live began answering while the user was still finishing the question.
      await h.receive({ type: "session.input_transcript.delta", delta: "Τι δούλευ", start_ms: 0, end_ms: 500 });
      await h.receive({ type: "session.output_transcript.delta", delta: "Για να σου" });
      await h.receive({ type: "session.input_transcript.delta", delta: "ε πριν τελειώσει", start_ms: 600, end_ms: 1400 });
      await h.receive({ type: "session.output_transcript.delta", delta: " πω ακριβώς." });
      await vi.advanceTimersByTimeAsync(2000);
      await h.receive({ type: "response.output_text.delta", delta: "Η **Dana** δουλεύει." });
      await h.receive({ type: "session.output_transcript.delta", delta: "Η Dana" });
      await h.receive({ type: "session.output_transcript.delta", delta: " δουλεύει." });
      const items = new Map<string, { role: string; text: string }>();
      for (const [item] of onTranscriptUpdate.mock.calls) {
        const previous = items.get(item.id);
        items.set(item.id, { role: item.role, text: item.isDelta && previous ? previous.text + item.text : item.text });
      }
      expect([...items.values()]).toEqual([
        { role: "user", text: "Τι δούλευε πριν τελειώσει" },
        { role: "assistant", text: "Για να σου πω ακριβώς." },
        { role: "assistant", text: "Η Dana δουλεύει." }
      ]);
    } finally { session.close(); }
  });

  it("keeps one response slot for inputs in the same room", () => {
    const onAmbiguous = vi.fn();
    const origins = createIdentifiedLiveCommandOrigins(() => () => "room:a", 4096, onAmbiguous);
    origins.beginInput(); origins.beginInput(); origins.responseCreated("late");
    origins.bindCall("call:late", "late");
    expect(origins.captureCall("call:late")()).toBe("room:a");
    expect(onAmbiguous).not.toHaveBeenCalled();
  });

  it("does not reuse an ambiguous response slot for a third input", () => {
    const onAmbiguous = vi.fn();
    let room = "room:a";
    const origins = createIdentifiedLiveCommandOrigins(() => { const captured = room; return () => room === captured ? captured : undefined; }, 4096, onAmbiguous);
    origins.beginInput(); room = "room:b"; origins.beginInput(); origins.responseCreated("late:first");
    origins.beginInput(); origins.responseCreated("late:second");
    origins.bindCall("old:second", "late:second");
    expect(origins.captureCall("old:second")()).toBeUndefined();
    expect(onAmbiguous).toHaveBeenCalledOnce();
  });

  it("preserves response origins through continuations, conflicts and bounded capacity", () => {
    const origins = createIdentifiedLiveCommandOrigins(() => () => "room:a", 2);
    origins.beginInput(); origins.responseCreated("one"); origins.bindCall("call:one", "one");
    const first = origins.captureCall("call:one"); expect(first()).toBe("room:a");
    expect(origins.expectContinuation(first)).toBe(true);
    origins.responseCreated("two"); origins.bindCall("call:two", "two");
    expect(origins.captureCall("call:two")()).toBe("room:a");
    const second = origins.captureCall("call:two");
    origins.cancelResponse("two"); expect(second()).toBeUndefined();
    origins.bindCall("call:one", "two"); expect(origins.captureCall("call:one")()).toBeUndefined();
    // A notice does not cancel the user's command, but its own response runs no tools.
    origins.beginNotification(); expect(first()).toBe("room:a");
    origins.responseCreated("three"); origins.bindCall("call:three", "three");
    expect(origins.captureCall("call:three")()).toBeUndefined();
    origins.invalidate(); expect(first()).toBeUndefined();
    expect(origins.expectContinuation(first)).toBe(false);
  });

  it("binds Google queued tools before a new command context can replace their room", async () => {
    const h = harness("google-live");
    let epoch = 1;
    const captureCommandRoom = vi.fn(() => {
      const captured = epoch;
      return () => epoch === captured ? "room:a" : undefined;
    });
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", captureCommandRoom,
      getCommandRoom: () => "room:b" });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      await session.sendInput?.([{ type: "text", text: "Inspect the mission" }]);
      h.receive({ toolCall: { functionCalls: [{ id: "queued:old", name: "space_plan_mission", args: { action: "status" } }] } });
      expect(captureCommandRoom).toHaveBeenCalledTimes(1);
      epoch++;
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const response = h.sockets[0]!.send.mock.calls.map(call => JSON.parse(call[0])).find(value => value.toolResponse);
      expect(response.toolResponse.functionResponses[0].response.output.result).toContain("LIVE_ROOM_CONTEXT_UNSET");
    } finally { session.close(); }
  });

  it.each(["typed", "microphone"])("rejects a late Google tool after a newer %s input before the first response", async (input) => {
    const h = harness("google-live");
    let room = "room:a";
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => room });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      await session.sendInput?.([{ type: "text", text: "Inspect the old mission" }]);
      room = "room:b";
      if (input === "typed") await session.sendInput?.([{ type: "text", text: "Inspect the new mission" }]);
      else h.processAudio(0.1);
      await h.receive({ toolCall: { functionCalls: [{ id: "late:old", name: "space_plan_mission", args: { action: "status" } }] } });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const responses = h.sockets[0]!.send.mock.calls.map(call => JSON.parse(call[0])).filter(value => value.toolResponse);
      expect(responses[0].toolResponse.functionResponses[0].response.output.result).toContain("LIVE_ROOM_CONTEXT_UNSET");
      expect(h.inspectRoomMission).not.toHaveBeenCalled();
      // A completed provider turn and a fresh input restore normal operation.
      await h.receive({ serverContent: { turnComplete: true } });
      await session.sendInput?.([{ type: "text", text: "Inspect the current mission" }]);
      await h.receive({ toolCall: { functionCalls: [{ id: "fresh:new", name: "space_plan_mission", args: { action: "status" } }] } });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(h.inspectRoomMission).toHaveBeenCalledExactlyOnceWith("room:b");
    } finally { session.close(); }
  });

  it.each(["navigation", "interruption", "notification", "cancellation"])("does not authorize Google tools after %s", async (change) => {
    const h = harness("google-live");
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => "room:a" });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      await session.sendInput?.([{ type: "text", text: "Inspect the mission" }]);
      const call = { id: "cancelled:call", name: "space_plan_mission", args: { action: "status" } };
      if (change === "navigation") session.updateContext?.({ roomId: "room:b", name: "Second", description: null, objective: null, revision: "b", checkedAt: "", panes: [] });
      if (change === "interruption") await h.receive({ serverContent: { interrupted: true } });
      if (change === "notification") {
        await h.receive({ serverContent: { turnComplete: true } });
        expect(session.notify?.("Task completed", "watch:1")).toBe(true);
      }
      // Cancellation may precede receipt of the corresponding call.
      if (change === "cancellation") await h.receive({ toolCallCancellation: { ids: [call.id] } });
      await h.receive({ toolCall: { functionCalls: [call] } });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(h.inspectRoomMission).not.toHaveBeenCalled();
      const response = h.sockets[0]!.send.mock.calls.map(call => JSON.parse(call[0])).find(value => value.toolResponse);
      expect(response.toolResponse.functionResponses[0].response.output.result).toContain("LIVE_ROOM_CONTEXT_UNSET");
    } finally { session.close(); }
  });
  it.each([false, true])("keeps one Google speech origin across sentence pauses (room changed: %s)", async changed => {
    vi.useFakeTimers();
    const h = harness("google-live");
    let room = "room:a";
    const onInputStart = vi.fn(), onInputEnd = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => room }, { onInputStart, onInputEnd });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      h.processAudio(0.1);
      h.processAudio(0);
      await vi.advanceTimersByTimeAsync(750);
      if (changed) {
        room = "room:b";
        session.updateContext?.({ roomId: room, name: "Second", description: null, objective: null, revision: "b", checkedAt: "", panes: [] });
      }
      h.processAudio(0.1);
      expect(onInputStart).toHaveBeenCalledTimes(1);
      expect(onInputEnd).not.toHaveBeenCalled();
      await h.receive({ toolCall: { functionCalls: [{ id: "speech:sentences", name: "space_plan_mission", args: { action: "status" } }] } });
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(onInputEnd).toHaveBeenCalledTimes(1);
      if (changed) expect(h.inspectRoomMission).not.toHaveBeenCalled();
      else expect(h.inspectRoomMission).toHaveBeenCalledExactlyOnceWith("room:a");
    } finally { session.close(); }
  });

  it("keeps notifications out of the silent gap before a Google tool response completes", async () => {
    const h = harness("google-live");
    let settle!: (value: any) => void;
    h.inspectRoomMission.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => "room:a" });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      await session.sendInput?.([{ type: "text", text: "Inspect the mission" }]);
      expect(session.notify?.("Another task completed", "watch:1")).toBe(false);
      await h.receive({ toolCall: { functionCalls: [{ id: "slow:tool", name: "space_plan_mission", args: { action: "status" } }] } });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await h.receive({ serverContent: { turnComplete: true } });
      expect(session.notify?.("Another task completed", "watch:1")).toBe(false);
      settle({ roomId: "room:a", snapshot: null });
      for (let i = 0; i < 60; i++) await Promise.resolve();
      expect(session.notify?.("Another task completed", "watch:1")).toBe(false);
      await h.receive({ serverContent: { turnComplete: true } });
      expect(session.notify?.("Another task completed", "watch:1")).toBe(true);
      expect(session.notify?.("Second notification", "watch:2")).toBe(false);
    } finally { session.close(); }
  });

  it.each(["typed", "microphone"])("serializes a fresh %s command after a notification without authorizing notification tools", async input => {
    const h = harness("google-live"), onInputStart = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => "room:a" }, { onInputStart });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      expect(session.notify?.("Task completed", "watch:one")).toBe(true);
      const sent = () => h.sockets[0]!.send.mock.calls.map(([raw]) => JSON.parse(raw));
      let pending: void | Promise<void> = undefined;
      if (input === "typed") pending = session.sendInput?.([{ type: "text", text: "Fresh command" }]);
      else h.processAudio(0.1);
      await Promise.resolve();
      expect(sent().filter(frame => frame.clientContent?.turnComplete)).toHaveLength(1);
      expect(sent().some(frame => frame.realtimeInput?.audio)).toBe(false);
      await h.receive({ toolCall: { functionCalls: [{ id: "notification:late", name: "space_plan_mission", args: { action: "status" } }] } });
      for (let i = 0; i < 60; i++) await Promise.resolve();
      expect(h.inspectRoomMission).not.toHaveBeenCalled();
      await h.receive({ serverContent: { turnComplete: true } });
      await pending;
      for (let i = 0; i < 30; i++) await Promise.resolve();
      if (input === "typed") expect(sent().filter(frame => frame.clientContent?.turnComplete)).toHaveLength(2);
      else {
        expect(sent().some(frame => frame.realtimeInput?.audio)).toBe(true);
        expect(onInputStart).toHaveBeenCalledTimes(1);
      }
      await h.receive({ toolCall: { functionCalls: [{ id: "user:fresh", name: "space_plan_mission", args: { action: "status" } }] } });
      for (let i = 0; i < 60; i++) await Promise.resolve();
      expect(h.inspectRoomMission).toHaveBeenCalledExactlyOnceWith("room:a");
    } finally { session.close(); }
  });

  it.each(["room switch", "close"])("rejects a notification-queued text input after %s", async change => {
    const h = harness("google-live"); let room = "room:a";
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => room });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      session.notify?.("Task completed", "watch:one");
      const pending = session.sendInput!([{ type: "text", text: "Original room command" }]);
      const rejected = expect(pending).rejects.toThrow(/closed|room|context/i);
      if (change === "close") session.close();
      else { room = "room:b"; session.updateContext?.({ roomId: room, name: "Second", description: null, objective: null, revision: "b", checkedAt: "", panes: [] }); await h.receive({ serverContent: { turnComplete: true } }); }
      await rejected;
      const turns = h.sockets[0]!.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(frame => frame.clientContent?.turnComplete);
      expect(turns).toHaveLength(1);
    } finally { session.close(); }
  });

  it("discards notification-queued speech when its originating room changes", async () => {
    const h = harness("google-live"), onError = vi.fn(); let room = "room:a";
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => room }, { onError });
    try {
      h.open(); await h.receive({ setupComplete: {} }); session.notify?.("Done", "watch:one");
      h.processAudio(0.1);
      room = "room:b"; session.updateContext?.({ roomId: room, name: "Second", description: null, objective: null, revision: "b", checkedAt: "", panes: [] });
      await h.receive({ serverContent: { turnComplete: true } });
      expect(h.sockets[0]!.send.mock.calls.map(([raw]) => JSON.parse(raw)).some(frame => frame.realtimeInput?.audio)).toBe(false);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("room changed"));
    } finally { session.close(); }
  });

  it("bounds notification-queued input when the provider never completes the notification", async () => {
    vi.useFakeTimers();
    const h = harness("google-live"), onError = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => "room:a" }, { onError });
    try {
      h.open(); await h.receive({ setupComplete: {} }); session.notify?.("Done", "watch:one");
      const rejected = expect(session.sendInput!([{ type: "text", text: "Waiting command" }])).rejects.toThrow("30 seconds");
      h.processAudio(0.1);
      await vi.advanceTimersByTimeAsync(30_000); await rejected;
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("30 seconds"));
      await h.receive({ serverContent: { turnComplete: true } });
      expect(h.sockets[0]!.send.mock.calls.map(([raw]) => JSON.parse(raw)).some(frame => frame.realtimeInput?.audio)).toBe(false);
    } finally { session.close(); }
  });

  it("accepts the next Google input when turnComplete arrives before a tool settles", async () => {
    const h = harness("google-live");
    let settle!: (value: any) => void;
    h.inspectRoomMission.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", getCommandRoom: () => "room:a" });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      await session.sendInput?.([{ type: "text", text: "First command" }]);
      await h.receive({ toolCall: { functionCalls: [{ id: "slow:first", name: "space_plan_mission", args: { action: "status" } }] } });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect(h.inspectRoomMission).toHaveBeenCalledTimes(1);
      await h.receive({ serverContent: { turnComplete: true } });
      await session.sendInput?.([{ type: "text", text: "Next valid command" }]);
      await h.receive({ toolCall: { functionCalls: [{ id: "fresh:next", name: "space_plan_mission", args: { action: "status" } }] } });
      settle({ roomId: "room:a", snapshot: null });
      for (let i = 0; i < 60; i++) await Promise.resolve();
      expect(h.inspectRoomMission).toHaveBeenCalledTimes(2);
    } finally { session.close(); }
  });

  it("never displays modelTurn thoughts or bookkeeping in Google AUDIO mode", async () => {
    const h = harness("google-live"), onTranscriptUpdate = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onTranscriptUpdate });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      await h.receive({ serverContent: { modelTurn: { parts: [{ text: "Duplicating call:space_inspect_activity", thought: true }, { text: "Internal reasoning" }] } } });
      expect(onTranscriptUpdate).not.toHaveBeenCalled();
      await h.receive({ serverContent: { outputTranscription: { text: "Εργάζονται δύο agents." }, turnComplete: true } });
      expect(onTranscriptUpdate.mock.calls.map(([item]) => item.text)).toEqual(["Εργάζονται δύο agents.", "Εργάζονται δύο agents."]);
    } finally { session.close(); }
  });

  it("queues the latest room context until Google is ready without triggering speech or reconnect", async () => {
    const h = harness("google-live");
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", muted: true });
    try {
      const context = { roomId: "room:b", name: "Second", description: null, objective: null, revision: "b", checkedAt: "", panes: [] };
      session.updateContext?.(context);
      expect(h.track.enabled).toBe(false);
      h.open(); await h.receive({ setupComplete: {} });
      const messages = h.sockets[0]!.send.mock.calls.map(call => JSON.parse(call[0]));
      const update = messages.find(message => message.clientContent);
      expect(update.clientContent.turnComplete).toBe(false);
      expect(update.clientContent.turns[0].parts[0].text).toContain('"roomId":"room:b"');
      expect(h.getUserMedia).toHaveBeenCalledTimes(1);
      expect(h.track.stop).not.toHaveBeenCalled();
    } finally { session.close(); }
  });

  it("keeps transcript replay deduplication bounded without evicting old events", () => {
    const dedupe = createTranscriptDeduper(2);
    expect(dedupe("assistant", "Hello", "event-1")).toBe(true);
    expect(dedupe("assistant", "Hello", "event-1")).toBe(false);
    expect(dedupe("assistant", "Different", "event-2")).toBe(true);
    expect(() => dedupe("assistant", "Third", "event-3")).toThrow("capacity");
    expect(dedupe("assistant", "Hello", "event-1")).toBe(false);
  });

  it("preserves repeated text without a stable provider event identity", () => {
    const dedupe = createTranscriptDeduper(1);
    expect(dedupe("assistant", "Ναι")).toBe(true);
    expect(dedupe("assistant", "Ναι")).toBe(true);
  });

  it("preserves identical Google audio transcripts across turns", async () => {
    const h = harness("google-live"), onTranscriptUpdate = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onTranscriptUpdate });
    try {
      h.open(); h.receive({ setupComplete: {} });
      const event = { serverContent: { turnComplete: true, outputTranscription: { text: "Ναι" } } };
      await h.receive(event);
      await h.receive(event);
      expect(onTranscriptUpdate.mock.calls.filter(([item]) => !item.isDelta).map(([item]) => item.text)).toEqual(["Ναι", "Ναι"]);
    } finally { session.close(); }
  });

  it("deduplicates Google tool IDs across both event shapes", async () => {
    const h = harness("google-live");
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" });
    h.open(); h.receive({ setupComplete: {} });
    const fc = { id: "google:stable-call", name: "space_get_current_time", args: {} };
    h.receive({ toolCall: { functionCalls: [fc] }, serverContent: { modelTurn: { parts: [{ functionCall: fc }] } } });
    h.receive({ functionCalls: [fc] });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const results = h.sockets[0]!.send.mock.calls.map(call => JSON.parse(call[0])).filter(value => value.toolResponse);
    expect(results).toHaveLength(3);
    expect(new Set(results.map(r => r.toolResponse.functionResponses[0].response.output.result)).size).toBe(1);
    expect(results[0].toolResponse.functionResponses[0]).toMatchObject({ id: fc.id, name: fc.name });
    session.close();
  });

  it("captures Google resumption updates without disconnecting early on GoAway", async () => {
    const h = harness("google-live");
    const onSessionResumption = vi.fn(), onError = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onSessionResumption, onError });
    h.open();
    h.receive({ setupComplete: {} });
    h.receive({ sessionResumptionUpdate: { newHandle: "resume-handle", resumable: true } });
    expect(onSessionResumption).toHaveBeenCalledWith("resume-handle", true);
    h.receive({ goAway: { timeLeft: "10s" } });
    expect(onError).not.toHaveBeenCalled();
    expect(h.track.stop).not.toHaveBeenCalled();
    session.close();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
  });

  it("sends an explicit Google resumption handle only when supplied", async () => {
    const h = harness("google-live");
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", sessionResumptionHandle: "resume-1" });
    h.open();
    const setup = JSON.parse(h.sockets[0]!.send.mock.calls[0]![0]);
    expect(setup.setup.sessionResumption).toEqual({ handle: "resume-1" });
    session.close();
  });

  it("strips keywords the Gemini Live setup parser rejects from tool declarations", async () => {
    // A single unsupported schema keyword makes Google close the socket with
    // 1007 and no error frame, which reached the user as "Code 1011:
    // upstream_closed" (2026-09-20 incident).
    const h = harness("google-live");
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" });
    h.open();
    const setup = JSON.parse(h.sockets[0]!.send.mock.calls[0]![0]);
    const declarations = setup.setup.tools[0].functionDeclarations as Array<Record<string, unknown>>;
    expect(declarations.length).toBeGreaterThan(20);
    expect(JSON.stringify(declarations)).not.toContain("additionalProperties");
    expect(declarations.find(tool => tool.name === "space_open_panes")).toBeTruthy();
    session.close();
  });

  it("keeps the Gemini setup frame, with the full Space Control description, under the voice relay's 64 KB frame limit", async () => {
    const h = harness("google-live");
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" });
    h.open();
    const frame = h.sockets[0]!.send.mock.calls[0]![0] as string;
    const declarations = JSON.parse(frame).setup.tools[0].functionDeclarations as Array<{ name: string; description: string }>;
    const execute = declarations.find(tool => tool.name === "space_execute_mcp")!;
    expect(execute.description).toContain("tasks.create");
    expect(execute.description).not.toContain("ops.deploy");
    // Leaves room for personal memory, prior turns and the room context added in production.
    expect(new TextEncoder().encode(frame).length).toBeLessThan(48 * 1024);
    session.close();
  });

  it("reports a setup rejection instead of a plain disconnect when Google never acknowledges setup", async () => {
    const h = harness("google-live");
    const onError = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onError });
    h.open();
    h.sockets[0]!.onclose?.({ code: 1011, reason: "upstream_closed", wasClean: false });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("rejected the session setup"));
    session.close();
  });

  it("explains a relay close for used-up provider credits instead of a setup rejection", async () => {
    const h = harness("google-live");
    const onError = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onError });
    h.open();
    h.sockets[0]!.onclose?.({ code: 1011, reason: "provider_quota_exhausted", wasClean: false });
    expect(onError).toHaveBeenCalledWith("Google Gemini Live is unavailable: the credits of Space's voice key are used up. Top up its billing (Google AI Studio for Gemini) or choose another voice provider in Settings.");
    session.close();
  });

  it("offers one explicit resumable reconnect after an unexpected Google close", async () => {
    const h = harness("google-live");
    const onReconnect = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onReconnect });
    h.open();
    h.receive({ setupComplete: {} });
    h.receive({ sessionResumptionUpdate: { newHandle: "resume-close", resumable: true } });
    h.sockets[0]!.onclose?.({ code: 1001, reason: "provider rotation", wasClean: false });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    const reconnect = onReconnect.mock.calls[0]![0] as () => Promise<unknown>;
    const resumed = await reconnect();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.readyState = 1;
    h.sockets[1]!.onopen?.({});
    const setup = JSON.parse(h.sockets[1]!.send.mock.calls[0]![0]);
    expect(setup.setup.sessionResumption).toEqual({ handle: "resume-close" });
    (resumed as { close: () => void }).close();
    expect(h.track.stop).toHaveBeenCalledTimes(2);
  });

  it("accumulates and finalizes Greek audio transcripts under stable turn IDs", async () => {
    const h = harness("google-live"), onTranscriptUpdate = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onTranscriptUpdate });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      await h.receive({ serverContent: { inputTranscription: { text: "Άνοιξε " } } });
      await h.receive({ serverContent: { inputTranscription: { text: "το pane" }, outputTranscription: { text: "Ελέγχω." }, turnComplete: true } });
      const items = onTranscriptUpdate.mock.calls.map(call => call[0]);
      const final = items.filter(item => !item.isDelta);
      expect(final.map(item => [item.role, item.text])).toEqual([["user", "Άνοιξε το pane"], ["assistant", "Ελέγχω."]]);
      expect(items[0].id).toBe(final[0].id);
      await h.receive({ serverContent: { inputTranscription: { text: "Άνοιξε το pane" }, turnComplete: true } });
      expect(onTranscriptUpdate.mock.calls.at(-1)![0].id).not.toBe(final[0].id);
    } finally { session.close(); }
  });

  it("rejects Google mission calls when MCP tools are disabled", async () => {
    const h = harness("google-live"), onError = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live", enableMcpTools: false }, { onError });
    h.open(); h.receive({ setupComplete: {} });
    h.receive({ toolCall: { functionCalls: [{ id: "google:disabled-call", name: "space_plan_mission", args: { action: "start", goal: "Do not execute" } }] } });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("disabled tool"));
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.sockets[0]!.send.mock.calls.map(call => JSON.parse(call[0])).filter(value => value.toolResponse)).toHaveLength(0);
    session.close();
  });

  it.each(["google-live", "gateway-realtime"] as const)("gates %s microphone and cleans up on setup timeout", async (protocol) => {
    vi.useFakeTimers();
    const h = harness(protocol);
    const onError = vi.fn();
    const session = protocol === "google-live"
      ? await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onError })
      : await openVercelLiveConversationSession({ model: "openai/gpt-realtime-mini" }, { onError });
    h.open(); h.processAudio();
    expect(h.sockets[0]!.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_100); h.processAudio();
    expect(h.sockets[0]!.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("acknowledgement timed out"));
    expect(h.track.stop).toHaveBeenCalledTimes(1);
    expect(h.contexts.every(ctx => ctx.close.mock.calls.length === 1)).toBe(true);
    session.close();
    expect(h.track.stop).toHaveBeenCalledTimes(1);
  });
  it.each(["google-live", "gateway-realtime"] as const)("sends %s PCM only after server acknowledgement", async (protocol) => {
    vi.useFakeTimers(); const h = harness(protocol);
    const session = protocol === "google-live"
      ? await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" })
      : await openVercelLiveConversationSession({ model: "openai/gpt-realtime-mini" });
    h.open(); h.receive(protocol === "google-live" ? { setupComplete: {} } : { type: "session-updated" }); h.processAudio();
    expect(h.sockets[0]!.send).toHaveBeenCalledTimes(2);
    const audio = JSON.parse(h.sockets[0]!.send.mock.calls[1]![0]);
    if (protocol === "google-live") expect(audio.realtimeInput.audio.mimeType).toBe("audio/pcm;rate=16000");
    else expect(audio.type).toBe("input-audio-append");
    session.close(); await vi.advanceTimersByTimeAsync(20_000);
    expect(h.track.stop).toHaveBeenCalledTimes(1);
  });
  it("asks the Gateway for semantic turn detection on OpenAI models and transcribes both languages unless Greek only", async () => {
    const h = harness("gateway-realtime");
    const session = await openVercelLiveConversationSession({ model: "openai/gpt-realtime-mini", language: "en" });
    try {
      h.open();
      const setup = h.sockets[0]!.send.mock.calls[0]![0] as string;
      expect(setup).toMatch(/semantic[-_]vad/);
      expect(setup).not.toMatch(/"language":"en"/);
    } finally { session.close(); }
  });
  it.each(["google-live", "gateway-realtime"] as const)("does not acquire a microphone if %s session creation fails", async (protocol) => {
    const h = harness(protocol); h.createVoiceRealtimeCall.mockRejectedValueOnce(new Error("provider unavailable"));
    const start = protocol === "google-live" ? openGoogleGeminiConversationSession : openVercelLiveConversationSession;
    await expect(start({ model: protocol === "google-live" ? "gemini-3.8-live" : "openai/gpt-realtime-mini" })).rejects.toThrow("provider unavailable");
    expect(h.getUserMedia).not.toHaveBeenCalled();
  });

  it("handles cumulative Google transcript updates without prefix repetition", async () => {
    const h = harness("google-live"), onTranscriptUpdate = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onTranscriptUpdate });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      // Cumulative chunks as sent by Google Gemini Live
      await h.receive({ serverContent: { outputTranscription: { text: "Σύμφωνα με το " } } });
      await h.receive({ serverContent: { outputTranscription: { text: "Σύμφωνα με το σύστημα, είναι ανοικτά" } } });
      await h.receive({ serverContent: { outputTranscription: { text: "Σύμφωνα με το σύστημα, είναι ανοικτά 16 παράθυρα." }, turnComplete: true } });
      const finalAssistantCalls = onTranscriptUpdate.mock.calls
        .map(c => c[0])
        .filter(item => item.role === "assistant" && !item.isDelta);
      expect(finalAssistantCalls.length).toBe(1);
      expect(finalAssistantCalls[0].text).toBe("Σύμφωνα με το σύστημα, είναι ανοικτά 16 παράθυρα.");
    } finally { session.close(); }
  });

  it("strips pre-tool assistant text prefix from post-tool assistant response", async () => {
    const h = harness("google-live"), onTranscriptUpdate = vi.fn();
    const session = await openGoogleGeminiConversationSession({ model: "gemini-3.8-live" }, { onTranscriptUpdate });
    try {
      h.open(); await h.receive({ setupComplete: {} });
      const fc = { id: "call-1", name: "space_get_current_time", args: {} };
      // Model speaks before tool call
      await h.receive({ serverContent: { outputTranscription: { text: "Ελέγχω την ώρα." }, modelTurn: { parts: [{ functionCall: fc }] }, turnComplete: true } });
      // Tool finishes and model continues with cumulative text repeating pre-tool phrase
      await h.receive({ serverContent: { outputTranscription: { text: "Ελέγχω την ώρα. Η ώρα είναι 10:00." }, turnComplete: true } });
      const assistantItems = onTranscriptUpdate.mock.calls
        .map(c => c[0])
        .filter(item => item.role === "assistant" && !item.isDelta);
      expect(assistantItems.map(i => i.text)).toEqual(["Ελέγχω την ώρα.", "Η ώρα είναι 10:00."]);
    } finally { session.close(); }
  });
});
