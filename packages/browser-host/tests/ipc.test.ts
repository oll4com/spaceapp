import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserCaptureJob, Pane } from "@space/contracts";
import {

  BrowserHostClient,
  BrowserHostError,
  BrowserHostFrameDecoder,
  createBrowserHostServer,
  encodeBrowserHostFrame,
  type BrowserHostBinaryFrame,
  type BrowserHostRequestHandler,
  type BrowserHostStreamHandle
} from "../src/index.js";

// Unix socket paths are limited to about 107 bytes; a long TMPDIR would make listen() fail.
const socketTmp = tmpdir().length > 40 ? "/tmp" : tmpdir();

function fakeFrame(sequence: number): BrowserHostBinaryFrame {
  return {
    sessionId: "browser_session:test",
    sequence,
    data: Buffer.from(`jpeg-${sequence}`),
    mimeType: "image/jpeg",
    capturedAt: "2026-07-12T00:00:00.000Z",
    metadata: { pageScaleFactor: 1 }
  };
}

function fakeCaptureJob(status: BrowserCaptureJob["status"]): BrowserCaptureJob {
  return {
    jobId: "browser_capture_job:test",
    sessionId: "browser_session:test",
    paneId: "pane:test",
    roomId: "room:test",
    requestedByType: "OPERATOR",
    requestedById: "user:test",
    status,
    options: {
      kind: "RECORDING",
      format: "WEBM",
      maxDurationMs: 60_000,
      maxBytes: 1_073_741_824,
      frameIntervalMs: 100
    },
    progressPercent: status === "COMPLETED" ? 100 : 20,
    statusReason: status === "COMPLETED" ? "Capture stopped and saved." : "Capture cancelled.",
    artifactIds: [],
    queuedAt: "2026-07-12T00:00:00.000Z",
    startedAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:01.000Z",
    completedAt: "2026-07-12T00:00:01.000Z"
  };
}

describe("Browser host IPC", () => {
  it("keeps pane ordering without blocking other panes or health behind a slow navigation", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-host-queues-"));
    const socketPath = join(root, "host.sock");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const calls: string[] = [];
    const handler: BrowserHostRequestHandler = {
      async health() { return { hostPid: 123 } as Awaited<ReturnType<BrowserHostRequestHandler["health"]>>; },
      async request(method, params) {
        const id = (params.pane as Pane | undefined)?.id ?? method;
        calls.push(id);
        if (calls.length === 1) { entered(); await gate; }
        return null;
      },
      async startFrameStream() { throw new Error("unused"); }
    };
    const server = await createBrowserHostServer({ socketPath, handler });
    const client = new BrowserHostClient({ socketPath, requestTimeoutMs: 1000, healthTimeoutMs: 250 });
    const a = { id: "a" } as Pane;
    const b = { id: "b" } as Pane;
    try {
      const first = client.navigate(a, "https://example.com/", "test");
      await began;
      const second = client.navigate(a, "https://example.com/next", "test");
      await client.navigate(b, "https://example.com/", "test");
      await expect(client.health()).resolves.toMatchObject({ hostPid: 123 });
      expect(calls).toEqual(["a", "b"]);
      const barrier = client.stopRoom("room:test", "test");
      const afterBarrier = client.navigate(b, "https://example.com/last", "test");
      release();
      await Promise.all([first, second, barrier, afterBarrier]);
      expect(calls).toEqual(["a", "b", "a", "stopRoom", "b"]);
    } finally {
      release();
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a slow Google account check beside pane work instead of as a barrier", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-host-google-check-"));
    const socketPath = join(root, "host.sock");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const handler: BrowserHostRequestHandler = {
      async health() { return { hostPid: 123 } as Awaited<ReturnType<BrowserHostRequestHandler["health"]>>; },
      async request(method, params) {
        calls.push(method === "checkGoogleAccount" ? `check:${String((params.identity as { accountId: string }).accountId)}:${String(params.launch)}` : (params.pane as Pane).id);
        if (method === "checkGoogleAccount") { await gate; return { status: "CONNECTED", reason: "VERIFIED", checkedAt: null, connectedAt: null }; }
        return null;
      },
      async startFrameStream() { throw new Error("unused"); },
      async startAudioStream() { throw new Error("unused"); }
    };
    const server = await createBrowserHostServer({ socketPath, handler });
    const client = new BrowserHostClient({ socketPath, requestTimeoutMs: 1000, healthTimeoutMs: 250 });
    try {
      const check = client.checkGoogleAccount({ ownerUserId: "user:test", accountId: "google_account:a" }, true, { holderType: "OPERATOR", holderId: "user:test" });
      await client.navigate({ id: "pane:other" } as Pane, "https://example.com/", "test");
      expect(calls).toEqual(["check:google_account:a:true", "pane:other"]);
      release();
      await expect(check).resolves.toMatchObject({ status: "CONNECTED" });
    } finally {
      release();
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a typed error when the Unix socket is unavailable", async () => {
    const client = new BrowserHostClient({ socketPath: join(socketTmp, `missing-browser-host-${process.pid}.sock`) });
    await expect(client.health()).rejects.toMatchObject({ code: "BROWSER_HOST_UNAVAILABLE" });
  });

  it("times out when a connected host never responds", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-host-timeout-"));
    const socketPath = join(root, "browser-host.sock");
    let acceptedSocket: Socket | null = null;
    const server = createServer((socket) => { acceptedSocket = socket; });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const client = new BrowserHostClient({ socketPath, requestTimeoutMs: 30, closeTimeoutMs: 30 });
    try {
      await expect(client.health()).rejects.toMatchObject({
        code: "BROWSER_HOST_TIMEOUT",
        details: { method: "health", timeoutMs: 30 }
      });
      await expect(client.close()).resolves.toBeUndefined();
    } finally {
      (acceptedSocket as Socket | null)?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("decodes fragmented and adjacent control frames", () => {
    const decoder = new BrowserHostFrameDecoder();
    const first = encodeBrowserHostFrame({ requestId: "one" });
    const second = encodeBrowserHostFrame({ requestId: "two" });
    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(2), second]))).toEqual([{ requestId: "one" }, { requestId: "two" }]);
  });

  it("reconnects after the Browser Host restarts on the same socket", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-host-reconnect-"));
    const socketPath = join(root, "browser-host.sock");
    let generation = 1;
    const handler = (): BrowserHostRequestHandler => ({
      async health() {
        return {
          hostPid: process.pid,
          startedAt: `2026-07-12T00:00:0${generation}.000Z`,
          buildCommit: String(generation).repeat(40),
          status: { enabled: true, statusReason: "ready", defaultUrl: "https://example.com/", checkedAt: "2026-07-12T00:00:00.000Z" },
          capacity: null,
          captureMetrics: {
            jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
            segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
          }
        };
      },
      async request() { return null; },
      async startFrameStream() { throw new Error("unused"); }
    });
    let server = await createBrowserHostServer({ socketPath, handler: handler() });
    const client = new BrowserHostClient({ socketPath, requestTimeoutMs: 1_000 });
    try {
      await expect(client.health()).resolves.toMatchObject({ buildCommit: "1".repeat(40) });
      await server.close();
      generation = 2;
      server = await createBrowserHostServer({ socketPath, handler: handler() });
      await expect(client.health()).resolves.toMatchObject({ buildCommit: "2".repeat(40) });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves health, typed failures and binary frame subscriptions on a protected socket", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-host-"));
    const socketPath = join(root, "browser-host.sock");
    let streamListener: ((frame: BrowserHostBinaryFrame) => void | Promise<void>) | null = null;
    let stopped = false;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const handler: BrowserHostRequestHandler = {
      async health() {
        return {
          hostPid: process.pid,
          startedAt: "2026-07-12T00:00:00.000Z",
          buildCommit: "a".repeat(40),
          status: { enabled: true, statusReason: "ready", defaultUrl: "https://example.com/", checkedAt: "2026-07-12T00:00:00.000Z" },
          capacity: { activeSessions: 1, maxSessions: 8, activeLiveWorkloads: 0, maxLiveWorkloads: 4 },
          captureMetrics: {
            jobs: { QUEUED: 1, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
            segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
          }
        };
      },
      async request(method, params) {
        requests.push({ method, params });
        if (method === "captureFrame") throw new BrowserHostError("BROWSER_CAPTURE_FAILED", "capture failed", { retryable: true });
        if (method === "stopCapture") return fakeCaptureJob("COMPLETED");
        if (method === "cancelCapture") return fakeCaptureJob("CANCELLED");
        return { method };
      },
      async startFrameStream(_params, onFrame) {
        streamListener = onFrame;
        return {
          id: "browser_stream:test",
          profile: { requestedMode: "REALTIME", resolvedMode: "REALTIME", framesPerSecond: 24, format: "jpeg", quality: 80 },
          async stop() { stopped = true; }
        } satisfies BrowserHostStreamHandle;
      }
    };
    const server = await createBrowserHostServer({ socketPath, handler });
    const client = new BrowserHostClient({ socketPath });
    try {
      expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
      await expect(client.health()).resolves.toMatchObject({
        hostPid: process.pid,
        capacity: { maxSessions: 8 },
        captureMetrics: { jobs: { QUEUED: 1 } }
      });
      await expect(client.captureFrame("browser_session:test")).rejects.toMatchObject<BrowserHostError>({
        code: "BROWSER_CAPTURE_FAILED",
        details: { retryable: true }
      });
      const pane = { id: "pane:test", roomId: "room:test", mode: "BROWSER", title: "Browser" } as Pane;
      await expect(client.dispatchInput(
        pane,
        { type: "POINTER", leaseId: "browser_lease:test", eventType: "mouseMoved", x: 10, y: 20 },
        "trace:input",
        { holderType: "OPERATOR", holderId: "user:test" }
      )).resolves.toBeUndefined();
      expect(requests).toContainEqual({
        method: "dispatchInput",
        params: expect.objectContaining({ pane, traceId: "trace:input" })
      });
      await expect(client.stopCapture(pane, "browser_capture_job:test", "trace:stop")).resolves.toMatchObject({
        status: "COMPLETED"
      });
      await expect(client.cancelCapture(pane, "browser_capture_job:test", "trace:cancel")).resolves.toMatchObject({
        status: "CANCELLED"
      });

      const frames: BrowserHostBinaryFrame[] = [];
      const stream = await client.startFrameStream("browser_session:test", "REALTIME", (frame) => frames.push(frame));
      await streamListener!(fakeFrame(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(frames).toEqual([expect.objectContaining({ sequence: 1, data: Buffer.from("jpeg-1") })]);
      await stream.stop();
      expect(stopped).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("stops connection-owned streams when the API transport disconnects", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-host-cleanup-"));
    const socketPath = join(root, "browser-host.sock");
    let stopped = false;
    const handler: BrowserHostRequestHandler = {
      async health() { throw new Error("unused"); },
      async request() { return null; },
      async startFrameStream() {
        return {
          id: "browser_stream:cleanup",
          profile: { requestedMode: "PREVIEW", resolvedMode: "PREVIEW", framesPerSecond: 1, format: "jpeg", quality: 55 },
          async stop() { stopped = true; }
        };
      }
    };
    const server = await createBrowserHostServer({ socketPath, handler });
    const client = new BrowserHostClient({ socketPath });
    try {
      await client.startFrameStream("browser_session:test", "PREVIEW", () => undefined);
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stopped).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("drops the socket after a request timeout so the next request reconnects", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-host-recover-"));
    const socketPath = join(root, "browser-host.sock");
    let connections = 0;
    const handler: BrowserHostRequestHandler = {
      async health() {
        return {
          hostPid: process.pid,
          startedAt: "2026-07-12T00:00:00.000Z",
          buildCommit: "b".repeat(40),
          status: { enabled: true, statusReason: "ready", defaultUrl: "https://example.com/", checkedAt: "2026-07-12T00:00:00.000Z" },
          capacity: null,
          captureMetrics: {
            jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
            segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
          }
        };
      },
      // First request hangs forever (simulates a stuck CDP call). Later ones succeed.
      async request(method) {
        if (connections < 1) return new Promise(() => undefined);
        return { method };
      }
    };
    const server = await createBrowserHostServer({ socketPath, handler });
    const client = new BrowserHostClient({ socketPath, requestTimeoutMs: 40, connectTimeoutMs: 100, closeTimeoutMs: 50 });
    try {
      await expect(client.captureFrame("browser_session:test")).rejects.toMatchObject({ code: "BROWSER_HOST_TIMEOUT" });
      connections += 1;
      // The hung server handler is still running on the old connection, but the
      // client must have dropped it: this request goes over a fresh socket.
      await expect(client.health()).resolves.toMatchObject({ buildCommit: "b".repeat(40) });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("times out a hung server handler request without blocking later requests on the same socket", async () => {
    const root = await mkdtemp(join(socketTmp, "space-browser-host-server-timeout-"));
    const socketPath = join(root, "browser-host.sock");
    const handler: BrowserHostRequestHandler = {
      async health() {
        return {
          hostPid: process.pid,
          startedAt: "2026-07-12T00:00:00.000Z",
          buildCommit: "c".repeat(40),
          status: { enabled: true, statusReason: "ready", defaultUrl: "https://example.com/", checkedAt: "2026-07-12T00:00:00.000Z" },
          capacity: null,
          captureMetrics: {
            jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
            segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
          }
        };
      },
      async request(method, params) {
        if (method === "captureFrame") return new Promise(() => undefined);
        return { method, params };
      }
    };
    const server = await createBrowserHostServer({ socketPath, handler, requestTimeoutMs: 40 });
    const client = new BrowserHostClient({ socketPath, requestTimeoutMs: 60_000 });
    try {
      await expect(client.captureFrame("browser_session:test")).rejects.toMatchObject({ code: "BROWSER_HOST_TIMEOUT" });
      // Same socket, but the server-side bound must have let the queue advance.
      await expect(client.health()).resolves.toMatchObject({ buildCommit: "c".repeat(40) });
    } finally {
      await client.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
