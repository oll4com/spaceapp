// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/live-api.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import { liveRuntime } from "../src/live/live-runtime.js";
import { captureLiveVisual } from "../src/features/live-pane/live-visual-capture.js";
import { captureClientScreenshot } from "../src/features/room-agent/space-control-client.js";
import { executeLiveFunction } from "../src/features/live-pane/live-session.js";

beforeEach(() => { installSpaceRuntime(liveRuntime); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function mediaFixture(width = 1920, height = 1080) {
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  const track = { stop: vi.fn(), readyState: "live" };
  const audioTrack = { stop: vi.fn() };
  const stream = { getTracks: () => [track, audioTrack], getVideoTracks: () => [track] } as unknown as MediaStream;
  for (const [key, value] of Object.entries({ videoWidth: width, videoHeight: height, readyState: 2 })) Object.defineProperty(video, key, { configurable: true, value });
  vi.spyOn(video, "play").mockResolvedValue();vi.spyOn(video, "pause").mockImplementation(() => {});
  const drawImage = vi.fn();
  vi.spyOn(canvas, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/jpeg;base64,real-frame-fixture");
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string, options?: ElementCreationOptions) => tag === "video" ? video : tag === "canvas" ? canvas : createElement(tag, options));
  vi.spyOn(liveRuntime.platform, "getDisplayMedia").mockResolvedValue(stream);
  vi.spyOn(liveRuntime.platform, "getUserMedia").mockResolvedValue(stream);
  return { video, canvas, track, audioTrack, stream, drawImage, signal: new AbortController() };
}
describe("Real operator-selected visual capture", () => {
  it.each(["screen", "camera"] as const)("captures %s video pixels and stops all tracks", async source => {
    const f = mediaFixture(1000, 2000);
    const result = await captureLiveVisual(source, f.signal.signal);
    expect(result).toMatchObject({ type: "image", filename: `${source}-capture.jpg` });
    expect(f.canvas.width).toBe(360);expect(f.canvas.height).toBe(720);
    expect(f.drawImage).toHaveBeenCalledWith(f.video, 0, 0, 360, 720);
    expect(source === "screen" ? liveRuntime.platform.getDisplayMedia : liveRuntime.platform.getUserMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(f.track.stop).toHaveBeenCalledOnce();expect(f.audioTrack.stop).toHaveBeenCalledOnce();
    expect(f.video.srcObject).toBeNull();
  });
  it("shrinks an image until it fits the voice relay limit", async () => {
    const f = mediaFixture(1920, 1080);
    vi.mocked(f.canvas.toDataURL).mockImplementation((_type?: string, quality?: unknown) =>
      `data:image/jpeg;base64,${"A".repeat(f.canvas.width >= 960 ? 90_000 : 30_000)}${String(quality)}`);
    const result = await captureLiveVisual("screen", f.signal.signal);
    expect(result.dataUrl.length).toBeLessThanOrEqual(60_000);
    expect(f.canvas.width).toBe(640);
    expect(f.track.stop).toHaveBeenCalledOnce();
  });
  it("releases every track when video playback fails", async () => {
    const f = mediaFixture();vi.mocked(f.video.play).mockRejectedValue(new Error("Video failed"));
    await expect(captureLiveVisual("screen", f.signal.signal)).rejects.toThrow("Video failed");
    expect(f.drawImage).not.toHaveBeenCalled();
    expect(f.track.stop).toHaveBeenCalledOnce();expect(f.audioTrack.stop).toHaveBeenCalledOnce();
  });
  it("never claims a blank canvas as a screenshot", async () => {
    const f = mediaFixture();vi.mocked(f.canvas.getContext).mockReturnValue(null);
    await expect(captureLiveVisual("screen", f.signal.signal)).rejects.toThrow("Image capture is unavailable");
    expect(f.canvas.toDataURL).not.toHaveBeenCalled();expect(f.track.stop).toHaveBeenCalledOnce();
  });
  it("cleans up after image encoding fails", async () => {
    const f = mediaFixture();vi.mocked(f.canvas.toDataURL).mockImplementation(() => { throw new Error("Encoding failed"); });
    await expect(captureLiveVisual("camera", f.signal.signal)).rejects.toThrow("Encoding failed");
    expect(f.track.stop).toHaveBeenCalledOnce();expect(f.audioTrack.stop).toHaveBeenCalledOnce();
  });
  it("stops a stream whose permission resolves after the pane was closed", async () => {
    const f = mediaFixture();let resolve!: (stream: MediaStream) => void;
    vi.mocked(liveRuntime.platform.getDisplayMedia).mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = captureLiveVisual("screen", f.signal.signal);
    f.signal.abort();resolve(f.stream);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.track.stop).toHaveBeenCalledOnce();expect(f.audioTrack.stop).toHaveBeenCalledOnce();expect(f.video.play).not.toHaveBeenCalled();
  });
  it("bounds missing-frame waits and clears its timer on failure", async () => {
    vi.useFakeTimers();const f = mediaFixture(0, 0);
    const pending = captureLiveVisual("screen", f.signal.signal);
    const outcome = expect(pending).rejects.toThrow("did not produce a video frame");
    await vi.advanceTimersByTimeAsync(5000);await outcome;
    expect(f.track.stop).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels frame waiting without leaving a timer or capture track", async () => {
    vi.useFakeTimers();const f = mediaFixture(0, 0);
    const pending = captureLiveVisual("screen", f.signal.signal);
    const outcome = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);f.signal.abort();await outcome;
    expect(f.track.stop).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it("does not draw DOM diagrams for MCP screenshots", () => {
    const create = vi.spyOn(document, "createElement");
    expect(captureClientScreenshot("room:screen")).toMatchObject({ ok: false, evidence: { applied: false } });
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["space_capture_screen", "space_screenshot"])("%s fails honestly without hidden vision calls or provider fallback", async name => {
    const capture = vi.spyOn(api, "screenshotControlMcp");
    const analyze = vi.spyOn(api, "analyzeLiveAttachment");
    const onTranscriptUpdate = vi.fn();
    const result = await executeLiveFunction(name, "{}", { roomId: "room:screen", callbacks: { onTranscriptUpdate } });
    expect(result).toContain("Automatic screen capture is unavailable");
    expect(capture).not.toHaveBeenCalled();expect(analyze).not.toHaveBeenCalled();
    expect(onTranscriptUpdate.mock.calls.some(([event]) => event.toolCall?.status === "error")).toBe(true);
    expect(onTranscriptUpdate.mock.calls.some(([event]) => event.toolCall?.status === "done")).toBe(false);
  });
});
