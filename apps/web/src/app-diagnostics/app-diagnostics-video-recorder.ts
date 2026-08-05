import type {
  AppDiagnosticsSegmentMetadata,
  AppDiagnosticsVideoLease
} from "@space/contracts";
import { api } from "../api.js";
import { getSpaceRuntime } from "../runtime/SpaceRuntime.js";
import {
  APP_DIAGNOSTICS_STATE_EVENT,
  getAppDiagnosticsClientId,
  getAppDiagnosticsClientState
} from "./app-diagnostics-bootstrap.js";

export const APP_DIAGNOSTICS_RECORDER_STATE_EVENT = "space:app-diagnostics-recorder-state";

export type AppDiagnosticsRecorderStatus = "IDLE" | "REQUESTING" | "RECORDING" | "STOPPING" | "ERROR";
export type AppDiagnosticsRecorderStopReason =
  | "USER"
  | "DEBUG_OFF"
  | "PAGE_HIDE"
  | "TRACK_ENDED"
  | "LEASE_STALE"
  | "UPLOAD_FAILED"
  | "UPLOAD_BACKPRESSURE";

export interface AppDiagnosticsRecorderState {
  status: AppDiagnosticsRecorderStatus;
  startedAt: string | null;
  errorCode: string | null;
}

interface VideoSegmentInput {
  leaseId: string;
  sequence: number;
  startedAt: string;
  endedAt: string;
  firstEventSequence: number;
  lastEventSequence: number;
  mimeType: string;
}

interface AppDiagnosticsVideoApi {
  acquireLease(input: { clientId: string; pageClientId: string }): Promise<AppDiagnosticsVideoLease>;
  heartbeatLease(leaseId: string, captureId: string): Promise<AppDiagnosticsVideoLease>;
  releaseLease(leaseId: string): Promise<AppDiagnosticsVideoLease>;
  uploadSegment(input: VideoSegmentInput, bytes: Uint8Array): Promise<AppDiagnosticsSegmentMetadata | void>;
}

export interface AppDiagnosticsMediaRecorder {
  state: RecordingState;
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onstop: ((event: Event) => void) | null;
  start(): void;
  stop(): void;
}

interface DownsampledStream {
  stream: MediaStream;
  stop(): void;
}

interface CreateAppDiagnosticsVideoRecorderOptions {
  captureId: string;
  clientId: string;
  pageClientId: string;
  captureHandle: string;
  origin: string;
  api: AppDiagnosticsVideoApi;
  getDisplayMedia(
    constraints: DisplayMediaStreamOptions & { preferCurrentTab?: boolean }
  ): Promise<MediaStream>;
  configureCaptureHandle(input: {
    handle: string;
    exposeOrigin: boolean;
    permittedOrigins: string[];
  }): void | Promise<void>;
  createDownsampledStream(
    source: MediaStream,
    options: { width: number; height: number; fps: number }
  ): Promise<DownsampledStream>;
  createMediaRecorder(stream: MediaStream, options: MediaRecorderOptions): AppDiagnosticsMediaRecorder;
  getLastEventSequence(): number;
  now?: () => Date;
}

export interface AppDiagnosticsVideoRecorder {
  start(): Promise<void>;
  stop(reason?: AppDiagnosticsRecorderStopReason): Promise<void>;
  getState(): AppDiagnosticsRecorderState;
}

type CaptureHandleTrack = MediaStreamTrack & {
  getCaptureHandle?: () => { handle?: string; origin?: string } | null;
};

const recordingWidth = 1280;
const recordingHeight = 720;
const recordingFps = 5;
const recordingBitsPerSecond = 500_000;
const recordingSegmentMs = 30_000;
const leaseHeartbeatMs = 30_000;

function permissionErrorCode(error: unknown): string {
  if (error instanceof DOMException && ["NotAllowedError", "AbortError"].includes(error.name)) {
    return "PERMISSION_DENIED";
  }
  return "RECORDING_START_FAILED";
}

function recorderMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "video/webm";
  for (const candidate of ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/webm"]) {
    if (typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "video/webm";
}

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise<Uint8Array>((resolvePromise, rejectPromise) => {
    const reader = new FileReader();
    reader.onerror = () => rejectPromise(reader.error ?? new Error("Video segment could not be read."));
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        rejectPromise(new Error("Video segment data is invalid."));
        return;
      }
      resolvePromise(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(blob);
  });
}

export function createAppDiagnosticsVideoRecorder(
  options: CreateAppDiagnosticsVideoRecorderOptions
): AppDiagnosticsVideoRecorder {
  const now = options.now ?? (() => new Date());
  let state: AppDiagnosticsRecorderState = { status: "IDLE", startedAt: null, errorCode: null };
  let lease: AppDiagnosticsVideoLease | null = null;
  let sourceStream: MediaStream | null = null;
  let sourceTrack: CaptureHandleTrack | null = null;
  let downsampled: DownsampledStream | null = null;
  let currentRecorder: AppDiagnosticsMediaRecorder | null = null;
  let chunkTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let chunkStartedAt = "";
  let chunkFirstSequence = 0;
  let segmentSequence = 0;
  let chunks: Blob[] = [];
  let active = false;
  let uploadPending: Promise<void> | null = null;
  let stopFlight: Promise<void> | null = null;
  let rotateFlight: Promise<void> | null = null;
  let startGeneration = 0;
  let startPending = false;

  const emit = () => {
    window.dispatchEvent(new CustomEvent<AppDiagnosticsRecorderState>(
      APP_DIAGNOSTICS_RECORDER_STATE_EVENT,
      { detail: state }
    ));
  };
  const setState = (next: AppDiagnosticsRecorderState) => {
    state = next;
    emit();
  };
  const clearTimers = () => {
    if (chunkTimer !== null) window.clearTimeout(chunkTimer);
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
    chunkTimer = null;
    heartbeatTimer = null;
  };
  const releaseLease = async () => {
    const current = lease;
    lease = null;
    if (!current) return;
    await options.api.releaseLease(current.leaseId).catch(() => undefined);
  };
  const cleanupStreams = () => {
    sourceTrack?.removeEventListener("ended", onTrackEnded);
    downsampled?.stop();
    for (const track of sourceStream?.getTracks() ?? []) track.stop();
    sourceTrack = null;
    sourceStream = null;
    downsampled = null;
  };
  const abandonCancelledStart = async (generation: number): Promise<boolean> => {
    if (generation === startGeneration) return false;
    active = false;
    clearTimers();
    cleanupStreams();
    await releaseLease();
    return true;
  };

  const uploadChunk = (blob: Blob, endedAt: string, lastEventSequence: number) => {
    if (!lease || blob.size === 0) return;
    const input: VideoSegmentInput = {
      leaseId: lease.leaseId,
      sequence: segmentSequence++,
      startedAt: chunkStartedAt,
      endedAt,
      firstEventSequence: chunkFirstSequence,
      lastEventSequence: Math.max(chunkFirstSequence, lastEventSequence),
      mimeType: blob.type || currentRecorder?.mimeType || "video/webm"
    };
    uploadPending = readBlobBytes(blob)
      .then((bytes) => options.api.uploadSegment(input, bytes))
      .then(() => undefined)
      .catch(() => {
        if (active) void recorder.stop("UPLOAD_FAILED");
      })
      .finally(() => {
        uploadPending = null;
      });
  };

  const stopCurrentChunk = (shouldUpload: boolean): Promise<void> => new Promise((resolvePromise) => {
    const mediaRecorder = currentRecorder;
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      currentRecorder = null;
      chunks = [];
      resolvePromise();
      return;
    }
    if (chunkTimer !== null) window.clearTimeout(chunkTimer);
    chunkTimer = null;
    mediaRecorder.onstop = () => {
      const endedAt = now().toISOString();
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || "video/webm" });
      currentRecorder = null;
      chunks = [];
      if (shouldUpload) uploadChunk(blob, endedAt, options.getLastEventSequence());
      resolvePromise();
    };
    mediaRecorder.stop();
  });

  const startChunk = () => {
    if (!active || !downsampled) return;
    chunks = [];
    chunkStartedAt = now().toISOString();
    chunkFirstSequence = options.getLastEventSequence();
    const mediaRecorder = options.createMediaRecorder(downsampled.stream, {
      mimeType: recorderMimeType(),
      videoBitsPerSecond: recordingBitsPerSecond
    });
    currentRecorder = mediaRecorder;
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    mediaRecorder.onerror = () => {
      if (active) void recorder.stop("UPLOAD_FAILED");
    };
    mediaRecorder.start();
    chunkTimer = window.setTimeout(() => {
      if (!active) return;
      if (uploadPending) {
        void recorder.stop("UPLOAD_BACKPRESSURE");
        return;
      }
      rotateFlight = stopCurrentChunk(true)
        .then(() => {
          if (active) startChunk();
        })
        .finally(() => {
          rotateFlight = null;
        });
    }, recordingSegmentMs);
  };

  function onTrackEnded() {
    if (active) void recorder.stop("TRACK_ENDED");
  }

  const recorder: AppDiagnosticsVideoRecorder = {
    start: async () => {
      if (startPending || active || state.status === "REQUESTING" || state.status === "STOPPING") return;
      startPending = true;
      const generation = ++startGeneration;
      setState({ status: "REQUESTING", startedAt: null, errorCode: null });
      try {
        lease = await options.api.acquireLease({
          clientId: options.clientId,
          pageClientId: options.pageClientId
        });
        if (await abandonCancelledStart(generation)) return;
        await options.configureCaptureHandle({
          handle: options.captureHandle,
          exposeOrigin: true,
          permittedOrigins: [options.origin]
        });
        if (await abandonCancelledStart(generation)) return;
        sourceStream = await options.getDisplayMedia({
          audio: false,
          preferCurrentTab: true,
          video: {
            width: recordingWidth,
            height: recordingHeight,
            frameRate: recordingFps,
            displaySurface: "browser"
          }
        });
        if (await abandonCancelledStart(generation)) return;
        sourceTrack = sourceStream.getVideoTracks()[0] as CaptureHandleTrack | undefined ?? null;
        if (!sourceTrack || sourceTrack.getSettings().displaySurface !== "browser") {
          throw Object.assign(new Error("A browser tab must be shared."), { code: "TAB_REQUIRED" });
        }
        const handle = sourceTrack.getCaptureHandle?.();
        if (handle?.handle !== options.captureHandle || handle.origin !== options.origin) {
          throw Object.assign(new Error("The selected tab is not this Space tab."), {
            code: "CAPTURE_HANDLE_MISMATCH"
          });
        }
        if (sourceStream.getAudioTracks().length > 0) {
          for (const track of sourceStream.getAudioTracks()) track.stop();
        }
        downsampled = await options.createDownsampledStream(sourceStream, {
          width: recordingWidth,
          height: recordingHeight,
          fps: recordingFps
        });
        if (await abandonCancelledStart(generation)) return;
        sourceTrack.addEventListener("ended", onTrackEnded);
        active = true;
        segmentSequence = 0;
        const startedAt = now().toISOString();
        heartbeatTimer = window.setInterval(() => {
          if (!active || !lease) return;
          void options.api.heartbeatLease(lease.leaseId, options.captureId)
            .catch(() => recorder.stop("LEASE_STALE"));
        }, leaseHeartbeatMs);
        startChunk();
        setState({ status: "RECORDING", startedAt, errorCode: null });
      } catch (error) {
        active = false;
        clearTimers();
        cleanupStreams();
        await releaseLease();
        if (generation !== startGeneration) return;
        const explicitCode = typeof error === "object" && error !== null && "code" in error &&
          typeof error.code === "string" && error.code.length > 0
          ? error.code
          : null;
        setState({
          status: "ERROR",
          startedAt: null,
          errorCode: explicitCode ?? permissionErrorCode(error)
        });
      } finally {
        startPending = false;
      }
    },
    stop: async (reason = "USER") => {
      if (stopFlight) return stopFlight;
      if (!active && !lease && state.status !== "REQUESTING") return;
      startGeneration += 1;
      stopFlight = (async () => {
        active = false;
        clearTimers();
        setState({ ...state, status: "STOPPING" });
        if (rotateFlight) await rotateFlight;
        const uploadFinal = false;
        await stopCurrentChunk(uploadFinal);
        const pendingUpload = uploadPending;
        if (pendingUpload && (reason === "USER" || reason === "TRACK_ENDED")) {
          await pendingUpload;
        }
        cleanupStreams();
        await releaseLease();
        const errorCode = ["UPLOAD_BACKPRESSURE", "UPLOAD_FAILED", "LEASE_STALE"].includes(reason)
          ? reason
          : null;
        setState({
          status: errorCode ? "ERROR" : "IDLE",
          startedAt: null,
          errorCode
        });
      })().finally(() => {
        stopFlight = null;
      });
      return stopFlight;
    },
    getState: () => ({ ...state })
  };
  return recorder;
}

async function defaultDownsampledStream(
  source: MediaStream,
  options: { width: number; height: number; fps: number }
): Promise<DownsampledStream> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;
  await video.play();
  const canvas = document.createElement("canvas");
  canvas.width = options.width;
  canvas.height = options.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas 2D context is unavailable.");
  const draw = () => {
    context.fillStyle = "#000";
    context.fillRect(0, 0, options.width, options.height);
    const sourceWidth = video.videoWidth || options.width;
    const sourceHeight = video.videoHeight || options.height;
    const scale = Math.min(options.width / sourceWidth, options.height / sourceHeight);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    context.drawImage(video, (options.width - width) / 2, (options.height - height) / 2, width, height);
  };
  draw();
  const drawTimer = window.setInterval(draw, 1_000 / options.fps);
  const stream = canvas.captureStream(options.fps);
  return {
    stream,
    stop: () => {
      window.clearInterval(drawTimer);
      video.pause();
      video.srcObject = null;
      for (const track of stream.getTracks()) track.stop();
    }
  };
}

const pageClientStorageKey = "space.appDiagnostics.pageClientId.v1";
const captureHandle = `space-app:${crypto.randomUUID().replaceAll("-", "")}`;
let globalRecorder: AppDiagnosticsVideoRecorder | null = null;
let globalRecorderState: AppDiagnosticsRecorderState = {
  status: "IDLE",
  startedAt: null,
  errorCode: null
};

function pageClientId(): string {
  const stored = window.sessionStorage.getItem(pageClientStorageKey);
  if (stored && /^[A-Za-z0-9][A-Za-z0-9:_-]{5,99}$/.test(stored)) return stored;
  const created = `app_debug_page:${crypto.randomUUID().replaceAll("-", "")}`;
  window.sessionStorage.setItem(pageClientStorageKey, created);
  return created;
}

function syncGlobalRecorderState() {
  globalRecorderState = globalRecorder?.getState() ?? {
    status: "IDLE",
    startedAt: null,
    errorCode: null
  };
}

export function getAppDiagnosticsRecorderState(): AppDiagnosticsRecorderState {
  syncGlobalRecorderState();
  return { ...globalRecorderState };
}

export async function startAppDiagnosticsVideoRecording(): Promise<void> {
  const diagnostics = getAppDiagnosticsClientState();
  if (!diagnostics.status?.isEnabled || !diagnostics.status.captureId) {
    throw new Error("App diagnostics must be enabled before recording.");
  }
  if (globalRecorder && ["REQUESTING", "RECORDING", "STOPPING"].includes(globalRecorder.getState().status)) return;
  const mediaDevices = navigator.mediaDevices as MediaDevices & {
    setCaptureHandleConfig?: (input: {
      handle: string;
      exposeOrigin: boolean;
      permittedOrigins: string[];
    }) => void;
  };
  if (typeof mediaDevices?.setCaptureHandleConfig !== "function") {
    throw new Error("CAPTURE_HANDLE_UNAVAILABLE");
  }
  globalRecorder = createAppDiagnosticsVideoRecorder({
    captureId: diagnostics.status.captureId,
    clientId: getAppDiagnosticsClientId(),
    pageClientId: pageClientId(),
    captureHandle,
    origin: window.location.origin,
    api: {
      acquireLease: (input) => api.acquireAppDiagnosticsVideoLease(input),
      heartbeatLease: (leaseId, captureId) => api.heartbeatAppDiagnosticsVideoLease(leaseId, captureId),
      releaseLease: (leaseId) => api.releaseAppDiagnosticsVideoLease(leaseId),
      uploadSegment: (input, bytes) => api.uploadAppDiagnosticsVideoSegment(input, bytes)
    },
    getDisplayMedia: (constraints) => getSpaceRuntime().platform.getDisplayMedia(constraints),
    configureCaptureHandle: (input) => mediaDevices.setCaptureHandleConfig!(input),
    createDownsampledStream: defaultDownsampledStream,
    createMediaRecorder: (stream, recorderOptions) => new MediaRecorder(stream, recorderOptions),
    getLastEventSequence: () => getAppDiagnosticsClientState().collector.lastSequence
  });
  const update = () => syncGlobalRecorderState();
  window.addEventListener(APP_DIAGNOSTICS_RECORDER_STATE_EVENT, update, { once: true });
  await globalRecorder.start();
  syncGlobalRecorderState();
}

export async function stopAppDiagnosticsVideoRecording(
  reason: AppDiagnosticsRecorderStopReason = "USER"
): Promise<void> {
  await globalRecorder?.stop(reason);
  syncGlobalRecorderState();
}

window.addEventListener(APP_DIAGNOSTICS_STATE_EVENT, () => {
  if (!getAppDiagnosticsClientState().status?.isEnabled) {
    void stopAppDiagnosticsVideoRecording("DEBUG_OFF");
  }
});
window.addEventListener("pagehide", () => {
  void stopAppDiagnosticsVideoRecording("PAGE_HIDE");
});
