// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveRecorder, LIVE_RECORDING_MAX_MS, LIVE_RECORDING_VIDEO_BRIEF, type LiveRecorderState } from "../src/features/live-pane/live-recorder.js";
import type { LiveSessionHandle } from "../src/features/live-pane/live-session.js";

function fakeStream(kind: "audio" | "video", label: string) {
  const track = { kind, label, readyState: "live", enabled: true };
  return { label, getAudioTracks: () => (kind === "audio" ? [track] : []), getVideoTracks: () => (kind === "video" ? [track] : []), getTracks: () => [track] } as unknown as MediaStream;
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn((_timeslice?: number) => { this.state = "recording"; });
  stop = vi.fn(() => { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["webm-bytes"]) }); this.onstop?.(); });
  constructor(public stream: MediaStream, public options: MediaRecorderOptions) { FakeRecorder.instances.push(this); }
}

function harness(input: { video?: boolean; playback?: MediaStream | null } = {}) {
  const connections: Array<{ from: string; to: unknown }> = [];
  const mixDestination = { stream: fakeStream("audio", "mix"), connect: vi.fn() };
  const context = {
    state: "running",
    close: vi.fn(async () => undefined),
    createMediaStreamDestination: vi.fn(() => mixDestination),
    createMediaStreamSource: vi.fn((stream: MediaStream & { label?: string }) => ({
      connect: vi.fn((to: unknown) => connections.push({ from: stream.label ?? "?", to })), disconnect: vi.fn()
    }))
  };
  const microphone = fakeStream("audio", "mic");
  const playback = input.playback === undefined ? fakeStream("audio", "assistant") : input.playback;
  const notify = vi.fn(() => true);
  const handle = { microphone, tapPlayback: playback ? () => playback : undefined, notify, close: vi.fn(), setMuted: vi.fn(), isMuted: () => false, sendTextMessage: vi.fn() } as unknown as LiveSessionHandle;
  const states: LiveRecorderState[] = [];
  const upload = vi.fn(async (_input: { roomId: string; paneId?: string | null; source: string; files: File[] }) => ({ artifacts: [{ id: "artifact:rec-1", kind: "VIDEO" }] as any }));
  const requestVideo = vi.fn(async (_paneId: string, _input: unknown) => ({ request: { id: "video_request:1", status: "QUEUED" }, assets: [], videoPaneId: "pane:video", runStarted: true } as any));
  const recorder = createLiveRecorder({
    roomId: "room:1", paneId: "pane:live", getHandle: () => handle, onState: (state) => states.push(state),
    upload: upload as any, requestVideo: requestVideo as any,
    createAudioContext: () => context as unknown as AudioContext,
    createRecorder: (stream, options) => new FakeRecorder(stream, options) as unknown as MediaRecorder,
    now: () => 1_700_000_000_000
  });
  if (input.video) recorder.setRealView(fakeStream("video", "screen"));
  return { recorder, states, upload, requestVideo, context, connections, mixDestination, notify, handle };
}

beforeEach(() => {
  FakeRecorder.instances = [];
  vi.stubGlobal("MediaStream", class { constructor(public tracks: unknown[]) {} getAudioTracks() { return this.tracks.filter((t: any) => t.kind === "audio"); } getVideoTracks() { return this.tracks.filter((t: any) => t.kind === "video"); } });
  vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
  vi.useFakeTimers();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Live session recorder", () => {
  it("mixes the microphone and the tapped assistant voice into one track and records the Real View with it", () => {
    const h = harness({ video: true });
    h.recorder.start();
    expect(h.connections.map((c) => c.from).sort()).toEqual(["assistant", "mic"]);
    expect(h.connections.every((c) => c.to === h.mixDestination)).toBe(true);
    const active = FakeRecorder.instances[0]!;
    expect(active.options).toEqual({ mimeType: "video/webm;codecs=vp9,opus", videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 96_000 });
    expect((active.stream as any).tracks.map((t: any) => t.label)).toEqual(["screen", "mix"]);
    expect(active.start).toHaveBeenCalledWith(1000);
    expect(h.recorder.getState()).toMatchObject({ status: "recording", video: true, startedAt: 1_700_000_000_000 });
  });

  it("records audio only as opus webm when the Real View is off", () => {
    const h = harness();
    h.recorder.start();
    const active = FakeRecorder.instances[0]!;
    expect(active.options.mimeType).toBe("audio/webm;codecs=opus");
    expect(active.stream).toBe(h.mixDestination.stream);
    expect(h.recorder.getState()).toMatchObject({ status: "recording", video: false });
  });

  it("stops at the 10-minute cap and uploads the webm as a LIVE_RECORDING of the pane", async () => {
    const h = harness({ video: true });
    h.recorder.start();
    vi.advanceTimersByTime(LIVE_RECORDING_MAX_MS - 1);
    expect(FakeRecorder.instances[0]!.stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(FakeRecorder.instances[0]!.stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.recorder.getState().status).toBe("saved"));
    expect(h.upload).toHaveBeenCalledTimes(1);
    const call = h.upload.mock.calls[0]![0];
    expect(call).toMatchObject({ roomId: "room:1", paneId: "pane:live", source: "LIVE_RECORDING" });
    expect(call.files[0]!.name).toBe("live-2023-11-14T22-13-20-000Z.webm");
    expect(call.files[0]!.type).toBe("video/webm");
    expect(h.context.close).toHaveBeenCalled();
    expect(h.recorder.getState().artifact).toMatchObject({ id: "artifact:rec-1" });
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("artifact:rec-1"), "live-recording:artifact:rec-1");
  });

  it("posts the video request for the saved recording from 'Make a video from it'", async () => {
    const h = harness();
    h.recorder.start();
    h.recorder.stop();
    await vi.waitFor(() => expect(h.recorder.getState().status).toBe("saved"));
    expect(h.upload.mock.calls[0]![0].files[0]!.type).toBe("audio/webm");
    await h.recorder.makeVideo();
    expect(h.requestVideo).toHaveBeenCalledWith("pane:live", { brief: LIVE_RECORDING_VIDEO_BRIEF, sources: [{ artifactId: "artifact:rec-1" }] });
    expect(h.recorder.getState().videoRequestId).toBe("video_request:1");
  });

  it("reports an error instead of recording when the session has no microphone or voice to tap", () => {
    const h = harness({ playback: null });
    h.recorder.start();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(h.recorder.getState()).toMatchObject({ status: "error", reason: "Start the Live conversation before recording it." });
    expect(h.context.close).toHaveBeenCalled();
  });

  it("re-taps the new session after a reconnect while recording", () => {
    const h = harness();
    h.recorder.start();
    const before = h.connections.length;
    h.recorder.retap();
    expect(h.connections.length).toBe(before + 2);
    expect(h.recorder.getState().status).toBe("recording");
  });
});
