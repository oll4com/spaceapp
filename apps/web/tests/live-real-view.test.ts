import { describe, expect, it, vi } from "vitest";
import { createRealView, type GrabbedFrame, type RealViewFrame, type RealViewState } from "../src/features/live-pane/live-real-view.js";

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  stop = vi.fn(() => { this.readyState = "ended"; });
  end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
}
function fakeStream() {
  const track = new FakeTrack();
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream };
}
function harness(options: { frames?: Array<GrabbedFrame | null>; send?: (frame: RealViewFrame) => Promise<void>; getMedia?: () => Promise<MediaStream>; clock?: number[] } = {}) {
  const { track, stream } = fakeStream();
  const states: RealViewState[] = [];
  let tick: (() => void) | null = null;
  let time = 1_000;
  const frames = [...(options.frames ?? [])];
  const sent: RealViewFrame[] = [];
  const video = { play: vi.fn(async () => undefined), pause: vi.fn(), muted: false, playsInline: false, srcObject: null as unknown } as unknown as HTMLVideoElement;
  const view = createRealView({
    getMedia: options.getMedia ?? (async () => stream),
    send: options.send ?? (async (frame) => { sent.push(frame); }),
    onState: (state) => states.push(state),
    grab: () => frames.length ? frames.shift()! : { dataUrl: "data:image/jpeg;base64,AAAA", signature: [time % 255] },
    createVideo: () => video,
    now: () => options.clock?.length ? options.clock.shift()! : time,
    setInterval: (callback) => { tick = callback; return 1; },
    clearInterval: () => { tick = null; }
  });
  return { view, track, stream, states, sent, video, tickNow: () => tick?.(), advance: (ms: number) => { time += ms; }, hasTimer: () => tick !== null };
}
const frame = (signature: number[]): GrabbedFrame => ({ dataUrl: "data:image/jpeg;base64,AAAA", signature });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Real View", () => {
  it("sends timestamped frames from the chosen source and skips unchanged ones", async () => {
    const h = harness({ frames: [frame([10, 10]), frame([10, 11]), frame([90, 90])] });
    await h.view.start("screen");
    expect(h.states.slice(0, 2).map((state) => state.status)).toEqual(["starting", "live"]);
    await flush();
    h.tickNow(); await flush();
    h.tickNow(); await flush();
    expect(h.sent.map((item) => [item.source, item.sequence, item.capturedAt])).toEqual([["screen", 1, 1000], ["screen", 2, 1000]]);
    expect(h.sent[0]!.filename).toMatch(/^real-view-screen-1970-01-01T00-00-01-000Z\.jpg$/);
    expect(h.view.getState()).toMatchObject({ framesSent: 2, framesSkipped: 1, lastFrameAt: 1000 });
  });

  it("keeps at most one frame in flight and drops frames that became stale", async () => {
    let release!: () => void;
    const h = harness({ send: () => new Promise<void>((resolve) => { release = resolve; }) });
    await h.view.start("camera");
    h.tickNow(); h.tickNow();
    expect(h.view.getState()).toMatchObject({ framesSent: 0, framesSkipped: 2 });
    await flush(); release(); await flush();
    expect(h.view.getState().framesSent).toBe(1);
    const stale = harness({ clock: [1_000, 10_000] });
    await stale.view.start("screen");
    expect(stale.sent).toHaveLength(0);
    expect(stale.view.getState().framesSkipped).toBe(1);
  });

  it("stops every track at once on Stop, when the user ends the share, or when permission is refused", async () => {
    const h = harness();
    await h.view.start("screen");
    h.view.stop();
    expect(h.track.stop).toHaveBeenCalled();
    expect(h.hasTimer()).toBe(false);
    expect(h.view.getState()).toMatchObject({ status: "stopped", reason: null });
    const ended = harness();
    await ended.view.start("screen");
    ended.track.end();
    expect(ended.view.getState()).toMatchObject({ status: "stopped", reason: "The capture source was closed." });
    expect(ended.hasTimer()).toBe(false);
    const refused = harness({ getMedia: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
    await refused.view.start("camera");
    expect(refused.view.getState()).toMatchObject({ status: "error", reason: "Permission to capture was not granted." });
  });

  it("releases a stream that arrives after Stop", async () => {
    let resolve!: (stream: MediaStream) => void;
    const late = fakeStream();
    const h = harness({ getMedia: () => new Promise((done) => { resolve = done; }) });
    const starting = h.view.start("screen");
    h.view.stop();
    resolve(late.stream);
    await starting;
    expect(late.track.stop).toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    expect(h.hasTimer()).toBe(false);
  });
});
