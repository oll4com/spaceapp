import type {
  AppDiagnosticsSegmentMetadata,
  AppDiagnosticsVideoLease
} from "@space/contracts";
import { api } from "../api.js";
import { emitAppDiagnosticsPerformance } from "./app-diagnostics-performance.js";
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
  paused: boolean;
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

const recorderLeaseStorageKey = "space.appDiagnostics.recorderLease.v1";
const pendingSegmentStorageKey = "space.appDiagnostics.pendingSegment.v1";
const maxPendingSegmentChars = 4_000_000;

interface PendingVideoSegment {
  input: VideoSegmentInput;
  base64: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function writePendingSegment(value: PendingVideoSegment | null): void {
  try {
    const storage = getSpaceRuntime().platform.localStorage;
    if (value) storage.setItem(pendingSegmentStorageKey, JSON.stringify(value));
    else storage.removeItem(pendingSegmentStorageKey);
  } catch {
    // Best effort only.
  }
}

function readPendingSegment(): PendingVideoSegment | null {
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(pendingSegmentStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingVideoSegment>;
    if (!parsed || !parsed.input || typeof parsed.base64 !== "string") return null;
    return { input: parsed.input as VideoSegmentInput, base64: parsed.base64 };
  } catch {
    return null;
  }
}

interface PersistedRecorderLease {
  leaseId: string;
  captureId: string;
  startedAt: string | null;
}

function readPersistedRecorderLease(): PersistedRecorderLease | null {
  try {
    const raw = getSpaceRuntime().platform.localStorage.getItem(recorderLeaseStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedRecorderLease>;
    if (!parsed || typeof parsed.leaseId !== "string" || parsed.leaseId.length < 6 || typeof parsed.captureId !== "string") {
      return null;
    }
    return {
      leaseId: parsed.leaseId,
      captureId: parsed.captureId,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null
    };
  } catch {
    return null;
  }
}

function writePersistedRecorderLease(value: PersistedRecorderLease | null): void {
  try {
    const storage = getSpaceRuntime().platform.localStorage;
    if (value) storage.setItem(recorderLeaseStorageKey, JSON.stringify(value));
    else storage.removeItem(recorderLeaseStorageKey);
  } catch {
    // Best effort only.
  }
}

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
  const persisted = readPersistedRecorderLease();
  const restoredLease = persisted && persisted.captureId === options.captureId ? persisted : null;
  let state: AppDiagnosticsRecorderState = restoredLease
    ? { status: "RECORDING", startedAt: restoredLease.startedAt, errorCode: null, paused: true }
    : { status: "IDLE", startedAt: null, errorCode: null, paused: false };
  let lease: AppDiagnosticsVideoLease | null = null;
  if (restoredLease) {
    lease = {
      leaseId: restoredLease.leaseId,
      captureId: restoredLease.captureId,
      clientId: options.clientId,
      pageClientId: options.pageClientId,
      userId: "app_debug_user:restored",
      status: "ACTIVE",
      acquiredAt: restoredLease.startedAt ?? "1970-01-01T00:00:00.000Z",
      heartbeatAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:00:00.000Z",
      releasedAt: null
    };
  }
  let sourceStream: MediaStream | null = null;
  let sourceTrack: CaptureHandleTrack | null = null;
  let downsampled: DownsampledStream | null = null;
  let currentRecorder: AppDiagnosticsMediaRecorder | null = null;
  let chunkTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  if (restoredLease) {
    heartbeatTimer = window.setInterval(() => {
      void options.api.heartbeatLease(restoredLease.leaseId, options.captureId).catch(() => undefined);
    }, leaseHeartbeatMs);
    const pending = readPendingSegment();
    if (pending && pending.input.leaseId === restoredLease.leaseId) {
      const bytes = base64ToBytes(pending.base64);
      if (bytes) {
        void options.api.uploadSegment(pending.input, bytes)
          .then(() => writePendingSegment(null))
          .catch(() => undefined);
      }
    }
  }
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
    writePersistedRecorderLease(null);
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
      .then((bytes) => {
        const base64 = bytesToBase64(bytes);
        if (base64.length <= maxPendingSegmentChars) {
          writePendingSegment({ input, base64 });
        }
        return options.api.uploadSegment(input, bytes);
      })
      .then(() => {
        writePendingSegment(null);
        return undefined;
      })
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
      setState({ status: "REQUESTING", startedAt: null, errorCode: null, paused: Boolean(lease) });
      try {
        if (!lease) {
          lease = await options.api.acquireLease({
            clientId: options.clientId,
            pageClientId: options.pageClientId
          });
          writePersistedRecorderLease({
            leaseId: lease.leaseId,
            captureId: options.captureId,
            startedAt: now().toISOString()
          });
        }
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
        setState({ status: "RECORDING", startedAt, errorCode: null, paused: false });
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
          errorCode: explicitCode ?? permissionErrorCode(error),
          paused: false
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
        setState({ ...state, status: "STOPPING", paused: false });
        if (rotateFlight) await rotateFlight;
        const uploadFinal = reason === "PAGE_HIDE";
        await stopCurrentChunk(uploadFinal);
        const pendingUpload = uploadPending;
        if (pendingUpload && (reason === "USER" || reason === "TRACK_ENDED")) {
          await pendingUpload;
        }
        cleanupStreams();
        if (reason === "PAGE_HIDE") {
          emitAppDiagnosticsPerformance({
            category: "PERFORMANCE",
            metric: "RECORDER",
            phase: "PAGE_HIDE",
            value: 1
          });
        } else {
          await releaseLease();
          emitAppDiagnosticsPerformance({
            category: "PERFORMANCE",
            metric: "RECORDER",
            phase: reason === "DEBUG_OFF" ? "STOPPED" : "RELEASED",
            value: 1
          });
        }
        const errorCode = ["UPLOAD_BACKPRESSURE", "UPLOAD_FAILED", "LEASE_STALE"].includes(reason)
          ? reason
          : null;
        setState({
          status: errorCode ? "ERROR" : "IDLE",
          startedAt: null,
          errorCode,
          paused: false
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
  errorCode: null,
  paused: false
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
    errorCode: null,
    paused: false
  };
}

function createGlobalRecorder(): AppDiagnosticsVideoRecorder | null {
  const diagnostics = getAppDiagnosticsClientState();
  if (!diagnostics.status?.isEnabled || !diagnostics.status.captureId) return null;
  const mediaDevices = navigator.mediaDevices as MediaDevices & {
    setCaptureHandleConfig?: (input: {
      handle: string;
      exposeOrigin: boolean;
      permittedOrigins: string[];
    }) => void;
  };
  if (typeof mediaDevices?.setCaptureHandleConfig !== "function") return null;
  return createAppDiagnosticsVideoRecorder({
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
}

// Restores a recorder with a persisted lease on page load so the Stop button
// survives a hard refresh while Debug stays ON.
function ensureGlobalRecorder(): void {
  if (globalRecorder) return;
  if (!readPersistedRecorderLease()) return;
  const recorder = createGlobalRecorder();
  if (!recorder) return;
  globalRecorder = recorder;
  window.addEventListener(APP_DIAGNOSTICS_RECORDER_STATE_EVENT, () => syncGlobalRecorderState());
  syncGlobalRecorderState();
  emitAppDiagnosticsPerformance({
    category: "PERFORMANCE",
    metric: "RECORDER",
    phase: "RESTORED",
    value: 1
  });
}

export function getAppDiagnosticsRecorderState(): AppDiagnosticsRecorderState {
  ensureGlobalRecorder();
  syncGlobalRecorderState();
  return { ...globalRecorderState };
}

export async function startAppDiagnosticsVideoRecording(): Promise<void> {
  const diagnostics = getAppDiagnosticsClientState();
  if (!diagnostics.status?.isEnabled || !diagnostics.status.captureId) {
    throw new Error("App diagnostics must be enabled before recording.");
  }
  ensureGlobalRecorder();
  const recorder = globalRecorder ?? createGlobalRecorder();
  if (!recorder) {
    throw new Error("CAPTURE_HANDLE_UNAVAILABLE");
  }
  globalRecorder = recorder;
  const current = recorder.getState();
  if (current.status === "REQUESTING" || current.status === "STOPPING") return;
  if (current.status === "RECORDING" && !current.paused) return;
  const update = () => syncGlobalRecorderState();
  window.addEventListener(APP_DIAGNOSTICS_RECORDER_STATE_EVENT, update, { once: true });
  await recorder.start();
  syncGlobalRecorderState();
  emitAppDiagnosticsPerformance({
    category: "PERFORMANCE",
    metric: "RECORDER",
    phase: "STARTED",
    value: 1
  });
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
  const state = globalRecorder?.getState();
  if (state && state.status === "RECORDING" && state.paused) {
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE",
      metric: "RECORDER",
      phase: "RESTORED_SKIP",
      value: 1
    });
    return;
  }
  void stopAppDiagnosticsVideoRecording("PAGE_HIDE");
});
