/**
 * Space Dots Stage 6: Real View, a continuous view of the user's screen or
 * camera for the Live conversation.
 *
 * - Source: chosen by the user each time (screen or camera); nothing starts
 *   without that click.
 * - Freshness: every frame carries its capture time. A frame older than
 *   `maxFrameAgeMs` when it would be sent is dropped, never sent late.
 * - Backpressure: at most one frame is in flight. While the model is still
 *   receiving one, new ticks are skipped instead of queued. Frames that did
 *   not change since the last one sent are skipped too.
 * - Size: frames are downscaled and re-encoded until they fit `maxDataUrlChars`
 *   (the voice relay accepts messages up to 64 KB).
 * - Stop: Stop, closing the source in the browser, revoking the permission or
 *   leaving the pane stops every track at once.
 */
export type RealViewSource = "screen" | "camera";
/** Images sent to Live stay under the voice relay's 64 KB message limit, with room for the message envelope. */
export const LIVE_IMAGE_MAX_DATA_URL_CHARS = 60_000;
export interface RealViewFrame { type: "image"; dataUrl: string; filename: string; capturedAt: number; source: RealViewSource; sequence: number }
export interface RealViewState {
  status: "idle" | "starting" | "live" | "stopped" | "error";
  source: RealViewSource | null;
  lastFrameAt: number | null;
  framesSent: number;
  framesSkipped: number;
  reason: string | null;
}
/** What a frame grabber returns: the encoded image and a small brightness signature used to skip unchanged frames. */
export interface GrabbedFrame { dataUrl: string; signature: number[] }

export interface RealViewOptions {
  getMedia(source: RealViewSource): Promise<MediaStream>;
  /** Delivers one frame to the conversation; resolves when it was accepted. */
  send(frame: RealViewFrame): Promise<void>;
  onState(state: RealViewState): void;
  /** Encodes the current video frame within the size limit; null when the source has no frame yet. */
  grab(video: HTMLVideoElement, maxDataUrlChars: number): GrabbedFrame | null;
  createVideo?: () => HTMLVideoElement;
  intervalMs?: number;
  maxFrameAgeMs?: number;
  maxDataUrlChars?: number;
  now?: () => number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Mean absolute difference between two signatures, in brightness units (0-255). */
function difference(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 255;
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += Math.abs(a[index]! - b[index]!);
  return total / a.length;
}

export function createRealView(options: RealViewOptions) {
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? 5_000;
  const maxFrameAgeMs = options.maxFrameAgeMs ?? 4_000;
  const maxDataUrlChars = options.maxDataUrlChars ?? LIVE_IMAGE_MAX_DATA_URL_CHARS;
  const startTimer = options.setInterval ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const stopTimer = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  let state: RealViewState = { status: "idle", source: null, lastFrameAt: null, framesSent: 0, framesSkipped: 0, reason: null };
  let stream: MediaStream | null = null;
  let video: HTMLVideoElement | null = null;
  let timer: unknown = null;
  let inFlight = false;
  let sequence = 0;
  let lastSignature: number[] | null = null;
  let generation = 0;
  const publish = (patch: Partial<RealViewState>) => { state = { ...state, ...patch }; options.onState(state); };

  function release() {
    if (timer !== null) { stopTimer(timer); timer = null; }
    stream?.getTracks().forEach((track) => { try { track.stop(); } catch { /* already stopped */ } });
    stream = null;
    if (video) { try { video.pause(); } catch { /* not playing */ } video.srcObject = null; video = null; }
    inFlight = false;
    lastSignature = null;
  }

  function stop(reason: string | null = null) {
    generation += 1;
    const wasActive = state.status === "live" || state.status === "starting";
    release();
    if (wasActive || reason) publish({ status: "stopped", reason });
  }

  function tick(current: number) {
    if (current !== generation || !video) return;
    if (inFlight) { publish({ framesSkipped: state.framesSkipped + 1 }); return; }
    const capturedAt = now();
    let frame: GrabbedFrame | null = null;
    try { frame = options.grab(video, maxDataUrlChars); } catch { frame = null; }
    if (!frame || frame.dataUrl.length > maxDataUrlChars) { publish({ framesSkipped: state.framesSkipped + 1 }); return; }
    if (lastSignature && difference(lastSignature, frame.signature) < 2) { publish({ framesSkipped: state.framesSkipped + 1 }); return; }
    // Encoding can be slow on large screens; a frame that is already old is not sent.
    if (now() - capturedAt > maxFrameAgeMs) { publish({ framesSkipped: state.framesSkipped + 1 }); return; }
    sequence += 1;
    inFlight = true;
    const stamp = new Date(capturedAt).toISOString().replace(/[:.]/g, "-");
    void Promise.resolve().then(() => options.send({ type: "image", dataUrl: frame!.dataUrl, filename: `real-view-${state.source}-${stamp}.jpg`, capturedAt, source: state.source!, sequence }))
      .then(() => {
        if (current !== generation) return;
        lastSignature = frame!.signature;
        publish({ framesSent: state.framesSent + 1, lastFrameAt: capturedAt });
      }, () => { if (current === generation) publish({ framesSkipped: state.framesSkipped + 1 }); })
      .finally(() => { if (current === generation) inFlight = false; });
  }

  async function start(source: RealViewSource) {
    stop();
    const current = generation;
    publish({ status: "starting", source, lastFrameAt: null, framesSent: 0, framesSkipped: 0, reason: null });
    let media: MediaStream;
    try {
      media = await options.getMedia(source);
    } catch (error) {
      if (current === generation) publish({ status: "error", reason: error instanceof Error && error.name === "NotAllowedError"
        ? "Permission to capture was not granted." : "The capture source is not available." });
      return;
    }
    // Stopped or restarted while the browser asked for permission: release the late stream at once.
    if (current !== generation) { media.getTracks().forEach((track) => track.stop()); return; }
    stream = media;
    const track = media.getVideoTracks()[0];
    if (!track || track.readyState === "ended") { stop("No active video track was selected."); return; }
    // The user ending the share in the browser, or revoking the permission, ends the track.
    for (const each of media.getTracks()) each.addEventListener("ended", () => { if (current === generation) stop("The capture source was closed."); }, { once: true });
    video = (options.createVideo ?? (() => document.createElement("video")))();
    video.muted = true; video.playsInline = true; video.srcObject = media;
    try { await video.play(); } catch { if (current === generation) stop("The capture source could not be played."); return; }
    if (current !== generation) return;
    publish({ status: "live" });
    tick(current);
    timer = startTimer(() => tick(current), intervalMs);
  }

  return { start, stop, getState: () => state };
}
export type RealView = ReturnType<typeof createRealView>;

/** Draws the video into a canvas and encodes a JPEG within the size limit, shrinking quality and then size. */
export function grabVideoFrame(video: HTMLVideoElement, maxDataUrlChars: number): GrabbedFrame | null {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  let dataUrl = "";
  for (const [width, quality] of [[960, 0.7], [960, 0.5], [640, 0.6], [640, 0.4], [480, 0.4]] as const) {
    const scale = Math.min(1, width / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length <= maxDataUrlChars) break;
  }
  if (!dataUrl.startsWith("data:image/jpeg;base64,") || dataUrl.length > maxDataUrlChars) return null;
  // A 16×9 brightness signature is enough to tell a still screen from a changed one.
  const small = document.createElement("canvas");
  small.width = 16; small.height = 9;
  const tiny = small.getContext("2d");
  if (!tiny) return { dataUrl, signature: [] };
  const signature: number[] = [];
  try {
    tiny.drawImage(video, 0, 0, 16, 9);
    const pixels = tiny.getImageData(0, 0, 16, 9).data;
    for (let index = 0; index < pixels.length; index += 4) signature.push((pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / 3);
  } catch { /* Without a signature every frame counts as changed. */ }
  return { dataUrl, signature };
}
