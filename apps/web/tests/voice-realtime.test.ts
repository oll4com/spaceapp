import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoRuntime } from "../src/demo/demo-runtime.js";
import {
  DEMO_LOCAL_REPLY,
  installSpaceRuntime,
  type SpaceRuntime
} from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { openVoiceRealtimeSession, supportsDeferredVoiceCapture } from "../src/voice-realtime.js";

interface AudioStatsState {
  samplesSent?: number;
  sourceDurationSeconds?: number;
  packetsSent: number;
  bytesSent: number;
}

function statsReport(state: AudioStatsState): RTCStatsReport {
  const outbound = {
    id: "outbound-audio",
    type: "outbound-rtp",
    timestamp: Date.now(),
    kind: "audio",
    totalSamplesSent: state.samplesSent,
    packetsSent: state.packetsSent,
    bytesSent: state.bytesSent
  };
  const entries: Array<[string, RTCStats]> = [[outbound.id, outbound as unknown as RTCStats]];
  if (state.sourceDurationSeconds !== undefined) {
    const source = {
      id: "audio-source",
      type: "media-source",
      timestamp: Date.now(),
      kind: "audio",
      totalSamplesDuration: state.sourceDurationSeconds
    };
    entries.push([source.id, source as unknown as RTCStats]);
  }
  return new Map(entries) as unknown as RTCStatsReport;
}

function createLiveAudioHarness(state: AudioStatsState, onError = vi.fn()) {
  let trackState: MediaStreamTrackState = "live";
  const stopTrack = vi.fn(() => {
    trackState = "ended";
  });
  const track = {
    kind: "audio",
    get readyState() {
      return trackState;
    },
    stop: stopTrack
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track]
  } as unknown as MediaStream;
  const sender = {
    track,
    getStats: vi.fn(async () => statsReport(state))
  } as unknown as RTCRtpSender;

  let channelState: RTCDataChannelState = "open";
  const channelTarget = new EventTarget();
  const send = vi.fn();
  const closeChannel = vi.fn(() => {
    channelState = "closed";
  });
  Object.assign(channelTarget, {
    send,
    close: closeChannel
  });
  Object.defineProperty(channelTarget, "readyState", { get: () => channelState });
  const channel = channelTarget as unknown as RTCDataChannel;

  let localDescription: RTCSessionDescription | null = null;
  const connectionTarget = new EventTarget();
  const closeConnection = vi.fn();
  Object.assign(connectionTarget, {
    connectionState: "connected",
    createDataChannel: vi.fn(() => channel),
    addTrack: vi.fn(() => sender),
    getSenders: vi.fn(() => [sender]),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\r\n" })),
    setLocalDescription: vi.fn(async (description: RTCSessionDescriptionInit) => {
      localDescription = description as RTCSessionDescription;
    }),
    setRemoteDescription: vi.fn(async () => undefined),
    close: closeConnection
  });
  Object.defineProperty(connectionTarget, "localDescription", { get: () => localDescription });
  const connection = connectionTarget as unknown as RTCPeerConnection;

  const createVoiceRealtimeCall = vi.fn(async () => ({ answerSdp: "v=0\r\n" }));
  const runtime: SpaceRuntime = {
    ...liveRuntime,
    api: { createVoiceRealtimeCall } as unknown as SpaceRuntime["api"],
    platform: {
      ...liveRuntime.platform,
      userMediaSupported: true,
      peerConnectionSupported: true,
      getUserMedia: vi.fn(async () => stream),
      createPeerConnection: vi.fn(() => connection)
    }
  };
  installSpaceRuntime(runtime);

  return {
    callbacks: { onError },
    channel: channelTarget,
    send,
    stopTrack,
    closeChannel,
    closeConnection,
    createVoiceRealtimeCall
  };
}

describe("Voice Realtime runtime boundary", () => {
  const priorMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

  afterEach(() => {
    vi.useRealTimers();
    if (priorMediaDevices) Object.defineProperty(navigator, "mediaDevices", priorMediaDevices);
    else Reflect.deleteProperty(navigator, "mediaDevices");
    vi.unstubAllGlobals();
  });

  it("blocks demo voice locally before native media or WebRTC access", async () => {
    const nativeGetUserMedia = vi.fn(async () => {
      throw new Error("Native microphone capture must stay unused in demo mode.");
    });
    const nativePeerConnection = vi.fn(() => {
      throw new Error("Native WebRTC must stay unused in demo mode.");
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: nativeGetUserMedia }
    });
    vi.stubGlobal("RTCPeerConnection", nativePeerConnection);
    const { runtime } = createDemoRuntime();
    installSpaceRuntime(runtime);

    await expect(openVoiceRealtimeSession({ model: "gpt-live-transcribe", language: "en", delay: "minimal" }))
      .rejects.toThrow(DEMO_LOCAL_REPLY);

    expect(nativeGetUserMedia).not.toHaveBeenCalled();
    expect(nativePeerConnection).not.toHaveBeenCalled();
  });

  it("waits for at least 100ms of outbound samples before committing and stopping the track", async () => {
    vi.useFakeTimers();
    const state: AudioStatsState = {
      samplesSent: 0,
      sourceDurationSeconds: 0,
      packetsSent: 0,
      bytesSent: 0
    };
    const harness = createLiveAudioHarness(state);
    const session = await openVoiceRealtimeSession(
      { model: "gpt-4o-transcribe", language: "en", delay: "minimal" },
      harness.callbacks
    );

    session.commit();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.stopTrack).not.toHaveBeenCalled();

    state.samplesSent = 4_799;
    state.sourceDurationSeconds = 0.099;
    state.packetsSent = 4;
    state.bytesSent = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.stopTrack).not.toHaveBeenCalled();

    state.samplesSent = 4_800;
    state.sourceDurationSeconds = 0.1;
    state.packetsSent = 5;
    state.bytesSent = 120;
    await vi.advanceTimersByTimeAsync(25);

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith(JSON.stringify({ type: "input_audio_buffer.commit" }));
    expect(harness.stopTrack).toHaveBeenCalledOnce();
    expect(harness.send.mock.invocationCallOrder[0]).toBeLessThan(harness.stopTrack.mock.invocationCallOrder[0] ?? 0);
  });

  it("uses a conservative ready-time fallback when sample duration stats are unavailable", async () => {
    vi.useFakeTimers();
    const state: AudioStatsState = { packetsSent: 0, bytesSent: 0 };
    const harness = createLiveAudioHarness(state);
    const session = await openVoiceRealtimeSession(
      { model: "gpt-4o-transcribe", language: "auto", delay: "low" },
      harness.callbacks
    );

    session.commit();
    state.packetsSent = 1;
    state.bytesSent = 64;
    await vi.advanceTimersByTimeAsync(239);
    expect(harness.send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(11);
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.stopTrack).toHaveBeenCalledOnce();
  });

  it("closes a pending short recording immediately without committing", async () => {
    vi.useFakeTimers();
    const state: AudioStatsState = {
      samplesSent: 0,
      sourceDurationSeconds: 0,
      packetsSent: 0,
      bytesSent: 0
    };
    const harness = createLiveAudioHarness(state);
    const session = await openVoiceRealtimeSession(
      { model: "gpt-4o-transcribe", language: "el", delay: "low" },
      harness.callbacks
    );

    session.commit();
    session.close();
    expect(harness.closeChannel).toHaveBeenCalledOnce();
    expect(harness.closeConnection).toHaveBeenCalledOnce();
    expect(harness.stopTrack).toHaveBeenCalledOnce();

    state.samplesSent = 9_600;
    state.sourceDurationSeconds = 0.2;
    state.packetsSent = 10;
    state.bytesSent = 240;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("coalesces repeated commit requests while waiting for outbound audio", async () => {
    vi.useFakeTimers();
    const state: AudioStatsState = {
      samplesSent: 0,
      sourceDurationSeconds: 0,
      packetsSent: 0,
      bytesSent: 0
    };
    const harness = createLiveAudioHarness(state);
    const session = await openVoiceRealtimeSession(
      { model: "gpt-4o-transcribe", language: "en", delay: "medium" },
      harness.callbacks
    );

    session.commit();
    session.commit();
    state.samplesSent = 4_800;
    state.sourceDurationSeconds = 0.12;
    state.packetsSent = 5;
    state.bytesSent = 120;
    await vi.advanceTimersByTimeAsync(25);
    session.commit();

    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.stopTrack).toHaveBeenCalledOnce();
  });

  it("fails locally without sending an empty commit when no audio is transmitted", async () => {
    vi.useFakeTimers();
    const state: AudioStatsState = {
      samplesSent: 0,
      sourceDurationSeconds: 0,
      packetsSent: 0,
      bytesSent: 0
    };
    const onError = vi.fn();
    const harness = createLiveAudioHarness(state, onError);
    const session = await openVoiceRealtimeSession(
      { model: "gpt-4o-transcribe", language: "en", delay: "xhigh" },
      harness.callbacks
    );

    session.commit();
    await vi.advanceTimersByTimeAsync(2_025);

    expect(harness.send).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("No microphone audio was captured. Check the microphone and try again.");
    expect(harness.closeChannel).toHaveBeenCalledOnce();
    expect(harness.closeConnection).toHaveBeenCalledOnce();
  });

  it("handles GPT-Live session.input_transcript events", async () => {
    const onTranscriptDelta = vi.fn();
    const onTranscriptComplete = vi.fn();
    const state: AudioStatsState = {
      samplesSent: 4_800,
      sourceDurationSeconds: 0.1,
      packetsSent: 5,
      bytesSent: 120
    };
    const harness = createLiveAudioHarness(state);
    const session = await openVoiceRealtimeSession(
      { model: "gpt-live-1", language: "auto", delay: "minimal" },
      { onTranscriptDelta, onTranscriptComplete }
    );

    harness.channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "session.input_transcript.delta", delta: "γειά σου " })
    }));
    expect(onTranscriptDelta).toHaveBeenCalledWith("γειά σου ");

    harness.channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "session.input_transcript.done", transcript: "γειά σου κόσμε" })
    }));
    expect(onTranscriptComplete).toHaveBeenCalledWith("γειά σου κόσμε");
    expect(harness.closeChannel).toHaveBeenCalledOnce();
    expect(harness.closeConnection).toHaveBeenCalledOnce();
  });

  it("dictates only what the operator said: the model's reply never enters the transcript and no conversation is requested", async () => {
    const onTranscriptDelta = vi.fn();
    const onTranscriptComplete = vi.fn();
    const harness = createLiveAudioHarness({ samplesSent: 4_800, sourceDurationSeconds: 0.1, packetsSent: 5, bytesSent: 120 });
    await openVoiceRealtimeSession(
      { model: "gpt-live-1", language: "auto", delay: "minimal", opening: "Hello!", prompt: "Be a helpful assistant.", delegatedModel: "gpt-6-astra",
        delegatedType: "responses", delegatedReasoningEffort: "xhigh", delegatedWebSearch: true, delegatedPrompt: "Answer questions." },
      { onTranscriptDelta, onTranscriptComplete }
    );
    const request = (harness.createVoiceRealtimeCall.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]![0];
    for (const field of ["opening", "prompt", "delegatedModel", "delegatedType", "delegatedReasoningEffort", "delegatedWebSearch", "delegatedPrompt"]) {
      expect(request).not.toHaveProperty(field);
    }
    for (const [type, delta] of [["session.input_transcript.delta", "Set the layout "], ["session.output_transcript.delta", "Got it, one column."],
      ["response.audio_transcript.delta", "Sure!"], ["session.input_transcript.delta", "to one column."]]) {
      harness.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type, delta }) }));
    }
    harness.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "session.output_transcript.done", transcript: "Got it, one column." }) }));
    expect(onTranscriptComplete).not.toHaveBeenCalled();
    expect(onTranscriptDelta).toHaveBeenLastCalledWith("Set the layout to one column.");
  });

  it("sends session.input_audio.mute on commit and session.close on close for gpt-live models", async () => {
    vi.useFakeTimers();
    const state: AudioStatsState = {
      samplesSent: 0,
      sourceDurationSeconds: 0,
      packetsSent: 0,
      bytesSent: 0
    };
    const harness = createLiveAudioHarness(state);
    const session = await openVoiceRealtimeSession(
      { model: "gpt-live-1", language: "en", delay: "minimal" },
      harness.callbacks
    );

    state.samplesSent = 4_800;
    state.sourceDurationSeconds = 0.12;
    state.packetsSent = 5;
    state.bytesSent = 120;

    session.commit();
    await vi.advanceTimersByTimeAsync(25);

    expect(harness.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.input_audio.mute" }));
    expect(harness.stopTrack).toHaveBeenCalledOnce();

    session.close();
    expect(harness.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.close" }));
    expect(harness.closeChannel).toHaveBeenCalledOnce();
    expect(harness.closeConnection).toHaveBeenCalledOnce();
  });

  it("uses fallback transcript completion on commit when server done event is delayed", async () => {
    vi.useFakeTimers();
    const onTranscriptComplete = vi.fn();
    const state: AudioStatsState = {
      samplesSent: 0,
      sourceDurationSeconds: 0,
      packetsSent: 0,
      bytesSent: 0
    };
    const harness = createLiveAudioHarness(state);
    const session = await openVoiceRealtimeSession(
      { model: "gpt-live-1", language: "auto", delay: "minimal" },
      { onTranscriptComplete }
    );

    state.samplesSent = 4_800;
    state.sourceDurationSeconds = 0.12;
    state.packetsSent = 5;
    state.bytesSent = 120;

    harness.channel.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ type: "session.input_transcript.delta", delta: "Hello world" })
    }));

    session.commit();
    await vi.advanceTimersByTimeAsync(25);
    expect(harness.send).toHaveBeenCalledWith(JSON.stringify({ type: "session.input_audio.mute" }));

    // Advance past the 2500ms fallback done timer
    await vi.advanceTimersByTimeAsync(2_600);

    expect(onTranscriptComplete).toHaveBeenCalledWith("Hello world");
    expect(harness.closeChannel).toHaveBeenCalledOnce();
    expect(harness.closeConnection).toHaveBeenCalledOnce();
  });
});

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  json() {
    return this.sent.filter((entry): entry is string => typeof entry === "string").map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

function createSocketVoiceHarness() {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  const processors: Array<{ onaudioprocess: ((event: unknown) => void) | null }> = [];
  class FakeAudioContext {
    state = "running";
    sampleRate = 16000;
    destination = {};
    resume = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createScriptProcessor() {
      const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
      processors.push(processor);
      return processor;
    }
    createGain() {
      return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    }
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);

  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ kind: "audio", readyState: "live", stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => stream);
  const createVoiceRealtimeCall = vi.fn(async () => ({ websocketUrl: "/ws/voice-google" }));
  const createLocalVoiceSession = vi.fn(async () => ({ websocket_url: "ws://127.0.0.1/local-voice" }));
  installSpaceRuntime({
    ...liveRuntime,
    api: { createVoiceRealtimeCall, createLocalVoiceSession } as unknown as SpaceRuntime["api"],
    platform: { ...liveRuntime.platform, userMediaSupported: true, getUserMedia }
  });
  const speak = () => processors.at(-1)?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(160) } });
  return { getUserMedia, stopTrack, createVoiceRealtimeCall, createLocalVoiceSession, speak, socket: () => FakeSocket.instances.at(-1)! };
}

describe("Voice Realtime deferred microphone capture", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects a pre-warmed Google session without the microphone and sends no audio until capture starts", async () => {
    vi.useFakeTimers();
    const harness = createSocketVoiceHarness();
    const callbacks = { onTranscriptDelta: vi.fn(), onTranscriptComplete: vi.fn(), onError: vi.fn() };
    const session = await openVoiceRealtimeSession(
      { provider: "google", model: "gemini-3.8-live", language: "auto", delay: "low" },
      callbacks,
      { deferCapture: true }
    );
    const socket = harness.socket();
    socket.open();
    socket.receive({ setupComplete: {} });
    socket.receive({ serverContent: { inputTranscription: { text: "said before the click" } } });

    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(callbacks.onTranscriptDelta).not.toHaveBeenCalled();
    expect(socket.json().some((message) => "realtimeInput" in message)).toBe(false);

    await session.startCapture();
    expect(harness.getUserMedia).toHaveBeenCalledOnce();
    harness.speak();
    expect(socket.json().filter((message) => "realtimeInput" in message)).toHaveLength(1);

    socket.receive({ serverContent: { inputTranscription: { text: "Γεια σου" } } });
    socket.receive({ serverContent: { inputTranscription: { text: "deploy" } } });
    session.commit();
    expect(harness.stopTrack).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onTranscriptComplete).toHaveBeenCalledExactlyOnceWith("Γεια σου deploy");
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("asks Gemini for input transcription in Greek and English and never submits the model's own reply", async () => {
    vi.useFakeTimers();
    const harness = createSocketVoiceHarness();
    const callbacks = { onTranscriptDelta: vi.fn(), onTranscriptComplete: vi.fn(), onError: vi.fn() };
    const session = await openVoiceRealtimeSession({ provider: "google", model: "gemini-3.8-live", language: "auto", delay: "low" }, callbacks);
    expect(harness.getUserMedia).toHaveBeenCalledOnce();
    const socket = harness.socket();
    socket.open();
    const setup = socket.json()[0]?.setup as Record<string, unknown>;
    expect(setup.inputAudioTranscription).toEqual({ languageCodes: ["el-GR", "el", "en-US", "en"] });
    expect(JSON.stringify(setup.systemInstruction)).toContain("in Latin script exactly as spoken");

    socket.receive({ setupComplete: {} });
    socket.receive({ serverContent: { outputTranscription: { text: "Sure, I can help with that." }, modelTurn: { parts: [{ text: "Hello!" }] } } });
    expect(callbacks.onTranscriptDelta).not.toHaveBeenCalled();
    session.commit();
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onTranscriptComplete).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^No speech was recognized/));
  });

  it("narrows Gemini input transcription to the chosen language", async () => {
    const harness = createSocketVoiceHarness();
    await openVoiceRealtimeSession({ provider: "google", model: "gemini-3.8-live", language: "el", delay: "low" }, {}, { deferCapture: true });
    harness.socket().open();
    expect((harness.socket().json()[0]?.setup as Record<string, unknown>).inputAudioTranscription).toEqual({ languageCodes: ["el-GR", "el"] });
  });

  it("explains why Google voice input stopped when the provider's credits are used up", async () => {
    const harness = createSocketVoiceHarness();
    const callbacks = { onError: vi.fn() };
    await openVoiceRealtimeSession({ provider: "google", model: "gemini-3.8-live", language: "auto", delay: "low" }, callbacks, { deferCapture: true });
    harness.socket().open();
    harness.socket().onclose?.({ code: 1011, reason: "provider_quota_exhausted" });
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^Google Gemini Live is unavailable: the credits of Space's voice key are used up/));
  });

  it("releases the microphone when a direct Google start fails, and refuses capture after close", async () => {
    const harness = createSocketVoiceHarness();
    harness.createVoiceRealtimeCall.mockRejectedValueOnce(new Error("Voice provider unavailable"));
    await expect(openVoiceRealtimeSession({ provider: "google", model: "gemini-3.8-live", language: "auto", delay: "low" }, {}))
      .rejects.toThrow("Voice provider unavailable");
    expect(harness.stopTrack).toHaveBeenCalled();

    const session = await openVoiceRealtimeSession({ provider: "google", model: "gemini-3.8-live", language: "auto", delay: "low" }, {}, { deferCapture: true });
    session.close();
    await expect(session.startCapture()).rejects.toThrow(/closed before recording started/);
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("starts the local provider only once the microphone opens and reports a dropped connection", async () => {
    const harness = createSocketVoiceHarness();
    const callbacks = { onTranscriptComplete: vi.fn(), onError: vi.fn() };
    const session = await openVoiceRealtimeSession({ provider: "local", model: "qwen3-greek", language: "auto", delay: "low" }, callbacks, { deferCapture: true });
    const socket = harness.socket();
    socket.open();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(socket.json()).toEqual([]);

    await session.startCapture();
    expect(socket.json()).toEqual([{ type: "start", sample_rate: 16000, language: "auto" }]);
    harness.speak();
    expect(socket.sent.filter((entry) => typeof entry !== "string")).toHaveLength(1);

    socket.onclose?.();
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith("Local voice provider connection closed unexpectedly.");
    expect(harness.stopTrack).toHaveBeenCalled();
  });

  it("refuses to pre-warm OpenAI because its WebRTC offer needs the microphone", async () => {
    const harness = createSocketVoiceHarness();
    expect(supportsDeferredVoiceCapture({ provider: "openai", model: "gpt-live-transcribe" })).toBe(false);
    expect(supportsDeferredVoiceCapture({ provider: "google", model: "gemini-3.8-live" })).toBe(true);
    await expect(openVoiceRealtimeSession({ provider: "openai", model: "gpt-live-transcribe", language: "auto", delay: "low" }, {}, { deferCapture: true }))
      .rejects.toThrow("This voice provider cannot connect before recording starts.");
    expect(harness.getUserMedia).not.toHaveBeenCalled();
  });
});
