import { setSpaceVolume } from '../src/space-audio.js';
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBrowserAudio } from "../src/features/browser-pane/useBrowserAudio.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
const mocks = vi.hoisted(() => ({ browserAudioStreamTicket: vi.fn(), browserAudioWebSocketUrl: vi.fn() }));
vi.mock("../src/api.js", () => ({ api: mocks }));
class Socket extends EventTarget {
  static all: Socket[] = [];
  binaryType = "";
  constructor(_url: string) { super(); Socket.all.push(this); }
  close() { this.dispatchEvent(new Event("close")); }
  message(data: unknown) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
class Context {
  static all: Context[] = [];
  state = "suspended";
  onstatechange: (() => void) | null = null;
  currentTime = 0;
  createBuffer = vi.fn(() => ({ duration: .04, getChannelData: () => new Float32Array(1920) }));
  resume = vi.fn(async () => { if (Context.allowed) { this.state = "running"; this.onstatechange?.(); } });
  close = vi.fn(async () => { this.state = "closed"; });
  createBufferSource = vi.fn(() => ({ buffer: null, connect: vi.fn(), start: vi.fn() }));
  destination = {};
  gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  createGain = vi.fn(() => this.gain);
  static allowed = false;
  constructor() { Context.all.push(this); }
}
function Harness({ paneId = "pane:audio" }) {
  const { audioState } = useBrowserAudio(paneId, "browser:audio");
  return <output>{audioState}</output>;
}
beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  localStorage.clear();
  Context.all = []; Context.allowed = false; Socket.all = [];
  vi.stubGlobal("WebSocket", Socket); vi.stubGlobal("AudioContext", Context);
  mocks.browserAudioStreamTicket.mockReset().mockResolvedValue({ websocket: { sessionId: "browser:audio" } });
  mocks.browserAudioWebSocketUrl.mockReturnValue("ws://localhost/audio");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("subscribes once across Internet and YouTube and reconnects after remount", async () => {
  const view = render(<><Harness /><Harness paneId="pane:second" /></>);
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  expect(mocks.browserAudioStreamTicket).toHaveBeenCalledTimes(1);
  view.unmount();
  render(<Harness />);
  await waitFor(() => expect(Socket.all).toHaveLength(2));
});
it("drops blocked audio and resumes on user input without replaying accumulated samples", async () => {
  render(<Harness />);
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  await act(async () => Socket.all[0]!.message(JSON.stringify({ type: "audioReady", paneId: "pane:audio", sessionId: "browser:audio", streamId: "audio:proof", encoding: "pcm_s16le", sampleRate: 48000, channels: 2 })));
  expect(screen.getByText("blocked")).toBeTruthy();
  act(() => Socket.all[0]!.message(new ArrayBuffer(7680)));
  expect(Context.all[0]!.createBuffer).not.toHaveBeenCalled();
  Context.allowed = true;
  fireEvent.pointerDown(window);
  await screen.findByText("playing");
  act(() => Socket.all[0]!.message(new ArrayBuffer(7680)));
  expect(Context.all[0]!.createBufferSource).toHaveBeenCalledTimes(1);
});

it("restores playing state when a closed audio socket reconnects", async () => {
  Context.allowed = true;
  render(<Harness />);
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  const ready = JSON.stringify({ type: "audioReady", paneId: "pane:audio", sessionId: "browser:audio", streamId: "audio:proof", encoding: "pcm_s16le", sampleRate: 48000, channels: 2 });
  await act(async () => Socket.all[0]!.message(ready));
  await screen.findByText("playing");
  vi.useFakeTimers();
  act(() => Socket.all[0]!.close());
  expect(screen.getByText("connecting")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(Socket.all).toHaveLength(2);
  await act(async () => Socket.all[1]!.message(ready));
  expect(screen.getByText("playing")).toBeTruthy();
  expect(Context.all).toHaveLength(1);
  vi.useRealTimers();
});

it("routes the mixed browser audio through master gain without reconnecting", async () => {
  setSpaceVolume(0.62);
  Context.allowed = true;
  const view = render(<Harness />);
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  await act(async () => Socket.all[0]!.message(JSON.stringify({ type: "audioReady", paneId: "pane:audio", sessionId: "browser:audio", streamId: "audio:proof", encoding: "pcm_s16le", sampleRate: 48000, channels: 2 })));
  const context = Context.all[0]!;
  expect(context.gain.gain.value).toBe(0.62);
  expect(context.gain.connect).toHaveBeenCalledWith(context.destination);
  act(() => Socket.all[0]!.message(new ArrayBuffer(7680)));
  expect(context.createBufferSource.mock.results[0]!.value.connect).toHaveBeenCalledWith(context.gain);
  act(() => setSpaceVolume(0));
  expect(context.gain.gain.value).toBe(0);
  expect(Context.all).toHaveLength(1);
  expect(Socket.all).toHaveLength(1);
  view.unmount();
  expect(context.gain.disconnect).toHaveBeenCalledOnce();
  setSpaceVolume(1);
  expect(context.gain.gain.value).toBe(0);
});
