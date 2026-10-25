import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDiagnosticsVideoLease } from "@space/contracts";
import {
  createAppDiagnosticsVideoRecorder,
  type AppDiagnosticsMediaRecorder
} from "../src/app-diagnostics/app-diagnostics-video-recorder.js";

const lease: AppDiagnosticsVideoLease = {
  leaseId: "app_debug_lease:video0001",
  captureId: "app_debug_capture:video0001",
  clientId: "app_debug_client:video0001",
  pageClientId: "app_debug_page:video0001",
  userId: "user:admin",
  status: "ACTIVE",
  acquiredAt: "2026-07-24T10:00:00.000Z",
  heartbeatAt: "2026-07-24T10:00:00.000Z",
  expiresAt: "2026-07-24T10:01:30.000Z",
  releasedAt: null
};

function webmBlob() {
  return new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: "video/webm;codecs=vp8" });
}

function mockTrack(handle = "space-app:page-handle") {
  const listeners = new Map<string, () => void>();
  return {
    kind: "video",
    stop: vi.fn(),
    getSettings: () => ({ displaySurface: "browser", width: 1920, height: 1080 }),
    getCaptureHandle: () => ({ handle, origin: window.location.origin }),
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type)
  } as unknown as MediaStreamTrack;
}

function mockStream(track: MediaStreamTrack) {
  return {
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
    getTracks: () => [track]
  } as unknown as MediaStream;
}

function recorderFactory(recorders: AppDiagnosticsMediaRecorder[]) {
  return vi.fn((_stream: MediaStream, options: MediaRecorderOptions) => {
    const recorder: AppDiagnosticsMediaRecorder = {
      state: "inactive",
      mimeType: "video/webm;codecs=vp8",
      ondataavailable: null,
      onerror: null,
      onstop: null,
      start: vi.fn(() => {
        recorder.state = "recording";
      }),
      stop: vi.fn(() => {
        recorder.state = "inactive";
        recorder.ondataavailable?.({ data: webmBlob() } as BlobEvent);
        recorder.onstop?.(new Event("stop"));
      })
    };
    expect(options.videoBitsPerSecond).toBe(500_000);
    recorders.push(recorder);
    return recorder;
  });
}

function setup(input: {
  handle?: string;
  upload?: () => Promise<void>;
  permissionError?: Error;
  deferDisplayMedia?: boolean;
} = {}) {
  const sourceTrack = mockTrack(input.handle);
  const sourceStream = mockStream(sourceTrack);
  const outputTrack = mockTrack("output");
  const outputStream = mockStream(outputTrack);
  const recorders: AppDiagnosticsMediaRecorder[] = [];
  const upload = vi.fn(input.upload ?? (async () => undefined));
  const api = {
    acquireLease: vi.fn(async () => lease),
    heartbeatLease: vi.fn(async () => lease),
    releaseLease: vi.fn(async () => ({ ...lease, status: "RELEASED" as const, releasedAt: "2026-07-24T10:00:30.000Z" })),
    uploadSegment: upload
  };
  let resolveDisplayMedia: (() => void) | null = null;
  const deferredDisplayMedia = input.deferDisplayMedia
    ? new Promise<MediaStream>((resolvePromise) => {
        resolveDisplayMedia = () => resolvePromise(sourceStream);
      })
    : null;
  const getDisplayMedia = input.permissionError
    ? vi.fn(async () => { throw input.permissionError; })
    : vi.fn(async () => deferredDisplayMedia ?? sourceStream);
  const downsample = vi.fn(async () => ({
    stream: outputStream,
    stop: vi.fn()
  }));
  const recorder = createAppDiagnosticsVideoRecorder({
    captureId: lease.captureId,
    clientId: lease.clientId,
    pageClientId: lease.pageClientId,
    captureHandle: "space-app:page-handle",
    origin: window.location.origin,
    api,
    getDisplayMedia,
    configureCaptureHandle: vi.fn(),
    createDownsampledStream: downsample,
    createMediaRecorder: recorderFactory(recorders),
    getLastEventSequence: () => 42
  });
  return {
    api,
    downsample,
    getDisplayMedia,
    outputTrack,
    recorder,
    recorders,
    resolveDisplayMedia: () => resolveDisplayMedia?.(),
    sourceTrack,
    upload
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("app diagnostics video recorder", () => {
  it("records the verified current Space tab at 720p/5fps/no-audio and uploads independent 30 second WebM segments", async () => {
    vi.useFakeTimers();
    const { api, downsample, getDisplayMedia, recorder, recorders, upload } = setup();

    await recorder.start();
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: false,
      preferCurrentTab: true,
      video: expect.objectContaining({ frameRate: 5, width: 1280, height: 720 })
    }));
    expect(downsample).toHaveBeenCalledWith(expect.anything(), {
      width: 1280,
      height: 720,
      fps: 5
    });
    expect(recorders).toHaveLength(1);
    expect(recorder.getState().status).toBe("RECORDING");

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: lease.leaseId,
      sequence: 0,
      firstEventSequence: 42,
      lastEventSequence: 42,
      mimeType: "video/webm;codecs=vp8"
    }), expect.any(Uint8Array));
    expect(recorders).toHaveLength(2);
    expect(api.heartbeatLease).toHaveBeenCalledWith(lease.leaseId, lease.captureId);

    await recorder.stop("USER");
    expect(api.releaseLease).toHaveBeenCalledWith(lease.leaseId);
  });

  it("releases the lease and records nothing after permission denial or a mismatched capture handle", async () => {
    const denied = setup({ permissionError: new DOMException("denied", "NotAllowedError") });
    await denied.recorder.start();
    expect(denied.recorder.getState()).toMatchObject({ status: "ERROR", errorCode: "PERMISSION_DENIED" });
    expect(denied.api.releaseLease).toHaveBeenCalledWith(lease.leaseId);
    expect(denied.upload).not.toHaveBeenCalled();

    const mismatch = setup({ handle: "some-other-tab" });
    await mismatch.recorder.start();
    expect(mismatch.recorder.getState()).toMatchObject({ status: "ERROR", errorCode: "CAPTURE_HANDLE_MISMATCH" });
    expect(mismatch.sourceTrack.stop).toHaveBeenCalled();
    expect(mismatch.api.releaseLease).toHaveBeenCalledWith(lease.leaseId);
    expect(mismatch.upload).not.toHaveBeenCalled();
  });

  it("stops recording when a prior segment is still uploading at the next boundary", async () => {
    vi.useFakeTimers();
    const { api, recorder, upload } = setup({
      upload: () => new Promise<void>(() => undefined)
    });
    await recorder.start();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(recorder.getState().errorCode).toBe("UPLOAD_BACKPRESSURE"));

    expect(recorder.getState().status).toBe("ERROR");
    expect(api.releaseLease).toHaveBeenCalledWith(lease.leaseId);
  });

  it("waits for an already completed segment upload before releasing a user-stopped lease", async () => {
    vi.useFakeTimers();
    let resolveUpload!: () => void;
    const uploadFlight = new Promise<void>((resolvePromise) => {
      resolveUpload = resolvePromise;
    });
    const { api, recorder, upload } = setup({ upload: () => uploadFlight });
    await recorder.start();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const stopFlight = recorder.stop("USER");
    await Promise.resolve();
    expect(api.releaseLease).not.toHaveBeenCalled();

    resolveUpload();
    await stopFlight;
    expect(api.releaseLease).toHaveBeenCalledWith(lease.leaseId);
  });

  it("does not start after Debug turns off while browser tab permission is pending", async () => {
    const { api, downsample, getDisplayMedia, recorder, recorders, resolveDisplayMedia, sourceTrack } =
      setup({ deferDisplayMedia: true });

    const startFlight = recorder.start();
    await vi.waitFor(() => expect(getDisplayMedia).toHaveBeenCalledTimes(1));
    await recorder.stop("DEBUG_OFF");
    resolveDisplayMedia();
    await startFlight;

    expect(downsample).not.toHaveBeenCalled();
    expect(recorders).toHaveLength(0);
    expect(sourceTrack.stop).toHaveBeenCalled();
    expect(api.releaseLease).toHaveBeenCalledWith(lease.leaseId);
    expect(recorder.getState()).toMatchObject({ status: "IDLE", errorCode: null });
  });
});
