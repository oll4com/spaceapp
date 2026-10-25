import { getSpaceRuntime, getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { canvasBlob, canvasFrame, frameFromBlob, type SnipFrame } from "./snip-image.js";

export function checkAbort(signal: AbortSignal) { if (signal.aborted) throw new DOMException("Capture cancelled", "AbortError"); }
function abortable<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs = 10000): Promise<T> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => { clearTimeout(timer); signal.removeEventListener("abort", abort); fn(); };
    const abort = () => finish(() => reject(new DOMException("Capture cancelled", "AbortError")));
    const timer = setTimeout(() => finish(() => reject(new Error("Capture timed out. Please retry."))), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
async function painted(signal: AbortSignal) {
  await abortable(new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))), signal, 3000);
}
/**
 * Records frames delivered after the overlay hides. On a static screen the only new frame is the
 * one hiding the overlay produces, and it can arrive before freshFrame's own listener is attached.
 */
function watchFrames(video: HTMLVideoElement) {
  let last = 0, id = 0, registering = false, active = typeof video.requestVideoFrameCallback === "function";
  const register = () => {
    if (!active || registering) return;
    registering = true;
    try { id = video.requestVideoFrameCallback(tick); } finally { registering = false; }
  };
  const tick = (now: number, metadata?: { captureTime?: number }) => { last = metadata?.captureTime ?? now ?? performance.now(); register(); };
  register();
  return { lastFrameAt: () => last, stop: () => { if (active) { active = false; video.cancelVideoFrameCallback?.(id); } } };
}
async function freshFrame(video: HTMLVideoElement, signal: AbortSignal, frameSince?: () => boolean) {
  // Wait for a newly delivered frame, not simply readyState from before hiding the HUD.
  if (typeof video.requestVideoFrameCallback === "function") {
    let id = 0;
    try {
      await abortable(new Promise<void>(resolve => { id = video.requestVideoFrameCallback(() => resolve()); }), signal, frameSince ? 1200 : 4000);
    } catch (error) {
      // No further frame on a static screen: accept the one delivered after the overlay hid.
      if ((error as Error)?.name === "AbortError" || !frameSince?.() || video.readyState < 2) throw error;
    } finally { video.cancelVideoFrameCallback(id); }
  } else {
    let ready: () => void = () => {};
    try {
      await abortable(new Promise<void>(resolve => {
        ready = () => { if (video.readyState >= 2 && video.videoWidth > 0) resolve(); };
        video.addEventListener("timeupdate", ready);
      }), signal, 4000);
    } finally { video.removeEventListener("timeupdate", ready); }
  }
  if (!video.videoWidth || !video.videoHeight) throw new Error("The capture source has no image. Please retry.");
}
function mobileImage(signal: AbortSignal): Promise<string> {
  const w = window as any;
  const callbacks = w.__spaceNativeCaptureCallbacks ??= {};
  w.__onSpaceNativeCapture ??= (id: string, success: boolean, message?: string) => {
    const callback = callbacks[id]; delete callbacks[id]; callback?.(success, message);
  };
  const id = `snip_${crypto.randomUUID()}`;
  return abortable(new Promise<string>((resolve, reject) => {
    callbacks[id] = (success: boolean, message?: string) => {
      try {
        const data = w.SpaceNative.getCapturedData?.(id);
        if (!success || !data) reject(new Error(message || "Mobile screen capture failed."));
        else resolve(data);
      } catch (error) { reject(error); }
    };
    w.SpaceNative.requestPageCapture(0, 0, 0, 0, id);
  }), signal, 8000).finally(() => { delete callbacks[id]; });
}
function dataUrlBlob(url: string): Blob {
  if (!url.startsWith("data:image/png;base64,")) throw new Error("Capture returned an invalid image.");
  const raw = atob(url.slice(url.indexOf(",") + 1));
  return new Blob([Uint8Array.from(raw, c => c.charCodeAt(0))], { type: "image/png" });
}
export interface SnipCaptureSession {
  stream: MediaStream | null;
  video: HTMLVideoElement | null;
  handle: string;
}
export function releaseSnipSession(session: SnipCaptureSession) {
  session.stream?.getTracks().forEach(track => track.stop());
  if (session.video) { session.video.pause(); session.video.srcObject = null; }
  session.stream = null; session.video = null;
}
export interface SnipCaptureOptions {
  session?: SnipCaptureSession;
  onSource?: (viewportAligned: boolean) => void;
}
/** Every capture method is disabled in the public demo. */
export function assertCaptureAllowed() {
  if (getSpaceRuntimeKind() === "demo") throw new Error("Screen capture is disabled in demo mode.");
}
/** True when the desktop or Android shell captures the page itself (no browser source picker). */
export function hasNativeCapture(): boolean {
  const w = window as any;
  return typeof w.spaceDesktop?.capturePage === "function" || typeof w.SpaceNative?.requestPageCapture === "function";
}
export async function captureSnip(overlay: HTMLElement, signal: AbortSignal, options?: SnipCaptureOptions): Promise<Blob> {
  const shot = await grab(overlay, signal, options);
  return shot.blob ?? canvasBlob(shot.canvas!);
}
/** Captures straight to a drawable frame, skipping the full-screen PNG encode/decode round trip. */
export async function captureSnipFrame(overlay: HTMLElement, signal: AbortSignal, options?: SnipCaptureOptions): Promise<SnipFrame> {
  const shot = await grab(overlay, signal, options);
  if (shot.canvas) return canvasFrame(shot.canvas);
  const frame = await frameFromBlob(shot.blob!);
  checkAbort(signal);
  return frame;
}
async function grab(overlay: HTMLElement, signal: AbortSignal, options?: SnipCaptureOptions): Promise<{ blob?: Blob; canvas?: HTMLCanvasElement }> {
  const runtime = getSpaceRuntime();
  if (runtime.kind === "demo") throw new Error("Screen capture is disabled in demo mode.");
  const w = window as any;
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  const previous = overlay.style.opacity;
  let succeeded = false;
  try {
    // Acquire permission while the cancel controls remain available.
    const native = hasNativeCapture();
    if (!native) {
      if (!runtime.platform.displayMediaSupported) throw new Error("Screen capture is unavailable here. Use the SpaceApp desktop or Android app.");
      const session = options?.session;
      if (session?.stream?.getVideoTracks().some(track => track.readyState === "live")) {
        stream = session.stream; video = session.video;
      } else {
        if (session) releaseSnipSession(session);
        const handle = session?.handle ?? `space-snip-${crypto.randomUUID()}`;
        // A browser surface alone cannot distinguish this tab from another tab.
        // Only crop viewport coordinates when the captured tab proves its identity.
        try { (navigator.mediaDevices as any)?.setCaptureHandleConfig?.({ handle, exposeOrigin: false, permittedOrigins: [location.origin] }); } catch { /* Unsupported: use source preview. */ }
        const pending = (async () => {
          try {
            return await runtime.platform.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "exclude" } as any);
          } catch (error: any) {
            checkAbort(signal);
            if (error?.name !== "TypeError" && error?.name !== "NotSupportedError") throw error;
            return runtime.platform.getDisplayMedia({ video: true, audio: false });
          }
        })();
        // Permission prompts may complete after cancel/timeout; immediately release late streams.
        let accepting = true;
        pending.then(value => { if (!accepting || signal.aborted) value.getTracks().forEach(track => track.stop()); }, () => {});
        try { stream = await abortable(pending, signal, 60000); } finally { accepting = false; }
        checkAbort(signal);
        video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = stream;
        await abortable(video.play(), signal);
        if (session) { session.stream = stream; session.video = video; }
        else options?.onSource?.((stream.getVideoTracks()[0] as any)?.getCaptureHandle?.()?.handle === handle);
      }
      if (session) options?.onSource?.((stream!.getVideoTracks()[0] as any)?.getCaptureHandle?.()?.handle === session.handle);
    }
    // Keep the transparent overlay hit-testable so clicks cannot reach panes during capture.
    if (native) options?.onSource?.(true);
    overlay.style.opacity = "0";
    const hiddenAt = performance.now();
    // Started in the same task as hiding, so no frame can slip in between.
    const frames = !native && video ? watchFrames(video) : null;
    try { await painted(signal); } catch (error) { frames?.stop(); throw error; }
    let shot: { blob?: Blob; canvas?: HTMLCanvasElement };
    if (typeof w.spaceDesktop?.capturePage === "function") {
      const result = await abortable<any>(w.spaceDesktop.capturePage(), signal);
      if (!result?.success || !result.dataUrl) throw new Error(result?.reason || "Desktop capture failed. Please retry.");
      shot = { blob: dataUrlBlob(result.dataUrl) };
    } else if (typeof w.SpaceNative?.requestPageCapture === "function") {
      shot = { blob: dataUrlBlob(await mobileImage(signal)) };
    } else {
      try { await freshFrame(video!, signal, frames ? () => frames.lastFrameAt() > hiddenAt : undefined); }
      finally { frames?.stop(); }
      const canvas = document.createElement("canvas"); canvas.width = video!.videoWidth; canvas.height = video!.videoHeight;
      // CPU-backed: the snapshot is read back once here, so later crops and PNG encodes avoid GPU readbacks.
      const ctx = canvas.getContext("2d", { willReadFrequently: true }); if (!ctx) throw new Error("Screen capture is unavailable.");
      ctx.drawImage(video!, 0, 0);
      shot = { canvas };
    }
    checkAbort(signal);
    succeeded = true;
    return shot;
  } finally {
    overlay.style.opacity = previous;
    if (!options?.session || !succeeded || signal.aborted) {
      if (options?.session) { options.session.stream = null; options.session.video = null; }
      stream?.getTracks().forEach(track => { if (track.readyState !== "ended") track.stop(); });
      if (video) { video.pause(); video.srcObject = null; }
    }
  }
}
