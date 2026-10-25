// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { captureSnip, releaseSnipSession } from "../src/features/snip-tool/snip-capture.js";
const { getDisplayMedia, runtimeState } = vi.hoisted(() => ({ getDisplayMedia: vi.fn(), runtimeState: { kind: "live" } }));
vi.mock("../src/runtime/SpaceRuntime.js", () => ({ getSpaceRuntime: () => ({ kind: runtimeState.kind, platform: { displayMediaSupported: true, getDisplayMedia } }) }));
const png = "data:image/png;base64,aGVsbG8=";
beforeEach(() => {
  runtimeState.kind = "live";
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); delete (window as any).spaceDesktop; delete (window as any).SpaceNative; delete (window as any).__spaceNativeCaptureCallbacks; delete (window as any).__onSpaceNativeCapture; });
describe("snip capture lifecycle", () => {
  it.each(["desktop", "android", "browser"])("blocks %s capture in the demo before touching native sources", async source => {
    runtimeState.kind = "demo";
    const nativeCapture = vi.fn(() => { throw new Error("Native capture was reached"); });
    if (source === "desktop") (window as any).spaceDesktop = { capturePage: nativeCapture };
    if (source === "android") (window as any).SpaceNative = { requestPageCapture: nativeCapture };
    getDisplayMedia.mockRejectedValue(new Error("Browser capture was reached"));
    const overlay = document.createElement("div");
    overlay.style.opacity = "0.8";
    await expect(captureSnip(overlay, new AbortController().signal)).rejects.toThrow("Screen capture is disabled in demo mode.");
    expect(nativeCapture).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(overlay.style.opacity).toBe("0.8");
  });
  it("hides the overlay for native capture and restores it", async () => {
    const overlay = document.createElement("div");
    (window as any).spaceDesktop = { capturePage: vi.fn(async () => {
      expect(overlay.style.opacity).toBe("0"); return { success: true, dataUrl: png };
    }) };
    const result = await captureSnip(overlay, new AbortController().signal);
    expect(result.type).toBe("image/png"); expect(overlay.style.opacity).toBe("");
    expect((window as any).spaceDesktop.capturePage).toHaveBeenCalledWith();
  });
  it("fails native capture explicitly rather than silently switching to another source", async () => {
    (window as any).spaceDesktop = { capturePage: vi.fn().mockResolvedValue({ success: false, reason: "Source unavailable" }) };
    const overlay = document.createElement("div");
    await expect(captureSnip(overlay, new AbortController().signal)).rejects.toThrow("Source unavailable");
    expect(getDisplayMedia).not.toHaveBeenCalled(); expect(overlay.style.opacity).toBe("");
  });
  it("stops a stream whose permission prompt resolves after cancellation", async () => {
    let resolve!: (stream: MediaStream) => void;
    getDisplayMedia.mockImplementation(() => new Promise(r => { resolve = r; }));
    const stop = vi.fn(), controller = new AbortController();
    const pending = captureSnip(document.createElement("div"), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    resolve({ getTracks: () => [{ stop }], getVideoTracks: () => [] } as any);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });
  it("does not reprompt when the user refuses sharing", async () => {
    getDisplayMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await expect(captureSnip(document.createElement("div"), new AbortController().signal)).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(getDisplayMedia).toHaveBeenCalledOnce();
  });
  it("cleans up mobile callback on cancellation and rejects late results", async () => {
    let id = "";
    (window as any).SpaceNative = { requestPageCapture: vi.fn((_x, _y, _w, _h, value) => { id = value; }), getCapturedData: vi.fn(() => png) };
    const controller = new AbortController(), overlay = document.createElement("div");
    const pending = captureSnip(overlay, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(id).not.toBe(""));
    controller.abort(); await rejected;
    expect((window as any).__spaceNativeCaptureCallbacks[id]).toBeUndefined();
    expect(overlay.style.opacity).toBe("");
    (window as any).__onSpaceNativeCapture(id, true);
    expect((window as any).SpaceNative.getCapturedData).not.toHaveBeenCalled();
  });
  it("reuses a confirmed current-tab stream until closing and detects source switches", async () => {
    let sourceHandle = "own-tab";
    const track = { readyState: "live", getCaptureHandle: () => ({ handle: sourceHandle }), stop: vi.fn(function () { track.readyState = "ended"; }) };
    getDisplayMedia.mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] });
    vi.stubGlobal("navigator", { mediaDevices: { setCaptureHandleConfig: vi.fn() } });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 800 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 600 });
    (HTMLVideoElement.prototype as any).requestVideoFrameCallback = (cb: () => void) => { cb(); return 1; };
    (HTMLVideoElement.prototype as any).cancelVideoFrameCallback = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as any);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(cb => cb(new Blob(["png"])));
    const session = { stream: null, video: null, handle: "own-tab" }, onSource = vi.fn();
    const overlay = document.createElement("div");
    await captureSnip(overlay, new AbortController().signal, { session, onSource });
    expect(onSource).toHaveBeenLastCalledWith(true); expect(track.stop).not.toHaveBeenCalled();
    sourceHandle = "other-tab";
    await captureSnip(overlay, new AbortController().signal, { session, onSource });
    expect(onSource).toHaveBeenLastCalledWith(false); expect(getDisplayMedia).toHaveBeenCalledOnce();
    releaseSnipSession(session); expect(track.stop).toHaveBeenCalledOnce(); expect(session.stream).toBeNull();
    delete (HTMLVideoElement.prototype as any).requestVideoFrameCallback; delete (HTMLVideoElement.prototype as any).cancelVideoFrameCallback;
  });
  it("waits for a fresh browser frame after hiding overlay and releases video/stream", async () => {
    const stop = vi.fn(), overlay = document.createElement("div");
    getDisplayMedia.mockResolvedValue({ getTracks: () => [{ stop }], getVideoTracks: () => [] });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 2560 });
    Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 1440 });
    (HTMLVideoElement.prototype as any).requestVideoFrameCallback = (cb: () => void) => { expect(overlay.style.opacity).toBe("0"); cb(); return 1; };
    (HTMLVideoElement.prototype as any).cancelVideoFrameCallback = vi.fn();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as any);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, cb) {
      expect(this.width).toBe(2560); expect(this.height).toBe(1440); cb(new Blob(["png"], { type: "image/png" }));
    });
    await captureSnip(overlay, new AbortController().signal);
    expect(drawImage).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce(); expect(pause).toHaveBeenCalledOnce(); expect(overlay.style.opacity).toBe("");
    delete (HTMLVideoElement.prototype as any).requestVideoFrameCallback; delete (HTMLVideoElement.prototype as any).cancelVideoFrameCallback;
  });
});
