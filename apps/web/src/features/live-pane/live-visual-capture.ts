import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

const abortError = () => new DOMException("Capture cancelled.", "AbortError");
function waitForFrame(video: HTMLVideoElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let playing = false;
    const clean = () => {
      clearTimeout(timer);
      for (const event of ["loadeddata", "canplay", "playing", "resize"]) video.removeEventListener(event, check);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => { clean(); reject(abortError()); };
    const check = () => {
      if (signal.aborted) return abort();
      if (playing && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) { clean(); resolve(); }
    };
    const timer = setTimeout(() => { clean(); reject(new Error("The selected capture source did not produce a video frame.")); }, 5000);
    for (const event of ["loadeddata", "canplay", "playing", "resize"]) video.addEventListener(event, check);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => video.play()).then(() => { playing = true; check(); }, error => { clean(); reject(error); });
    check();
  });
}

// Called only from the operator's camera/Screen action. No provider request,
// synthetic DOM rendering or programmatic permission bypass occurs here.
export async function captureLiveVisual(source: "camera" | "screen", signal: AbortSignal) {
  if (signal.aborted) throw abortError();
  const platform = getSpaceRuntime().platform;
  let stream: MediaStream | undefined;
  let video: HTMLVideoElement | undefined;
  try {
    stream = source === "camera"
      ? await platform.getUserMedia({ video: true, audio: false })
      : await platform.getDisplayMedia({ video: true, audio: false });
    if (signal.aborted) throw abortError();
    const track = stream.getVideoTracks()[0];
    if (!track || track.readyState === "ended") throw new Error("No active video track was selected.");
    video = document.createElement("video");
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    await waitForFrame(video, signal);
    if (signal.aborted) throw abortError();
    if (stream.getVideoTracks()[0]?.readyState === "ended") throw new Error("The selected capture source was closed.");
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image capture is unavailable in this browser.");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    if (!dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("The selected capture source did not produce an image.");
    return { type: "image" as const, dataUrl, filename: `${source}-capture.jpg` };
  } finally {
    // Also runs after cancellation, missing canvas, video.play errors and late
    // permission resolution after unmount. Stop every track, not only video[0].
    stream?.getTracks().forEach(track => { try { track.stop(); } catch {} });
    if (video) { try { video.pause(); } catch {} video.srcObject = null; }
  }
}
