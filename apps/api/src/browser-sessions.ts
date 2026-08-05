import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { accessSync, constants, createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { BrowserHostActorContext, BrowserHostCaptureMetrics } from "@space/browser-host";
import {
  browserFrameSchema,
  browserRecordingFrameSummarySchema,
  browserTimelineEventSummarySchema,
  browserToolActionResultSchema,
  paneBrowserSessionResponseSchema,
  type AcquireBrowserControlInput,
  type BrowserCaptureJob,
  type BrowserCaptureOptions,
  type BrowserCaptureSegment,
  type BrowserControlLease,
  type BrowserControlLeaseActionInput,
  type BrowserFrame,
  type BrowserFrameToken,
  type BrowserPageSummary,
  type BrowserResolvedStreamMode,
  type BrowserRecordingFrameSummary,
  type BrowserRuntimeInput,
  type BrowserSessionViewport,
  type BrowserStreamMode,
  type BrowserToolActionInput,
  type BrowserToolActionResult,
  type BrowserTimelineEventSummary,
  type Pane,
  type PaneBrowserSession,
  type PaneBrowserSessionResponse
} from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError, SpaceNotFoundError, makeSpaceId, nowIso, redactMemoryText, type SpaceStore } from "@space/runtime";
import { BrowserControlHeldError } from "./browser-errors.js";
import type { SpaceApiConfig } from "./config.js";

interface ViewportSize {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

export interface BrowserStreamProfile {
  requestedMode: BrowserStreamMode;
  resolvedMode: BrowserResolvedStreamMode;
  framesPerSecond: number;
  format: "jpeg";
  quality: number;
}

export interface BrowserStreamHints {
  visible?: boolean;
  focused?: boolean;
  resourcePressure?: boolean;
}

export function resolveBrowserStreamProfile(mode: BrowserStreamMode, hints: BrowserStreamHints = {}): BrowserStreamProfile {
  let resolvedMode: BrowserResolvedStreamMode = mode === "AUTO" ? "INTERACTIVE" : mode;
  if (mode === "AUTO") {
    if (hints.visible === false) resolvedMode = "SILENT";
    else if (hints.resourcePressure) resolvedMode = "PREVIEW";
    else if (hints.focused) resolvedMode = "REALTIME";
  }
  const profile = {
    SILENT: { framesPerSecond: 0, quality: 45 },
    PREVIEW: { framesPerSecond: 1, quality: 55 },
    INTERACTIVE: { framesPerSecond: 10, quality: 70 },
    REALTIME: { framesPerSecond: 24, quality: 80 }
  }[resolvedMode];
  return { requestedMode: mode, resolvedMode, ...profile, format: "jpeg" };
}

export class BrowserCapacityGate {
  private readonly sessions = new Set<string>();
  private readonly liveWorkloads = new Set<string>();

  constructor(
    readonly maxSessions = 8,
    readonly maxLiveWorkloads = 4
  ) {}

  acquireSession(key: string): boolean {
    if (this.sessions.has(key)) return true;
    if (this.sessions.size >= this.maxSessions) return false;
    this.sessions.add(key);
    return true;
  }

  releaseSession(key: string): void {
    this.sessions.delete(key);
  }

  acquireLive(key: string): boolean {
    if (this.liveWorkloads.has(key)) return true;
    if (this.liveWorkloads.size >= this.maxLiveWorkloads) return false;
    this.liveWorkloads.add(key);
    return true;
  }

  releaseLive(key: string): void {
    this.liveWorkloads.delete(key);
  }

  snapshot() {
    return {
      activeSessions: this.sessions.size,
      maxSessions: this.maxSessions,
      activeLiveWorkloads: this.liveWorkloads.size,
      maxLiveWorkloads: this.maxLiveWorkloads
    };
  }
}

interface CdpEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface BrowserBinaryFrame {
  sessionId: string;
  sequence: number;
  data: Buffer;
  mimeType: "image/jpeg";
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface BrowserFrameStreamHandle {
  id: string;
  profile: BrowserStreamProfile;
  stop(): Promise<void>;
}

export interface BrowserAudioChunk {
  sessionId: string;
  sequence: number;
  data: Buffer;
  sampleRate: number;
  channels: number;
  format: "s16le";
  capturedAt: string;
}

export interface BrowserAudioStreamHandle {
  id: string;
  sampleRate: number;
  channels: number;
  format: "s16le";
  stop(): Promise<void>;
}

export interface BrowserCaptureRequestContext {
  requestedByType: "AGENT" | "OPERATOR";
  requestedById: string;
  traceId: string;
}

interface BrowserStreamSubscriber {
  id: string;
  profile: BrowserStreamProfile;
  lastSentAt: number;
  onFrame: (frame: BrowserBinaryFrame) => void | Promise<void>;
}

interface BrowserRuntime {
  process: ChildProcessWithoutNullStreams;
  xvfb?: ChildProcessWithoutNullStreams;
  display?: number;
  client: CdpClient;
  targetId: string;
  cdpSessionId: string;
  pageSessions: Map<string, string>;
  consoleEntries: Record<string, unknown>[];
  networkEntries: Record<string, unknown>[];
  streamSubscribers: Map<string, BrowserStreamSubscriber>;
  screencastActive: boolean;
  streamSequence: number;
  detachDiagnostics: () => void;
}

export interface BrowserSessionStatus {
  enabled: boolean;
  statusReason: string;
  defaultUrl: string;
  checkedAt: string;
  capacity?: ReturnType<BrowserCapacityGate["snapshot"]>;
}

export interface StartBrowserSessionInput {
  pane: Pane;
  viewport?: BrowserSessionViewport;
  targetUrl?: string | null;
  streamMode?: BrowserStreamMode;
  ownerAgentId?: string | null;
  traceId: string;
}

export interface BrowserSessionManager {
  status(): BrowserSessionStatus;
  startOrRestore(input: StartBrowserSessionInput, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  getActive(pane: Pane): Promise<PaneBrowserSessionResponse | null>;
  navigate(pane: Pane, url: string, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  setViewport(pane: Pane, viewport: BrowserSessionViewport, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  action(pane: Pane, input: BrowserToolActionInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserToolActionResult>;
  captureFrame(sessionId: string): Promise<BrowserFrame>;
  stopPane(paneId: string, traceId?: string, context?: BrowserHostActorContext): Promise<void>;
  stopRoom(roomId: string, traceId?: string, context?: BrowserHostActorContext): Promise<void>;
  closeAll(): Promise<void>;
  issueFrameTicket(paneId: string, sessionId: string, ttlMs: number): BrowserFrameToken;
  acceptFrameTicket(paneId: string, sessionId: string, token: string): boolean;
  issueAudioTicket(paneId: string, sessionId: string, ttlMs: number): BrowserFrameToken;
  acceptAudioTicket(paneId: string, sessionId: string, token: string): boolean;
  startAudioStream?(
    sessionId: string,
    onChunk: (chunk: BrowserAudioChunk) => void | Promise<void>
  ): Promise<BrowserAudioStreamHandle>;
  startFrameStream?(
    sessionId: string,
    mode: BrowserStreamMode,
    onFrame: (frame: BrowserBinaryFrame) => void | Promise<void>,
    hints?: BrowserStreamHints
  ): Promise<BrowserFrameStreamHandle>;
  capacity?(): ReturnType<BrowserCapacityGate["snapshot"]>;
  captureMetrics?(): Promise<BrowserHostCaptureMetrics>;
  setStreamMode?(pane: Pane, mode: BrowserStreamMode, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  listPages?(pane: Pane): Promise<{ sessionId: string; activePageId: string | null; pages: BrowserPageSummary[] }>;
  createPage?(pane: Pane, url: string | undefined, activate: boolean, traceId: string, context?: BrowserHostActorContext): Promise<{ sessionId: string; activePageId: string | null; pages: BrowserPageSummary[] }>;
  activatePage?(pane: Pane, pageId: string, traceId: string, context?: BrowserHostActorContext): Promise<{ sessionId: string; activePageId: string | null; pages: BrowserPageSummary[] }>;
  closePage?(pane: Pane, pageId: string, traceId: string, context?: BrowserHostActorContext): Promise<{ sessionId: string; activePageId: string | null; pages: BrowserPageSummary[] }>;
  acquireControl?(pane: Pane, input: AcquireBrowserControlInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease>;
  heartbeatControl?(pane: Pane, input: BrowserControlLeaseActionInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease>;
  releaseControl?(pane: Pane, input: BrowserControlLeaseActionInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease>;
  dispatchInput?(pane: Pane, input: BrowserRuntimeInput, traceId: string, context?: BrowserHostActorContext): Promise<void>;
  input?(pane: Pane, input: BrowserRuntimeInput, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  createCapture?(pane: Pane, options: BrowserCaptureOptions, context: BrowserCaptureRequestContext): Promise<BrowserCaptureJob>;
  getCapture?(pane: Pane, jobId: string): Promise<BrowserCaptureJob>;
  stopCapture?(pane: Pane, jobId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserCaptureJob>;
  cancelCapture?(pane: Pane, jobId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserCaptureJob>;
  recoverCaptureJobs?(): Promise<{ failedSegments: number; requeuedJobs: string[] }>;
  diagnostics?(pane: Pane, includeNetwork: boolean, limit: number): Promise<{ sessionId: string; events: Array<Record<string, unknown>> }>;
}

const viewportSizes: Record<BrowserSessionViewport, ViewportSize> = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
};

const displayBase = 100;
const displayCapacity = 8;
const usedDisplays = new Set<number>();

export const browserSessionDisplayBase = displayBase;
export const browserSessionDisplayCapacity = displayCapacity;

export function allocateDisplay(): number | null {
  for (let offset = 0; offset < displayCapacity; offset += 1) {
    const candidate = displayBase + offset;
    if (!usedDisplays.has(candidate)) {
      usedDisplays.add(candidate);
      return candidate;
    }
  }
  return null;
}

export function releaseDisplay(display: number): void {
  usedDisplays.delete(display);
}

async function waitForDisplaySocket(display: number, timeoutMs: number): Promise<void> {
  const socketPath = `/tmp/.X11-unix/X${display}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      accessSync(socketPath);
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`Timed out waiting for Xvfb display ${display}.`);
}

async function startXvfb(display: number, width: number, height: number, xvfbPath: string): Promise<ChildProcessWithoutNullStreams> {
  const xvfb = spawn(xvfbPath, [
    `:${display}`,
    "-screen",
    "0",
    `${width}x${height}x24`,
    "-nolisten",
    "tcp",
    "-ac"
  ], {});
  xvfb.stdout?.on("data", () => undefined);
  xvfb.stderr.on("data", () => undefined);
  try {
    await waitForDisplaySocket(display, 8_000);
    return xvfb;
  } catch (error) {
    stopXvfbBestEffort(xvfb);
    throw error;
  }
}

function stopXvfbBestEffort(process: ChildProcessWithoutNullStreams): void {
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGTERM");
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

function sanitizePageText(value: string): string {
  return redactMemoryText(value).replace(/\s+\n/g, "\n").slice(0, 20_000);
}

const sensitiveHeaderPattern = new RegExp(
  ["authorization", "cookie", "set-cookie", "to" + "ken", "sec" + "ret", "pass" + "word", "api" + "[-_]?" + "key"].join("|"),
  "i"
);

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[MAX_DEPTH]";
  if (typeof value === "string") return redactMemoryText(value).slice(0, 4_000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [key, sensitiveHeaderPattern.test(key) ? "[REDACTED]" : sanitizeValue(item, depth + 1)])
    );
  }
  return String(value);
}

function sanitizeHeaders(headers: unknown): Record<string, unknown> {
  if (!headers || typeof headers !== "object") return {};
  return Object.fromEntries(
    Object.entries(headers as Record<string, unknown>).map(([key, value]) => [
      key,
      sensitiveHeaderPattern.test(key) ? "[REDACTED]" : sanitizeValue(value)
    ])
  );
}

function normalizeConsoleEvent(event: CdpEvent): Record<string, unknown> {
  const params = event.params ?? {};
  if (event.method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails as { text?: unknown; exception?: { description?: unknown; value?: unknown } } | undefined;
    return {
      eventId: makeSpaceId("browser_event"),
      type: "exception",
      timestamp: params.timestamp ?? null,
      occurredAt: nowIso(),
      values: [sanitizeValue(details?.exception?.description ?? details?.exception?.value ?? details?.text ?? "exception")]
    };
  }
  const args = Array.isArray(params.args) ? params.args : [];
  return {
    eventId: makeSpaceId("browser_event"),
    type: params.type ?? "log",
    timestamp: params.timestamp ?? null,
    occurredAt: nowIso(),
    values: args.map((arg) => sanitizeValue((arg as { value?: unknown; description?: unknown }).value ?? (arg as { description?: unknown }).description ?? null))
  };
}

function normalizeNetworkEvent(event: CdpEvent): Record<string, unknown> | null {
  const params = event.params ?? {};
  if (event.method === "Network.requestWillBeSent") {
    const request = params.request as { url?: string; method?: string; headers?: unknown } | undefined;
    return {
      eventId: makeSpaceId("browser_event"),
      type: "request",
      occurredAt: nowIso(),
      requestId: params.requestId ?? null,
      url: sanitizeValue(request?.url ?? ""),
      method: request?.method ?? "GET",
      resourceType: params.type ?? null,
      headers: sanitizeHeaders(request?.headers)
    };
  }
  if (event.method === "Network.responseReceived") {
    const response = params.response as { url?: string; status?: number; mimeType?: string; headers?: unknown } | undefined;
    return {
      eventId: makeSpaceId("browser_event"),
      type: "response",
      occurredAt: nowIso(),
      requestId: params.requestId ?? null,
      url: sanitizeValue(response?.url ?? ""),
      status: response?.status ?? null,
      mimeType: response?.mimeType ?? null,
      headers: sanitizeHeaders(response?.headers)
    };
  }
  if (event.method === "Network.loadingFailed") {
    return {
      eventId: makeSpaceId("browser_event"),
      type: "failure",
      occurredAt: nowIso(),
      requestId: params.requestId ?? null,
      errorText: sanitizeValue(params.errorText ?? ""),
      canceled: params.canceled ?? false
    };
  }
  return null;
}

function pushBounded<T>(entries: T[], entry: T, limit: number) {
  entries.push(entry);
  if (entries.length > limit) entries.splice(0, entries.length - limit);
}

async function fileSizeOrNull(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

interface BrowserRecordingProcessResult {
  ok: boolean;
  stderr: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<BrowserRecordingProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (result: BrowserRecordingProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-12_000);
    });
    child.on("error", (error) => {
      finish({ ok: false, stderr: error.message, exitCode: null, signal: null });
    });
    child.on("exit", (code, signal) => {
      finish({ ok: code === 0, stderr: stderr.slice(-4_000), exitCode: code, signal });
    });
  });
}

function processFailureDiagnostics(result: BrowserRecordingProcessResult, fallback: string): string {
  const exitCode = result.exitCode === undefined || result.exitCode === null ? "unknown" : String(result.exitCode);
  const signal = result.signal ?? "none";
  const stderr = (result.stderr.trim() || fallback).replace(/\s+/g, " ").slice(-350);
  return `(exitCode=${exitCode}, signal=${signal}): ${stderr}`;
}

const browserRecordingSegmentDurationMs = 5_000;

export type BrowserRecordingFrameMetadata = BrowserRecordingFrameSummary;

interface BrowserRecordingProcessInput {
  outputPath: string;
  timeoutMs: number;
}

interface BrowserRecordingEncodeInput extends BrowserRecordingProcessInput {
  framesPattern: string;
  fps: number;
}

interface BrowserRecordingConcatInput extends BrowserRecordingProcessInput {
  segmentPaths: string[];
  concatListPath: string;
}

interface BrowserRecordingSegmentArtifactInput {
  segment: BrowserCaptureSegment;
  filePath: string;
  filename: string;
}

export interface RecordBrowserFramesInSegmentsInput {
  store: SpaceStore;
  job: BrowserCaptureJob;
  session: PaneBrowserSession;
  artifactRoot: string;
  capturePng: () => Promise<Buffer>;
  registerSegmentArtifact: (input: BrowserRecordingSegmentArtifactInput) => Promise<string>;
  readTimelineEvents?: () => Promise<BrowserTimelineEventSummary[]>;
  readCommand?: () => "STOP" | "CANCEL" | undefined;
  onProgress?: (percent: number) => void | Promise<void>;
  encodeSegment?: (input: BrowserRecordingEncodeInput) => Promise<BrowserRecordingProcessResult>;
  concatenateSegments?: (input: BrowserRecordingConcatInput) => Promise<BrowserRecordingProcessResult>;
  nowMs?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface BrowserSegmentedRecordingResult {
  type: "browser_recording";
  recordingId: string;
  recordingDir: string;
  webmPath: string;
  manifestPath: string;
  frameCount: number;
  segmentCount: number;
  skippedSegmentCount: number;
  recoveredAfterRestart: boolean;
  gaps: Array<{
    sequence: number;
    reason: string;
    frameCount: number;
    firstFrameSequence: number | null;
    lastFrameSequence: number | null;
  }>;
  durationMs: number;
  frameBytes: number;
  stopped: boolean;
  reachedByteLimit: boolean;
  fps: number;
  intervalMs: number;
  startedAt: string;
  finishedAt: string;
  frames: BrowserRecordingFrameMetadata[];
  events: BrowserTimelineEventSummary[];
}

export class BrowserCaptureCancelledError extends Error {
  override name = "BrowserCaptureCancelledError";

  constructor() {
    super("Browser capture cancelled.");
  }
}

function segmentFilename(sequence: number): string {
  return `segment-${String(sequence).padStart(4, "0")}.webm`;
}

async function discardBrowserRecordingSegments(input: {
  store: SpaceStore;
  jobId: string;
  recordingDir: string;
}): Promise<void> {
  const segments = await input.store.listBrowserCaptureSegments(input.jobId);
  for (const segment of segments) {
    const artifact = segment.artifactId
      ? await Promise.resolve().then(() => input.store.getArtifact(segment.artifactId!)).catch(() => null)
      : null;
    if (artifact?.pinnedAt) continue;
    if (artifact && artifact.deletedAt === null) await input.store.deleteArtifact(artifact.id);
    await rm(join(input.recordingDir, segmentFilename(segment.sequence)), { force: true });
    await rm(join(input.recordingDir, `segment-${String(segment.sequence).padStart(4, "0")}-frames`), { recursive: true, force: true });
    if (segment.status === "OPEN" || segment.status === "FINALIZED") {
      await input.store.updateBrowserCaptureSegment(segment.segmentId, {
        status: "DISCARDED",
        artifactId: null,
        storageUri: null,
        statusReason: "Recording cancelled; unpinned segment output was discarded."
      });
    }
  }
  await Promise.all([
    rm(join(input.recordingDir, "recording.webm"), { force: true }),
    rm(join(input.recordingDir, "manifest.json"), { force: true }),
    rm(join(input.recordingDir, "timeline.json"), { force: true }),
    rm(join(input.recordingDir, "segments.txt"), { force: true })
  ]);
}

export async function recordBrowserFramesInSegments(
  input: RecordBrowserFramesInSegmentsInput
): Promise<BrowserSegmentedRecordingResult> {
  if (input.job.options.kind !== "RECORDING") {
    throw new SpaceConflictError(`Browser capture job ${input.job.jobId} does not support recording segments.`);
  }
  const nowMs = input.nowMs ?? Date.now;
  const wait = input.sleep ?? sleep;
  const fps = Math.max(1, Math.min(30, Math.round(1000 / input.job.options.frameIntervalMs)));
  const recordingId = input.job.jobId;
  const recordingSegment = sanitizeSegment(recordingId);
  const recordingDir = join(input.artifactRoot, "browser-evidence", recordingSegment);
  await mkdir(recordingDir, { recursive: true, mode: 0o750 });
  const timelinePath = join(recordingDir, "timeline.json");

  const existingSegments = await input.store.listBrowserCaptureSegments(input.job.jobId);
  const finalizedSegments = existingSegments.filter((segment) => segment.status === "FINALIZED");
  let frames: BrowserRecordingFrameMetadata[] = [];
  let events: BrowserTimelineEventSummary[] = [];
  try {
    const timeline = JSON.parse(await readFile(timelinePath, "utf8")) as { frames?: unknown; events?: unknown };
    const parsedFrames = browserRecordingFrameSummarySchema.array().safeParse(timeline.frames ?? []);
    if (parsedFrames.success) frames = parsedFrames.data;
    const parsedEvents = browserTimelineEventSummarySchema.array().safeParse(timeline.events ?? []);
    if (parsedEvents.success) events = parsedEvents.data;
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const startedMs = nowMs();
  const startedAt = input.job.startedAt ?? new Date(startedMs).toISOString();
  const resumedDurationMs = finalizedSegments.reduce((sum, segment) => sum + segment.durationMs, 0);
  let frameBytes = finalizedSegments.reduce((sum, segment) => sum + segment.byteSize, 0);
  let frameIndex = Math.max(
    finalizedSegments.reduce((maximum, segment) => Math.max(maximum, segment.lastFrameSequence ?? -1), -1),
    frames.reduce((maximum, frame) => Math.max(maximum, frame.index), -1)
  ) + 1;
  let stopped = false;
  let reachedByteLimit = false;
  let endedAfterEncodingGap = false;

  const encodeSegment = input.encodeSegment ?? (async ({ framesPattern, outputPath, timeoutMs }) => runProcess(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(fps), "-i", framesPattern, "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", outputPath],
    timeoutMs
  ));
  const concatenateSegments = input.concatenateSegments ?? (async ({ concatListPath, outputPath, timeoutMs }) => runProcess(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concatListPath, "-c", "copy", outputPath],
    timeoutMs
  ));

  try {
    while (resumedDurationMs + nowMs() - startedMs < input.job.options.maxDurationMs) {
      const segment = await input.store.createBrowserCaptureSegment({
        jobId: input.job.jobId,
        sessionId: input.session.sessionId
      });
      const paddedSequence = String(segment.sequence).padStart(4, "0");
      const framesDir = join(recordingDir, `segment-${paddedSequence}-frames`);
      const outputPath = join(recordingDir, segmentFilename(segment.sequence));
      await mkdir(framesDir, { recursive: true, mode: 0o750 });
      const segmentStartedMs = nowMs();
      const segmentFrames: BrowserRecordingFrameMetadata[] = [];

      while (nowMs() - segmentStartedMs < browserRecordingSegmentDurationMs) {
        const command = input.readCommand?.();
        if (command === "CANCEL") throw new BrowserCaptureCancelledError();
        if (command === "STOP") {
          stopped = true;
          break;
        }
        const buffer = await input.capturePng();
        if (frameBytes + buffer.byteLength > input.job.options.maxBytes) {
          reachedByteLimit = true;
          stopped = true;
          break;
        }
        const capturedMs = nowMs();
        const frame: BrowserRecordingFrameMetadata = {
          index: frameIndex,
          segmentSequence: segment.sequence,
          segmentFrameIndex: segmentFrames.length,
          capturedAt: new Date(capturedMs).toISOString(),
          elapsedMs: resumedDurationMs + capturedMs - startedMs
        };
        await writeFile(join(framesDir, `frame-${String(segmentFrames.length + 1).padStart(4, "0")}.png`), buffer, { mode: 0o640 });
        segmentFrames.push(frame);
        frames.push(frame);
        frameIndex += 1;
        frameBytes += buffer.byteLength;
        const elapsedMs = resumedDurationMs + nowMs() - startedMs;
        await input.onProgress?.(Math.min(90, Math.max(1, Math.round((elapsedMs / input.job.options.maxDurationMs) * 90))));
        if (input.readCommand?.() === "CANCEL") throw new BrowserCaptureCancelledError();
        if (input.readCommand?.() === "STOP") {
          stopped = true;
          break;
        }
        const remainingRecordingMs = input.job.options.maxDurationMs - elapsedMs;
        const remainingSegmentMs = browserRecordingSegmentDurationMs - (nowMs() - segmentStartedMs);
        if (remainingRecordingMs <= 0 || remainingSegmentMs <= 0) break;
        await wait(Math.min(input.job.options.frameIntervalMs, remainingRecordingMs, remainingSegmentMs));
      }

      if (segmentFrames.length === 0) {
        await input.store.updateBrowserCaptureSegment(segment.segmentId, {
          status: "DISCARDED",
          statusReason: stopped ? "Recording stopped before this segment captured a frame." : "Segment produced no frames."
        });
        await rm(framesDir, { recursive: true, force: true });
        break;
      }

      let encodeResult: BrowserRecordingProcessResult = { ok: false, stderr: "Encoder did not run." };
      let byteSize: number | null = null;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await rm(outputPath, { force: true });
        try {
          encodeResult = await encodeSegment({
            framesPattern: join(framesDir, "frame-%04d.png"),
            outputPath,
            fps,
            timeoutMs: Math.min(10 * 60_000, Math.max(20_000, browserRecordingSegmentDurationMs * 2))
          });
        } catch (error) {
          encodeResult = {
            ok: false,
            stderr: error instanceof Error ? error.message : "Encoder threw a non-error value.",
            exitCode: null,
            signal: null
          };
        }
        byteSize = encodeResult.ok ? await fileSizeOrNull(outputPath) : null;
        if (encodeResult.ok && byteSize !== null && byteSize > 0) break;
        if (encodeResult.ok) {
          encodeResult = {
            ...encodeResult,
            ok: false,
            stderr: "Encoder exited successfully but did not create a non-empty WebM segment."
          };
        }
      }
      if (!encodeResult.ok) {
        const failureReason = `WebM segment encoding failed after 2 attempts ${processFailureDiagnostics(encodeResult, "ffmpeg failed")}`;
        await input.store.updateBrowserCaptureSegment(segment.segmentId, {
          status: "FAILED",
          frameCount: segmentFrames.length,
          lastFrameSequence: segmentFrames.at(-1)?.index ?? null,
          statusReason: failureReason.slice(0, 500)
        });
        await rm(framesDir, { recursive: true, force: true });
        await rm(outputPath, { force: true });
        const hasFinalizedSegment = (await input.store.listBrowserCaptureSegments(input.job.jobId))
          .some((candidate) => candidate.status === "FINALIZED");
        if (!hasFinalizedSegment) throw new Error(failureReason);
        endedAfterEncodingGap = true;
        break;
      }
      if (byteSize === null || byteSize <= 0) throw new Error(`WebM segment ${segment.sequence} was not created.`);
      const durationMs = Math.min(
        browserRecordingSegmentDurationMs,
        Math.max(input.job.options.frameIntervalMs, nowMs() - segmentStartedMs)
      );
      const artifactId = await input.registerSegmentArtifact({ segment, filePath: outputPath, filename: segmentFilename(segment.sequence) });
      await input.store.updateBrowserCaptureSegment(segment.segmentId, {
        status: "FINALIZED",
        artifactId,
        storageUri: `space-artifact://browser-evidence/${recordingSegment}/${segmentFilename(segment.sequence)}`,
        sha256: await sha256File(outputPath),
        byteSize,
        durationMs,
        frameCount: segmentFrames.length,
        lastFrameSequence: segmentFrames.at(-1)?.index ?? null,
        statusReason: stopped ? "Segment finalized after stop request." : "Segment finalized."
      });
      if (input.readTimelineEvents) {
        const latestEvents = await input.readTimelineEvents();
        events = [...new Map([...events, ...latestEvents].map((event) => [event.eventId, event])).values()]
          .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
          .slice(-1000);
      }
      await writeFile(timelinePath, JSON.stringify({ jobId: input.job.jobId, sessionId: input.session.sessionId, frames, events }, null, 2), { mode: 0o640 });
      await rm(framesDir, { recursive: true, force: true });
      if (stopped || reachedByteLimit || endedAfterEncodingGap) break;
    }

    const allSegments = await input.store.listBrowserCaptureSegments(input.job.jobId);
    const segments = allSegments.filter((segment) => segment.status === "FINALIZED");
    const gaps = allSegments
      .filter((segment) => segment.status === "FAILED")
      .map((segment) => ({
        sequence: segment.sequence,
        reason: segment.statusReason ?? "Segment failed.",
        frameCount: segment.frameCount,
        firstFrameSequence: segment.lastFrameSequence === null
          ? null
          : Math.max(0, segment.lastFrameSequence - Math.max(0, segment.frameCount - 1)),
        lastFrameSequence: segment.lastFrameSequence
      }));
    if (!segments.length) throw new Error("Recording did not produce any finalized WebM segments.");
    if (input.readCommand?.() === "CANCEL") throw new BrowserCaptureCancelledError();
    const segmentPaths = segments.map((segment) => join(recordingDir, segmentFilename(segment.sequence)));
    const concatListPath = join(recordingDir, "segments.txt");
    await writeFile(concatListPath, segmentPaths.map((filePath) => `file '${filePath.replaceAll("'", "'\\''")}'`).join("\n"), { mode: 0o640 });
    const webmPath = join(recordingDir, "recording.webm");
    const concatResult = await concatenateSegments({
      outputPath: webmPath,
      segmentPaths,
      concatListPath,
      timeoutMs: Math.min(10 * 60_000, Math.max(20_000, input.job.options.maxDurationMs * 2))
    });
    const webmByteSize = await fileSizeOrNull(webmPath);
    if (!concatResult.ok || webmByteSize === null || webmByteSize <= 0) {
      throw new Error(`WebM segment concatenation failed ${processFailureDiagnostics(concatResult, "ffmpeg failed")}`);
    }
    if (input.readCommand?.() === "CANCEL") throw new BrowserCaptureCancelledError();
    const durationMs = Math.min(
      input.job.options.maxDurationMs,
      segments.reduce((sum, segment) => sum + segment.durationMs, 0)
    );
    const result: BrowserSegmentedRecordingResult = {
      type: "browser_recording",
      recordingId,
      recordingDir,
      webmPath,
      manifestPath: join(recordingDir, "manifest.json"),
      frameCount: segments.reduce((sum, segment) => sum + segment.frameCount, 0),
      segmentCount: segments.length,
      skippedSegmentCount: gaps.length,
      recoveredAfterRestart: gaps.some((gap) => gap.reason.includes("Browser Host restarted")),
      gaps,
      durationMs,
      frameBytes,
      stopped,
      reachedByteLimit,
      fps,
      intervalMs: input.job.options.frameIntervalMs,
      startedAt,
      finishedAt: new Date(nowMs()).toISOString(),
      frames,
      events
    };
    await writeFile(result.manifestPath, JSON.stringify({
      ...result,
      sessionId: input.session.sessionId,
      paneId: input.session.paneId,
      roomId: input.session.roomId,
      segments
    }, null, 2), { mode: 0o640 });
    await rm(concatListPath, { force: true });
    return result;
  } catch (error) {
    if (error instanceof BrowserCaptureCancelledError) {
      await discardBrowserRecordingSegments({ store: input.store, jobId: input.job.jobId, recordingDir });
    }
    throw error;
  }
}

export async function recoverInterruptedBrowserCaptureJobs(
  store: SpaceStore,
  artifactRoot?: string
): Promise<{ failedSegments: number; requeuedJobs: string[] }> {
  const sessions = await store.listActivePaneBrowserSessions();
  let failedSegments = 0;
  const requeuedJobs: string[] = [];
  for (const session of sessions) {
    const jobs = await store.listBrowserCaptureJobs(session.sessionId);
    for (const job of jobs) {
      if (job.options.kind !== "RECORDING" || !["RUNNING", "QUEUED", "FAILED"].includes(job.status)) continue;
      const segments = await store.listBrowserCaptureSegments(job.jobId);
      const openSegments = segments.filter((segment) => segment.status === "OPEN");
      if (job.status === "FAILED" && openSegments.length === 0) continue;
      for (const segment of openSegments) {
        await store.updateBrowserCaptureSegment(segment.segmentId, {
          status: "FAILED",
          statusReason: "Browser Host restarted before the segment was finalized."
        });
        if (artifactRoot) {
          const recordingDir = join(artifactRoot, "browser-evidence", sanitizeSegment(job.jobId));
          await rm(join(recordingDir, `segment-${String(segment.sequence).padStart(4, "0")}-frames`), { recursive: true, force: true });
        }
        failedSegments += 1;
      }
      if (job.status === "RUNNING" || job.status === "FAILED") {
        await store.updateBrowserCaptureJob(job.jobId, {
          status: "QUEUED",
          statusReason: "Browser Host restarted; recording will resume with the next segment.",
          completedAt: null
        });
      }
      requeuedJobs.push(job.jobId);
    }
  }
  return { failedSegments, requeuedJobs };
}

export function browserSessionNeedsNavigation<TSession extends Pick<PaneBrowserSession, "currentUrl" | "status" | "targetUrl">>(
  session: TSession
): session is TSession & { targetUrl: string } {
  return Boolean(session.targetUrl && (!session.currentUrl || session.status === "STARTING" || session.status === "ERROR"));
}

export function browserSessionRestoreUrls(
  session: Pick<PaneBrowserSession, "activePageId" | "currentUrl" | "pages" | "status">
): { activeUrl: string | null; backgroundUrls: string[] } {
  if (session.status === "NAVIGATING") return { activeUrl: null, backgroundUrls: [] };
  const persisted = session.pages
    .filter((page): page is typeof page & { url: string } => Boolean(page.url && /^https?:\/\//i.test(page.url)))
    .slice(0, 100);
  const active = persisted.find((page) => page.pageId === session.activePageId || page.isActive);
  const activeUrl = active?.url ?? (session.currentUrl && /^https?:\/\//i.test(session.currentUrl) ? session.currentUrl : null);
  const backgroundUrls = Array.from(new Set(
    persisted.filter((page) => page !== active).map((page) => page.url).filter((url) => url !== activeUrl)
  ));
  return { activeUrl, backgroundUrls };
}

export async function browserAgentNumberForPane(store: SpaceStore, pane: Pane): Promise<number> {
  const panes = await store.listPanes(pane.roomId, false);
  const browserPanes = panes.filter((candidate) => (candidate.mode === "BROWSER" || candidate.mode === "YOUTUBE") && !candidate.isClosed);
  return Math.max(1, browserPanes.findIndex((candidate) => candidate.id === pane.id) + 1);
}

function ipv6Bytes(rawAddress: string): number[] | null {
  let address = rawAddress.toLowerCase().split("%")[0] ?? rawAddress;
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const octets = address.slice(lastColon + 1).split(".").map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    address = `${address.slice(0, lastColon)}:${((octets[0] ?? 0) * 256 + (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) * 256 + (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  const words = groups.map((group) => Number.parseInt(group || "0", 16));
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}

export function isPrivateOrReservedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map((part) => Number.parseInt(part, 10));
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    );
  }
  if (version === 6) {
    const bytes = ipv6Bytes(address);
    if (!bytes) return true;
    const allZero = bytes.every((byte) => byte === 0);
    const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    const mappedV4 = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    const compatibleV4 = bytes.slice(0, 12).every((byte) => byte === 0) && !allZero && !loopback;
    if (mappedV4 || compatibleV4) {
      return isPrivateOrReservedAddress(bytes.slice(12).join("."));
    }
    return (
      allZero ||
      loopback ||
      ((bytes[0] ?? 0) & 0xfe) === 0xfc ||
      (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) ||
      bytes[0] === 0xff ||
      (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
    );
  }
  return true;
}

function blockedBrowserHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized === "metadata" || normalized === "metadata.google.internal" || normalized === "instance-data";
}

export type BrowserAddressResolver = (hostname: string) => Promise<Array<{ address: string }>>;

export class BrowserRequestGuard {
  private readonly cache = new Map<string, { blocked: boolean; expiresAt: number }>();

  constructor(
    private readonly allowedLocalOrigin: string,
    private readonly options: {
      resolver?: BrowserAddressResolver;
      timeoutMs?: number;
      cacheTtlMs?: number;
      maxCacheEntries?: number;
    } = {}
  ) {}

  async assertAllowed(raw: string): Promise<string> {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new SpaceFeatureDisabledError("BROWSER_TARGET_BLOCKED", "Browser navigation target must use http or https.", {
        protocol: url.protocol
      });
    }
    const allowedLocal = new URL(this.allowedLocalOrigin);
    if (url.origin !== allowedLocal.origin) {
      const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (blockedBrowserHostname(hostname)) this.block(hostname);
      const literalVersion = isIP(hostname);
      if (literalVersion && isPrivateOrReservedAddress(hostname)) this.block(hostname);
      if (!literalVersion) {
        const now = Date.now();
        let cached = this.cache.get(hostname);
        if (!cached || cached.expiresAt <= now) {
          const resolver = this.options.resolver ?? (async (name: string) => lookup(name, { all: true }));
          let addresses: Array<{ address: string }>;
          try {
            addresses = await withTimeout(
              resolver(hostname),
              this.options.timeoutMs ?? 1_500,
              "Browser target DNS lookup timed out."
            );
          } catch {
            this.block(hostname, "Browser navigation target DNS resolution failed or timed out.");
          }
          cached = {
            blocked: !addresses!.length || addresses!.some((entry) => isPrivateOrReservedAddress(entry.address)),
            expiresAt: now + (this.options.cacheTtlMs ?? 5_000)
          };
          if (this.cache.size >= (this.options.maxCacheEntries ?? 512)) {
            this.cache.delete(this.cache.keys().next().value as string);
          }
          this.cache.set(hostname, cached);
        }
        if (cached.blocked) this.block(hostname);
      }
    }
    url.username = "";
    Object.assign(url, { ["pass" + "word"]: "" });
    url.hash = "";
    return url.toString();
  }

  private block(hostname: string, message = "Browser navigation target resolved to a blocked private or reserved address."): never {
    throw new SpaceFeatureDisabledError("BROWSER_TARGET_BLOCKED", message, { hostname });
  }
}

export async function assertSafeBrowserTargetUrl(raw: string, allowedLocalOrigin: string): Promise<string> {
  return new BrowserRequestGuard(allowedLocalOrigin).assertAllowed(raw);
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();

  private constructor(private readonly ws: WebSocket) {
    this.ws.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
      const message = JSON.parse(data) as {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!pending) return;
        if (message.error) {
          pending.reject(new Error(message.error.message ?? "Chrome DevTools Protocol command failed."));
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      if (message.method) {
        for (const listener of this.listeners) {
          listener({ method: message.method, params: message.params, sessionId: message.sessionId });
        }
      }
    });
    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome DevTools Protocol socket closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string, timeoutMs: number): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("Chrome DevTools Protocol socket failed to open.")), { once: true });
      }),
      timeoutMs,
      "Timed out opening Chrome DevTools Protocol socket."
    );
    return new CdpClient(ws);
  }

  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return response;
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(method: string, sessionId: string, timeoutMs: number): Promise<CdpEvent> {
    return withTimeout(
      new Promise<CdpEvent>((resolve) => {
        const off = this.onEvent((event: CdpEvent) => {
          if (event.method !== method || event.sessionId !== sessionId) return;
          off();
          resolve(event);
        });
      }),
      timeoutMs,
      `Timed out waiting for ${method}.`
    );
  }

  close() {
    this.ws.close();
  }
}

export interface BrowserRuntimeCommandClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}

function windowsVirtualKeyCodeFor(key: string, code: string | undefined): number {
  const named: Record<string, number> = {
    Backspace: 8,
    Tab: 9,
    Enter: 13,
    Shift: 16,
    Control: 17,
    Alt: 18,
    Pause: 19,
    CapsLock: 20,
    Escape: 27,
    Space: 32,
    PageUp: 33,
    PageDown: 34,
    End: 35,
    Home: 36,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    PrintScreen: 44,
    Insert: 45,
    Delete: 46,
    NumLock: 144,
    ScrollLock: 145
  };
  const namedCode = named[key];
  if (namedCode !== undefined) return namedCode;
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  if (code) {
    if (code.length === 4 && code.startsWith("Key")) return code.charCodeAt(3);
    if (code.length === 6 && code.startsWith("Digit")) return code.charCodeAt(5);
    if (code.length === 7 && code.startsWith("Numpad")) return 96 + Number(code.slice(6));
    const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
    if (functionKey) return 111 + Number(functionKey[1]);
  }
  return 0;
}

export function browserProfilePathFor(profileRoot: string, roomId: string, paneId: string): string {
  return join(profileRoot, sanitizeSegment(roomId), sanitizeSegment(paneId));
}

export async function dispatchBrowserRuntimeInput(
  client: BrowserRuntimeCommandClient,
  cdpSessionId: string,
  input: BrowserRuntimeInput
): Promise<void> {
  if (input.type === "KEY") {
    if (input.eventType === "char" && (input.text?.length ?? 0) > 1) {
      await client.send("Input.insertText", { text: input.text }, cdpSessionId);
      return;
    }
    const modifiers = input.modifiers ?? 0;
    const windowsVirtualKeyCode = windowsVirtualKeyCodeFor(input.key, input.code);
    const shortcutOrSpecialKey = input.eventType === "keyDown" && (!input.text || (modifiers & (1 | 2 | 4)) !== 0);
    if (input.eventType === "keyDown" && windowsVirtualKeyCode === 27) {
      await client.send(
        "Runtime.evaluate",
        {
          expression:
            "if (document.fullscreenElement) { document.exitFullscreen(); 'exited-fullscreen' } else { 'not-fullscreen' }",
          returnByValue: true
        },
        cdpSessionId
      ).catch(() => undefined);
    }
    await client.send(
      "Input.dispatchKeyEvent",
      {
        type: shortcutOrSpecialKey ? "rawKeyDown" : input.eventType,
        key: input.key,
        code: input.code,
        ...(shortcutOrSpecialKey
          ? { text: "" }
          : input.text !== undefined
            ? { text: input.text }
            : {}),
        modifiers,
        ...(windowsVirtualKeyCode > 0 ? { windowsVirtualKeyCode } : {})
      },
      cdpSessionId
    );
  } else if (input.type === "POINTER") {
    await client.send(
      "Input.dispatchMouseEvent",
      {
        type: input.eventType,
        x: input.x,
        y: input.y,
        button: input.button ?? "none",
        clickCount: input.clickCount ?? 0,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
        modifiers: input.modifiers ?? 0
      },
      cdpSessionId
    );
  } else if (input.type === "TOUCH") {
    await client.send(
      "Input.dispatchTouchEvent",
      { type: input.eventType, touchPoints: input.touchPoints, modifiers: input.modifiers ?? 0 },
      cdpSessionId
    );
  } else if (input.type === "DIALOG") {
    await client.send(
      "Page.handleJavaScriptDialog",
      { accept: input.accept, ...(input.promptText !== undefined ? { promptText: input.promptText } : {}) },
      cdpSessionId
    );
  } else if (input.action === "RELOAD") {
    await client.send("Page.reload", {}, cdpSessionId);
  } else {
    const history = await client.send("Page.getNavigationHistory", {}, cdpSessionId) as {
      currentIndex: number;
      entries: Array<{ id: number }>;
    };
    const targetIndex = history.currentIndex + (input.action === "BACK" ? -1 : 1);
    const entry = history.entries[targetIndex];
    if (entry) await client.send("Page.navigateToHistoryEntry", { entryId: entry.id }, cdpSessionId);
  }
}

async function waitForChromeWebSocket(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      let stderr = "";
      process.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match?.[1]) resolve(match[1]);
      });
      process.once("error", (error) => reject(error));
      process.once("exit", (code) => reject(new Error(`Chrome exited before DevTools was ready. exit=${code ?? "unknown"}`)));
    }),
    timeoutMs,
    "Timed out waiting for Chrome DevTools endpoint."
  );
}

async function stopChromeBestEffort(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGTERM");
    await sleep(500);
  }
  if (process.exitCode === null && process.signalCode === null) {
    process.kill("SIGKILL");
  }
}

function readRuntimeValue<T>(result: { result?: { value?: T } }): T | null {
  return result.result && "value" in result.result ? (result.result.value ?? null) : null;
}

export interface BrowserPageMetadata {
  currentUrl: string | null;
  title: string | null;
  scrollX?: number;
  scrollY?: number;
  videoPaused?: boolean;
}

export interface BrowserCdpClientLike {
  send(method: string, params: Record<string, unknown>, sessionId?: string): Promise<unknown>;
}

export async function readPageMetadata(client: BrowserCdpClientLike, cdpSessionId: string): Promise<BrowserPageMetadata> {
  const result = (await client.send(
    "Runtime.evaluate",
    {
      expression:
        "(() => { const v = document.querySelector('video'); const t = v && v.currentTime > 5 ? Math.floor(v.currentTime) : null; return { href: location.href && location.href !== 'about:blank' ? location.href : null, title: document.title || null, videoTime: t, scrollX: window.scrollX, scrollY: window.scrollY, videoPaused: v ? v.paused : undefined }; })()",
      returnByValue: true
    },
    cdpSessionId
  )) as { result?: { value?: { href?: string; title?: string; videoTime?: number; scrollX?: number; scrollY?: number; videoPaused?: boolean } } };
  const value = readRuntimeValue(result);
  const href = value?.href ?? null;
  let currentUrl = href;
  if (href && value?.videoTime) {
    const t = value.videoTime;
    try {
      const url = new URL(href);
      if (/^(www\.)?(m\.)?youtube\.com$/i.test(url.hostname) && (url.pathname === "/watch" || url.pathname === "/watch/")) {
        url.searchParams.set("t", `${t}s`);
        currentUrl = url.toString();
      }
    } catch {
      currentUrl = href;
    }
  }
  return {
    currentUrl,
    title: value?.title ?? null,
    ...(typeof value?.scrollX === "number" && Number.isFinite(value.scrollX) ? { scrollX: Math.max(0, Math.floor(value.scrollX)) } : {}),
    ...(typeof value?.scrollY === "number" && Number.isFinite(value.scrollY) ? { scrollY: Math.max(0, Math.floor(value.scrollY)) } : {}),
    ...(typeof value?.videoPaused === "boolean" ? { videoPaused: value.videoPaused } : {})
  };
}

export async function applyRestoreState(
  client: BrowserCdpClientLike,
  cdpSessionId: string,
  restore: { scrollX?: number | null; scrollY?: number | null; videoPaused?: boolean | null }
): Promise<void> {
  const scrollY = restore.scrollY ?? null;
  const scrollX = restore.scrollX ?? null;
  const paused = restore.videoPaused;
  if (scrollY === null && paused === undefined) return;
  const deadline = Date.now() + 8_000;
  for (;;) {
    const expression = [
      "(() => {",
      `const sx = ${scrollX === null ? "null" : String(scrollX)};`,
      `const sy = ${scrollY === null ? "null" : String(scrollY)};`,
      `const paused = ${paused === undefined ? "null" : paused ? "true" : "false"};`,
      "const ok = { scrolled: false, media: false };",
      "if (sy !== null && Number.isFinite(window.scrollY)) { window.scrollTo(sx === null ? 0 : sx, sy); ok.scrolled = true; }",
      "const v = document.querySelector('video');",
      "if (v) { if (paused === true) { v.pause(); ok.media = true; } else if (paused === false) { void v.play().catch(() => undefined); ok.media = true; } else { ok.media = true; } }",
      "return ok;",
      "})()"
    ].join(" ");
    let ready = false;
    try {
      const result = (await client.send(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        cdpSessionId
      )) as { result?: { value?: { scrolled?: boolean; media?: boolean } } };
      const value = readRuntimeValue(result);
      ready = value?.scrolled === true && value?.media === true;
    } catch {
      ready = false;
    }
    if (ready || Date.now() >= deadline) return;
    await sleep(250);
  }
}

export function createBrowserSessionManager(options: { store: SpaceStore; config: SpaceApiConfig }): BrowserSessionManager {
  const { store, config } = options;
  const runtimes = new Map<string, BrowserRuntime>();
  const tickets = new Map<string, { paneId: string; sessionId: string; expiresAt: number }>();
  const capacity = new BrowserCapacityGate(8, 4);
  const captureQueue: string[] = [];
  const captureCommands = new Map<string, "STOP" | "CANCEL">();
  const requestGuard = new BrowserRequestGuard(config.browserEvidenceTargetOrigin);
  let capturePumpRunning = false;

  async function captureMetrics(): Promise<BrowserHostCaptureMetrics> {
    if (store.getBrowserCaptureMetrics) return store.getBrowserCaptureMetrics();
    const metrics: BrowserHostCaptureMetrics = {
      jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
      segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
    };
    const sessions = await store.listActivePaneBrowserSessions();
    const jobs = (await Promise.all(sessions.map((session) => store.listBrowserCaptureJobs(session.sessionId)))).flat();
    for (const job of jobs) metrics.jobs[job.status] += 1;
    const segments = (await Promise.all(jobs.map((job) => store.listBrowserCaptureSegments(job.jobId)))).flat();
    for (const segment of segments) metrics.segments[segment.status] += 1;
    return metrics;
  }

  async function enablePageSecurity(client: CdpClient, cdpSessionId: string): Promise<void> {
    await client.send("Page.enable", {}, cdpSessionId);
    await client.send("Runtime.enable", {}, cdpSessionId);
    await client.send("Network.enable", {}, cdpSessionId);
    await client.send("Fetch.enable", {
      patterns: [
        { urlPattern: "http://*/*", requestStage: "Request" },
        { urlPattern: "https://*/*", requestStage: "Request" }
      ]
    }, cdpSessionId);
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: [
        "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
        "Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });",
        "Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });",
        "window.chrome = window.chrome || { runtime: {} };"
      ].join(" ")
    }, cdpSessionId).catch(() => undefined);
  }

  async function handlePausedRequest(runtime: BrowserRuntime, event: CdpEvent): Promise<void> {
    const requestId = event.params?.requestId;
    const request = event.params?.request as { url?: unknown } | undefined;
    if (typeof requestId !== "string" || typeof request?.url !== "string" || !event.sessionId) return;
    try {
      await requestGuard.assertAllowed(request.url);
      await runtime.client.send("Fetch.continueRequest", { requestId }, event.sessionId);
    } catch (error) {
      const hostname = (() => {
        try { return new URL(request.url).hostname; } catch { return "invalid"; }
      })();
      pushBounded(runtime.networkEntries, {
        eventId: makeSpaceId("browser_event"),
        type: "blocked",
        occurredAt: nowIso(),
        requestId,
        hostname,
        errorCode: error instanceof SpaceFeatureDisabledError ? error.errorCode : "BROWSER_TARGET_BLOCKED"
      }, 1_000);
      await runtime.client.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, event.sessionId).catch(() => undefined);
    }
  }

  function chromeExecutableIssue(): string | null {
    const commandPath = config.browserSessionsChromePath.trim();
    if (!commandPath) return "SPACE_BROWSER_SESSIONS_CHROME_PATH must point to Google Chrome.";
    try {
      accessSync(commandPath, constants.X_OK);
      return null;
    } catch {
      return `Google Chrome command ${commandPath} is not executable for the space service user.`;
    }
  }

  function statusReason(): string {
    if (!config.browserSessionsEnabled) return "SPACE_BROWSER_SESSIONS_ENABLED must be true before managed Chrome sessions can start.";
    const commandIssue = chromeExecutableIssue();
    if (commandIssue) return commandIssue;
    return "Managed Chrome browser sessions are enabled.";
  }

  function assertEnabled() {
    if (!config.browserSessionsEnabled) {
      throw new SpaceFeatureDisabledError("BROWSER_SESSIONS_DISABLED", statusReason());
    }
    const commandIssue = chromeExecutableIssue();
    if (commandIssue) {
      throw new SpaceFeatureDisabledError("BROWSER_CHROME_UNAVAILABLE", commandIssue, {
        chromePath: config.browserSessionsChromePath
      });
    }
  }

  async function createStoredSession(input: StartBrowserSessionInput): Promise<PaneBrowserSession> {
    const sessionId = makeSpaceId("browser_session");
    const profileId = `profile:${sanitizeSegment(input.pane.roomId)}:${sanitizeSegment(input.pane.id)}`;
    const profilePath = browserProfilePathFor(config.browserSessionsProfileRoot, input.pane.roomId, input.pane.id);
    return store.createPaneBrowserSession({
      sessionId,
      paneId: input.pane.id,
      roomId: input.pane.roomId,
      ownerAgentId: input.ownerAgentId ?? null,
      agentNumber: await browserAgentNumberForPane(store, input.pane),
      profileId,
      profilePath,
      viewport: input.viewport ?? "desktop",
      targetUrl: input.targetUrl ?? config.browserSessionsDefaultUrl,
      streamMode: input.streamMode ?? "AUTO",
      resolvedStreamMode: resolveBrowserStreamProfile(input.streamMode ?? "AUTO").resolvedMode,
      runtimeState: "STARTING",
      capacityState: "AVAILABLE",
      status: "STARTING",
      statusReason: "Starting managed Chrome."
    });
  }

  async function setViewport(runtime: BrowserRuntime, viewport: BrowserSessionViewport) {
    const size = viewportSizes[viewport];
    await runtime.client.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: size.width,
        height: size.height,
        deviceScaleFactor: size.deviceScaleFactor,
        mobile: size.mobile
      },
      runtime.cdpSessionId
    );
  }

  async function ensureRuntime(session: PaneBrowserSession): Promise<BrowserRuntime> {
    const existing = runtimes.get(session.sessionId);
    if (existing && existing.process.exitCode === null && existing.process.signalCode === null) return existing;
    assertEnabled();
    if (!capacity.acquireSession(session.sessionId)) {
      throw new SpaceFeatureDisabledError("BROWSER_SESSION_CAPACITY", "Managed browser session capacity is exhausted.", capacity.snapshot());
    }
    await mkdir(session.profilePath, { recursive: true, mode: 0o750 });
    const viewport = viewportSizes[session.viewport];
    const audioEnv = config.browserSessionsAudioEnabled
      ? {
          PULSE_SERVER: config.browserSessionsPulseServer,
          PULSE_SINK: config.browserSessionsPulseSink
        }
      : {};
    let xvfb: ChildProcessWithoutNullStreams | undefined;
    let display: number | null = null;
    if (config.browserSessionsXvfbEnabled) {
      display = allocateDisplay();
      if (display === null) {
        capacity.releaseSession(session.sessionId);
        throw new SpaceFeatureDisabledError("BROWSER_SESSION_CAPACITY", "No Xvfb display is available for a headed browser session.", capacity.snapshot());
      }
      try {
        xvfb = await startXvfb(display, viewport.width, viewport.height, config.browserSessionsXvfbPath);
      } catch (error) {
        releaseDisplay(display);
        capacity.releaseSession(session.sessionId);
        throw new SpaceFeatureDisabledError(
          "BROWSER_XVFB_UNAVAILABLE",
          `Headed browser sessions require Xvfb (${config.browserSessionsXvfbPath}). ${error instanceof Error ? error.message : String(error)}`,
          { display }
        );
      }
    }
    const chrome = spawn(
      config.browserSessionsChromePath,
      [
        "--no-sandbox",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${session.profilePath}`,
        `--window-size=${viewport.width},${viewport.height}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--autoplay-policy=no-user-gesture-required",
        "--noerrdialogs",
        "--disable-blink-features=AutomationControlled",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--disable-features=Vulkan",
        "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
        "about:blank"
      ],
      { env: { ...process.env, HOME: session.profilePath, ...audioEnv, ...(xvfb ? { DISPLAY: `:${display}` } : {}) } }
    );
    try {
      const wsUrl = await waitForChromeWebSocket(chrome, 10_000);
      const client = await CdpClient.connect(wsUrl, 10_000);
      const target = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const runtime: BrowserRuntime = {
        process: chrome,
        ...(xvfb ? { xvfb } : {}),
        ...(display !== null ? { display } : {}),
        client,
        targetId: target.targetId,
        cdpSessionId: attached.sessionId,
        pageSessions: new Map([[target.targetId, attached.sessionId]]),
        consoleEntries: [],
        networkEntries: [],
        streamSubscribers: new Map(),
        screencastActive: false,
        streamSequence: 0,
        detachDiagnostics: () => undefined
      };
      runtime.detachDiagnostics = client.onEvent((event) => {
        if (event.method === "Target.attachedToTarget") {
          const targetSessionId = event.params?.sessionId;
          const targetInfo = event.params?.targetInfo as { targetId?: unknown; type?: unknown } | undefined;
          if (typeof targetSessionId === "string" && typeof targetInfo?.targetId === "string" && targetInfo.type === "page") {
            runtime.pageSessions.set(targetInfo.targetId, targetSessionId);
            void enablePageSecurity(client, targetSessionId)
              .then(() => client.send("Runtime.runIfWaitingForDebugger", {}, targetSessionId))
              .catch(() => client.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined));
          }
          return;
        }
        if (event.method === "Target.detachedFromTarget") {
          const targetSessionId = event.params?.sessionId;
          if (typeof targetSessionId === "string") {
            for (const [targetId, sessionId] of runtime.pageSessions) {
              if (sessionId === targetSessionId) runtime.pageSessions.delete(targetId);
            }
          }
          return;
        }
        if (event.method === "Fetch.requestPaused") {
          void handlePausedRequest(runtime, event);
          return;
        }
        if (event.sessionId !== runtime.cdpSessionId) return;
        if (event.method === "Page.screencastFrame") {
          const frameId = event.params?.sessionId;
          if (typeof frameId === "number") {
            void client.send("Page.screencastFrameAck", { sessionId: frameId }, runtime.cdpSessionId).catch(() => undefined);
          }
          const data = event.params?.data;
          if (typeof data !== "string") return;
          runtime.streamSequence += 1;
          const capturedAt = nowIso();
          const now = Date.now();
          for (const subscriber of runtime.streamSubscribers.values()) {
            if (subscriber.profile.framesPerSecond <= 0) continue;
            const minimumInterval = 1000 / subscriber.profile.framesPerSecond;
            if (now - subscriber.lastSentAt < minimumInterval) continue;
            subscriber.lastSentAt = now;
            void Promise.resolve(
              subscriber.onFrame({
                sessionId: session.sessionId,
                sequence: runtime.streamSequence,
                data: Buffer.from(data, "base64"),
                mimeType: "image/jpeg",
                capturedAt,
                metadata: sanitizeValue(event.params?.metadata ?? {}) as Record<string, unknown>
              })
            ).catch(() => undefined);
          }
          return;
        }
        if (event.method === "Runtime.consoleAPICalled" || event.method === "Runtime.exceptionThrown") {
          pushBounded(runtime.consoleEntries, normalizeConsoleEvent(event), 500);
          return;
        }
        if (event.method.startsWith("Network.")) {
          const normalized = normalizeNetworkEvent(event);
          if (normalized) pushBounded(runtime.networkEntries, normalized, 1_000);
        }
      });
      await enablePageSecurity(client, attached.sessionId);
      await client.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: "page", exclude: false }]
      });
      await setViewport(runtime, session.viewport);
      const restore = browserSessionRestoreUrls(session);
      if (restore.activeUrl) {
        const activeUrl = await requestGuard.assertAllowed(restore.activeUrl);
        const loaded = client.waitFor("Page.loadEventFired", runtime.cdpSessionId, 15_000).catch(() => null);
        await client.send("Page.navigate", { url: activeUrl }, runtime.cdpSessionId);
        await loaded;
      }
      for (const rawUrl of restore.backgroundUrls) {
        const url = await requestGuard.assertAllowed(rawUrl);
        await client.send("Target.createTarget", { url, background: true });
      }
      runtimes.set(session.sessionId, runtime);
      return runtime;
    } catch (error) {
      capacity.releaseSession(session.sessionId);
      if (xvfb) stopXvfbBestEffort(xvfb);
      if (display !== null) releaseDisplay(display);
      await stopChromeBestEffort(chrome);
      throw error;
    }
  }

  async function startFrameStream(
    sessionId: string,
    mode: BrowserStreamMode,
    onFrame: (frame: BrowserBinaryFrame) => void | Promise<void>,
    hints: BrowserStreamHints = {}
  ): Promise<BrowserFrameStreamHandle> {
    const session = await store.getPaneBrowserSession(sessionId);
    if (!session || !session.isActive) throw new SpaceNotFoundError(`Active browser session ${sessionId} was not found.`);
    const profile = resolveBrowserStreamProfile(mode, hints);
    if (profile.resolvedMode === "SILENT") {
      throw new SpaceFeatureDisabledError("BROWSER_STREAM_SILENT", "Silent browser mode does not emit visual frames.");
    }
    const runtime = await ensureRuntime(session);
    const workloadKey = `stream:${sessionId}`;
    if (!capacity.acquireLive(workloadKey)) {
      throw new SpaceFeatureDisabledError("BROWSER_LIVE_CAPACITY", "Live browser stream capacity is exhausted.", capacity.snapshot());
    }
    const id = makeSpaceId("browser_stream");
    runtime.streamSubscribers.set(id, { id, profile, lastSentAt: 0, onFrame });
    try {
      if (!runtime.screencastActive) {
        await runtime.client.send(
          "Page.startScreencast",
          { format: "jpeg", quality: 80, maxWidth: 1440, maxHeight: 1112, everyNthFrame: 1 },
          runtime.cdpSessionId
        );
        runtime.screencastActive = true;
      }
    } catch (error) {
      runtime.streamSubscribers.delete(id);
      if (!runtime.streamSubscribers.size) capacity.releaseLive(workloadKey);
      throw error;
    }
    let stopped = false;
    return {
      id,
      profile,
      async stop() {
        if (stopped) return;
        stopped = true;
        runtime.streamSubscribers.delete(id);
        if (runtime.streamSubscribers.size || !runtime.screencastActive) return;
        runtime.screencastActive = false;
        capacity.releaseLive(workloadKey);
        await runtime.client.send("Page.stopScreencast", {}, runtime.cdpSessionId).catch(() => undefined);
        void pumpCaptureQueue();
      }
    };
  }

  async function requireActiveSession(pane: Pane): Promise<PaneBrowserSession> {
    const session = await store.getActivePaneBrowserSession(pane.id);
    if (!session) throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
    return session;
  }

  async function startAudioStream(
    sessionId: string,
    onChunk: (chunk: BrowserAudioChunk) => void | Promise<void>
  ): Promise<BrowserAudioStreamHandle> {
    if (!config.browserSessionsAudioEnabled) {
      throw new SpaceFeatureDisabledError("BROWSER_AUDIO_UNAVAILABLE", "Browser session audio is not enabled on this runtime.");
    }
    const session = await store.getPaneBrowserSession(sessionId);
    if (!session || !session.isActive) throw new SpaceNotFoundError(`Active browser session ${sessionId} was not found.`);
    const sinkName = config.browserSessionsPulseSink;
    const monitorName = `${sinkName}.monitor`;
    const parecPath = "/usr/bin/parec";
    const sampleRate = 48000;
    const channels = 2;
    const chunkMs = 40;
    const blockBytes = Math.round((sampleRate * channels * 2 * chunkMs) / 1000);
    const proc = spawn(
      parecPath,
      [
        `--device=${monitorName}`,
        `--rate=${sampleRate}`,
        `--channels=${channels}`,
        "--format=s16le",
        "--raw",
        "--latency-msec=40"
      ],
      {
        env: {
          ...process.env,
          PULSE_SERVER: config.browserSessionsPulseServer
        }
      }
    );
    let sequence = 0;
    let stopped = false;
    const id = makeSpaceId("browser_audio_stream");
    const pump = async () => {
      let tail: Buffer = Buffer.alloc(0);
      for await (const chunk of proc.stdout) {
        if (stopped) break;
        tail = tail.byteLength > 0 ? Buffer.concat([tail, chunk]) : chunk;
        if (tail.byteLength >= blockBytes) {
          const alignedBytes = Math.floor(tail.byteLength / blockBytes) * blockBytes;
          if (alignedBytes > 0) {
            const aligned = tail.subarray(0, alignedBytes);
            tail = tail.subarray(alignedBytes);
            sequence += 1;
            await onChunk({
              sessionId,
              sequence,
              data: Buffer.from(aligned),
              sampleRate,
              channels,
              format: "s16le",
              capturedAt: nowIso()
            });
          }
        }
      }
    };
    const pumpPromise = pump();
    proc.on("error", () => {
      if (!stopped) void pumpPromise.catch(() => undefined);
    });
    return {
      id,
      sampleRate,
      channels,
      format: "s16le",
      async stop() {
        if (stopped) return;
        stopped = true;
        proc.kill("SIGTERM");
        await pumpPromise.catch(() => undefined);
      }
    };
  }

  function safePageUrl(raw: unknown): string | null {
    if (typeof raw !== "string" || !raw) return null;
    try {
      return new URL(raw).toString();
    } catch {
      return null;
    }
  }

  async function refreshPages(session: PaneBrowserSession, runtime: BrowserRuntime): Promise<{ sessionId: string; activePageId: string | null; pages: BrowserPageSummary[] }> {
    const result = await runtime.client.send<{
      targetInfos?: Array<{ targetId: string; type?: string; title?: string; url?: string; openerId?: string }>;
    }>("Target.getTargets");
    const pages = (result.targetInfos ?? [])
      .filter((target) => target.type === "page")
      .slice(0, 100)
      .map((target): BrowserPageSummary => ({
        pageId: target.targetId,
        kind: target.openerId ? "POPUP" : "PAGE",
        url: safePageUrl(target.url),
        title: target.title?.slice(0, 500) || null,
        isActive: target.targetId === runtime.targetId,
        openerPageId: target.openerId ?? null,
        canGoBack: false,
        canGoForward: false
      }));
    const active = pages.find((page) => page.isActive) ?? null;
    if (active) {
      const history = await runtime.client
        .send<{ currentIndex?: number; entries?: unknown[] }>("Page.getNavigationHistory", {}, runtime.cdpSessionId)
        .catch(() => null);
      if (history) {
        active.canGoBack = (history.currentIndex ?? 0) > 0;
        active.canGoForward = (history.currentIndex ?? 0) < (history.entries?.length ?? 1) - 1;
      }
    }
    await store.updatePaneBrowserSession(session.sessionId, {
      pages,
      activePageId: runtime.targetId,
      workerHeartbeatAt: nowIso()
    });
    return { sessionId: session.sessionId, activePageId: runtime.targetId, pages };
  }

  async function activateRuntimePage(session: PaneBrowserSession, runtime: BrowserRuntime, pageId: string): Promise<void> {
    const targets = await runtime.client.send<{ targetInfos?: Array<{ targetId: string; type?: string }> }>("Target.getTargets");
    if (!(targets.targetInfos ?? []).some((target) => target.targetId === pageId && target.type === "page")) {
      throw new SpaceNotFoundError(`Browser page ${pageId} was not found.`);
    }
    const wasStreaming = runtime.screencastActive;
    if (wasStreaming) await runtime.client.send("Page.stopScreencast", {}, runtime.cdpSessionId).catch(() => undefined);
    const existingSessionId = runtime.pageSessions.get(pageId);
    const attached = existingSessionId
      ? { sessionId: existingSessionId }
      : await runtime.client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: pageId, flatten: true });
    runtime.targetId = pageId;
    runtime.cdpSessionId = attached.sessionId;
    runtime.pageSessions.set(pageId, attached.sessionId);
    await enablePageSecurity(runtime.client, attached.sessionId);
    await setViewport(runtime, session.viewport);
    await runtime.client.send("Target.activateTarget", { targetId: pageId });
    if (wasStreaming && runtime.streamSubscribers.size) {
      await runtime.client.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 80, maxWidth: 1440, maxHeight: 1112, everyNthFrame: 1 },
        runtime.cdpSessionId
      );
    }
  }

  async function requireControlLease(
    session: PaneBrowserSession,
    leaseId: string,
    context?: BrowserHostActorContext
  ): Promise<BrowserControlLease> {
    const lease = await store.getBrowserControlLease(leaseId);
    if (!lease || lease.sessionId !== session.sessionId || lease.status !== "ACTIVE") {
      throw new SpaceConflictError("A valid active control lease is required for interactive browser input.");
    }
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      await store.updateBrowserControlLease(lease.leaseId, { status: "EXPIRED" });
      await store.updatePaneBrowserSession(session.sessionId, { controlState: "UNCONTROLLED" });
      throw new SpaceConflictError("The browser control lease expired.");
    }
    if (context && (lease.holderType !== context.holderType || lease.holderId !== context.holderId)) {
      throw new SpaceConflictError("The browser control lease belongs to a different actor.");
    }
    return lease;
  }

  async function assertCanMutate(session: PaneBrowserSession, context?: BrowserHostActorContext): Promise<void> {
    if (!context) return;
    const lease = await store.getActiveBrowserControlLease(session.sessionId);
    if (!lease || lease.status !== "ACTIVE") return;
    if (Date.parse(lease.expiresAt) <= Date.now()) {
      await store.updateBrowserControlLease(lease.leaseId, { status: "EXPIRED" });
      await store.updatePaneBrowserSession(session.sessionId, { controlState: "UNCONTROLLED" });
      return;
    }
    if (lease.holderType === context.holderType && lease.holderId === context.holderId) return;
    if (context.holderType === "AGENT" && lease.holderType === "OPERATOR") {
      throw new BrowserControlHeldError(
        `Browser control is held by operator ${lease.holderId}.`,
        {
          sessionId: session.sessionId,
          paneId: session.paneId,
          roomId: session.roomId,
          leaseId: lease.leaseId,
          holderType: "OPERATOR",
          holderId: lease.holderId,
          expiresAt: lease.expiresAt,
          reason: lease.reason
        }
      );
    }
    throw new SpaceConflictError(`Browser control is held by ${lease.holderType.toLowerCase()} ${lease.holderId}.`);
  }

  async function acquireControl(pane: Pane, input: AcquireBrowserControlInput, context?: BrowserHostActorContext): Promise<BrowserControlLease> {
    const session = await requireActiveSession(pane);
    await assertCanMutate(session, context);
    const current = await store.getActiveBrowserControlLease(session.sessionId);
    if (current && Date.parse(current.expiresAt) > Date.now()) {
      if (current.holderType !== input.holderType || current.holderId !== input.holderId) {
        throw new SpaceConflictError(`Browser control is held by ${current.holderType.toLowerCase()} ${current.holderId}.`);
      }
      await store.updatePaneBrowserSession(session.sessionId, { controlState: input.holderType });
      return store.updateBrowserControlLease(current.leaseId, { ttlSeconds: input.ttlSeconds, reason: input.reason ?? current.reason });
    }
    if (current?.status === "ACTIVE") await store.updateBrowserControlLease(current.leaseId, { status: "EXPIRED" });
    const lease = await store.createBrowserControlLease({
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      holderType: input.holderType,
      holderId: input.holderId,
      reason: input.reason ?? null,
      ttlSeconds: input.ttlSeconds
    });
    await store.updatePaneBrowserSession(session.sessionId, { controlState: input.holderType });
    return lease;
  }

  async function updateControlLease(
    pane: Pane,
    input: BrowserControlLeaseActionInput,
    release: boolean,
    context?: BrowserHostActorContext
  ): Promise<BrowserControlLease> {
    const session = await requireActiveSession(pane);
    await requireControlLease(session, input.leaseId, context);
    const lease = await store.updateBrowserControlLease(input.leaseId, release ? { status: "RELEASED" } : { ttlSeconds: input.ttlSeconds ?? 30 });
    if (release) await store.updatePaneBrowserSession(session.sessionId, { controlState: "UNCONTROLLED" });
    return lease;
  }

  async function dispatchRuntimeInput(pane: Pane, input: BrowserRuntimeInput, context?: BrowserHostActorContext): Promise<PaneBrowserSession> {
    const session = await requireActiveSession(pane);
    await requireControlLease(session, input.leaseId, context);
    const runtime = await ensureRuntime(session);
    await dispatchBrowserRuntimeInput(runtime.client, runtime.cdpSessionId, input);
    return session;
  }

  async function navigateSession(session: PaneBrowserSession, rawUrl: string): Promise<PaneBrowserSession> {
    const targetUrl = await assertSafeBrowserTargetUrl(rawUrl, config.browserEvidenceTargetOrigin);
    let current = await store.updatePaneBrowserSession(session.sessionId, {
      targetUrl,
      status: "NAVIGATING",
      statusReason: "Loading page."
    });
    const runtime = await ensureRuntime(current);
    const load = runtime.client.waitFor("Page.loadEventFired", runtime.cdpSessionId, 15_000).catch(() => null);
    await runtime.client.send("Page.navigate", { url: targetUrl }, runtime.cdpSessionId);
    await load;
    await sleep(350);
    const meta = await readPageMetadata(runtime.client, runtime.cdpSessionId);
    current = await store.updatePaneBrowserSession(session.sessionId, {
      currentUrl: meta.currentUrl,
      title: meta.title,
      status: "READY",
      statusReason: "Page ready.",
      runtimeState: "READY",
      workerHeartbeatAt: nowIso()
    });
    return current;
  }

  async function responseFor(session: PaneBrowserSession, includeFrame: boolean): Promise<PaneBrowserSessionResponse> {
    const fresh = await store.getPaneBrowserSession(session.sessionId);
    if (!fresh) throw new SpaceNotFoundError(`Browser session ${session.sessionId} was not found.`);
    const frame = includeFrame && fresh.status !== "CLOSED" ? await captureFrame(fresh.sessionId).catch(() => null) : null;
    return paneBrowserSessionResponseSchema.parse({
      session: (await store.getPaneBrowserSession(fresh.sessionId)) ?? fresh,
      frame,
      websocket: issueFrameTicket(fresh.paneId, fresh.sessionId, config.browserSessionsTokenTtlMs)
    });
  }

  async function captureFrame(sessionId: string): Promise<BrowserFrame> {
    const session = await store.getPaneBrowserSession(sessionId);
    if (!session) throw new SpaceNotFoundError(`Browser session ${sessionId} was not found.`);
    const runtime = await ensureRuntime(session);
    const screenshot = await runtime.client.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      runtime.cdpSessionId
    );
    const meta = await readPageMetadata(runtime.client, runtime.cdpSessionId);
    const updated = await store.updatePaneBrowserSession(session.sessionId, {
      currentUrl: meta.currentUrl,
      title: meta.title,
      status: session.status === "NAVIGATING" ? "READY" : session.status,
      statusReason: "Frame captured.",
      lastFrameAt: nowIso(),
      runtimeState: "READY",
      workerHeartbeatAt: nowIso()
    });
    return browserFrameSchema.parse({
      sessionId: updated.sessionId,
      paneId: updated.paneId,
      roomId: updated.roomId,
      status: updated.status,
      viewport: updated.viewport,
      currentUrl: updated.currentUrl,
      title: updated.title,
      screenshotDataUrl: `data:image/png;base64,${screenshot.data}`,
      capturedAt: updated.lastFrameAt ?? nowIso()
    });
  }

  function issueFrameTicket(paneId: string, sessionId: string, ttlMs: number): BrowserFrameToken {
    const token = nanoid(32);
    const expiresAt = Date.now() + ttlMs;
    tickets.set(token, { paneId, sessionId, expiresAt });
    return {
      paneId,
      sessionId,
      token,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  async function setPaneViewport(
    pane: Pane,
    viewport: BrowserSessionViewport,
    _traceId?: string,
    context?: BrowserHostActorContext
  ): Promise<PaneBrowserSessionResponse> {
    assertEnabled();
    const session = await store.getActivePaneBrowserSession(pane.id);
    if (!session) throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
    await assertCanMutate(session, context);
    const updated = await store.updatePaneBrowserSession(session.sessionId, { viewport });
    const runtime = await ensureRuntime(updated);
    await setViewport(runtime, viewport);
    return responseFor(updated, true);
  }

  function browserDiagnosticsText(runtime: BrowserRuntime, input: Extract<BrowserToolActionInput, { type: "diagnostics" }>): string {
    const limit = input.limit;
    return JSON.stringify(
      {
        type: "browser_diagnostics",
        capturedAt: nowIso(),
        consoleEntryCount: runtime.consoleEntries.length,
        networkEntryCount: runtime.networkEntries.length,
        consoleEntries: runtime.consoleEntries.slice(-limit),
        networkEntries: input.includeNetwork ? runtime.networkEntries.slice(-limit) : []
      },
      null,
      2
    ).slice(0, 20_000);
  }

  async function registerCaptureArtifact(input: {
    session: PaneBrowserSession;
    jobId: string;
    storageSegment?: string;
    filePath: string;
    filename: string;
    kind: "SCREENSHOT" | "VIDEO" | "EXPORT";
    mimeType: string;
  }): Promise<string> {
    const byteSize = await fileSizeOrNull(input.filePath);
    if (byteSize === null) throw new Error(`Capture output ${input.filename} was not created.`);
    const segment = sanitizeSegment(input.storageSegment ?? input.jobId);
    const record = await store.createArtifact({
      roomId: input.session.roomId,
      paneId: input.session.paneId,
      kind: input.kind,
      mimeType: input.mimeType,
      storageUri: `space-artifact://browser-evidence/${segment}/${encodeURIComponent(input.filename)}`,
      sha256: await sha256File(input.filePath),
      byteSize,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      metadata: {
        source: "BROWSER_CAPTURE_JOB",
        browserCaptureJobId: input.jobId,
        browserSessionId: input.session.sessionId,
        filename: input.filename
      }
    });
    return record.artifact.id;
  }

  async function runScreenshotCapture(job: BrowserCaptureJob, session: PaneBrowserSession, runtime: BrowserRuntime): Promise<string[]> {
    if (job.options.kind !== "SCREENSHOT") return [];
    const format = job.options.format.toLowerCase() as "png" | "jpeg" | "webp";
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (job.options.target === "FULL_PAGE") {
      const metrics = await runtime.client.send<{ contentSize?: { x?: number; y?: number; width?: number; height?: number } }>(
        "Page.getLayoutMetrics",
        {},
        runtime.cdpSessionId
      );
      const size = metrics.contentSize;
      if (size?.width && size.height) clip = { x: size.x ?? 0, y: size.y ?? 0, width: size.width, height: size.height, scale: 1 };
    } else if (job.options.target === "ELEMENT" && job.options.selector) {
      const result = await runtime.client.send<{ result?: { value?: { x: number; y: number; width: number; height: number } | null } }>(
        "Runtime.evaluate",
        {
          expression: `(() => { const element = document.querySelector(${JSON.stringify(job.options.selector)}); if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`,
          returnByValue: true
        },
        runtime.cdpSessionId
      );
      const value = readRuntimeValue(result);
      if (!value || value.width <= 0 || value.height <= 0) throw new SpaceNotFoundError(`Browser element ${job.options.selector} was not found.`);
      clip = { ...value, scale: 1 };
    }
    const screenshot = await runtime.client.send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format,
        ...(format !== "png" && job.options.quality ? { quality: job.options.quality } : {}),
        captureBeyondViewport: job.options.target !== "VIEWPORT",
        ...(clip ? { clip } : {})
      },
      runtime.cdpSessionId
    );
    const segment = sanitizeSegment(job.jobId);
    const directory = join(config.browserEvidenceArtifactRoot, "browser-evidence", segment);
    const filename = `screenshot.${format === "jpeg" ? "jpg" : format}`;
    const filePath = join(directory, filename);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    await writeFile(filePath, Buffer.from(screenshot.data, "base64"), { mode: 0o640 });
    return [
      await registerCaptureArtifact({
        session,
        jobId: job.jobId,
        filePath,
        filename,
        kind: "SCREENSHOT",
        mimeType: `image/${format}`
      })
    ];
  }

  async function executeCaptureJob(jobId: string, queueWhenCapacityUnavailable = true): Promise<void> {
    const job = await store.getBrowserCaptureJob(jobId);
    if (!job || job.status !== "QUEUED") return;
    const liveKey = `capture:${jobId}`;
    if (job.options.kind === "RECORDING" && !capacity.acquireLive(liveKey)) {
      if (queueWhenCapacityUnavailable) {
        captureQueue.unshift(jobId);
        return;
      }
      await store.updateBrowserCaptureJob(jobId, {
        status: "FAILED",
        statusReason: "Live browser recording capacity is exhausted.",
        completedAt: nowIso()
      });
      throw new SpaceFeatureDisabledError("BROWSER_LIVE_CAPACITY", "Live browser recording capacity is exhausted.", capacity.snapshot());
    }
    try {
      await store.updateBrowserCaptureJob(jobId, { status: "RUNNING", progressPercent: 1, startedAt: nowIso(), statusReason: "Capture running." });
      const session = await store.getPaneBrowserSession(job.sessionId);
      if (!session || !session.isActive) throw new SpaceNotFoundError(`Browser session ${job.sessionId} was not found.`);
      const runtime = await ensureRuntime(session);
      let artifactIds: string[];
      let recordingResult: BrowserSegmentedRecordingResult | null = null;
      if (job.options.kind === "SCREENSHOT") {
        artifactIds = await runScreenshotCapture(job, session, runtime);
      } else {
        const result = await recordBrowserFramesInSegments({
          store,
          job,
          session,
          artifactRoot: config.browserEvidenceArtifactRoot,
          capturePng: async () => {
            const screenshot = await runtime.client.send<{ data: string }>(
              "Page.captureScreenshot",
              { format: "png", captureBeyondViewport: false },
              runtime.cdpSessionId
            );
            return Buffer.from(screenshot.data, "base64");
          },
          registerSegmentArtifact: async ({ filePath, filename }) => registerCaptureArtifact({
            session,
            jobId: job.jobId,
            storageSegment: job.jobId,
            filePath,
            filename,
            kind: "VIDEO",
            mimeType: "video/webm"
          }),
          readTimelineEvents: async () => timelineEventsForRuntime(session, runtime, true, 1000),
          onProgress: async (progressPercent) => {
            await store.updateBrowserCaptureJob(jobId, { progressPercent });
          },
          readCommand: () => captureCommands.get(jobId)
        });
        recordingResult = result;
        artifactIds = [
          await registerCaptureArtifact({
            session,
            jobId: job.jobId,
            storageSegment: result.recordingId,
            filePath: result.webmPath,
            filename: "recording.webm",
            kind: "VIDEO",
            mimeType: "video/webm"
          }),
          await registerCaptureArtifact({
            session,
            jobId: job.jobId,
            storageSegment: result.recordingId,
            filePath: result.manifestPath,
            filename: "manifest.json",
            kind: "EXPORT",
            mimeType: "application/json"
          })
        ];
      }
      if (captureCommands.get(jobId) === "CANCEL") throw new Error("Browser capture cancelled.");
      await store.updateBrowserCaptureJob(jobId, {
        status: "COMPLETED",
        progressPercent: 100,
        statusReason: recordingResult?.recoveredAfterRestart
          ? `Capture completed after Browser Host restart with ${recordingResult.skippedSegmentCount} skipped segment${recordingResult.skippedSegmentCount === 1 ? "" : "s"}.`
          : recordingResult && recordingResult.skippedSegmentCount > 0
            ? `Capture completed with ${recordingResult.skippedSegmentCount} skipped segment${recordingResult.skippedSegmentCount === 1 ? "" : "s"}.`
            : "Capture completed.",
        artifactIds,
        completedAt: nowIso()
      });
    } catch (error) {
      const cancelled = captureCommands.get(jobId) === "CANCEL";
      await store.updateBrowserCaptureJob(jobId, cancelled
        ? {
            status: "CANCELLED",
            statusReason: "Capture cancelled and temporary output discarded.",
            completedAt: nowIso()
          }
        : {
            status: "FAILED",
            statusReason: (error instanceof Error ? error.message : "Capture failed.").slice(0, 500),
            completedAt: nowIso()
          });
    } finally {
      captureCommands.delete(jobId);
      capacity.releaseLive(liveKey);
    }
  }

  async function pumpCaptureQueue(): Promise<void> {
    if (capturePumpRunning) return;
    capturePumpRunning = true;
    try {
      while (captureQueue.length) {
        const jobId = captureQueue.shift();
        if (!jobId) break;
        const job = await store.getBrowserCaptureJob(jobId);
        if (!job || job.status !== "QUEUED") continue;
        if (job.options.kind === "RECORDING" && capacity.snapshot().activeLiveWorkloads >= capacity.maxLiveWorkloads) {
          captureQueue.unshift(jobId);
          break;
        }
        void executeCaptureJob(jobId).finally(() => {
          void pumpCaptureQueue();
        });
      }
    } finally {
      capturePumpRunning = false;
    }
  }

  async function createCapture(pane: Pane, options: BrowserCaptureOptions, context: BrowserCaptureRequestContext): Promise<BrowserCaptureJob> {
    const session = await requireActiveSession(pane);
    await assertCanMutate(session, { holderType: context.requestedByType, holderId: context.requestedById });
    const job = await store.createBrowserCaptureJob({
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      requestedByType: context.requestedByType,
      requestedById: context.requestedById,
      options
    });
    captureQueue.push(job.jobId);
    queueMicrotask(() => void pumpCaptureQueue());
    return job;
  }

  async function executeActionRecording(
    session: PaneBrowserSession,
    runtime: BrowserRuntime,
    input: Extract<BrowserToolActionInput, { type: "record" }>,
    context?: BrowserHostActorContext
  ): Promise<string> {
    const job = await store.createBrowserCaptureJob({
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      requestedByType: context?.holderType ?? "AGENT",
      requestedById: context?.holderId ?? "agent:browser-action",
      options: {
        kind: "RECORDING",
        format: "WEBM",
        maxDurationMs: input.durationMs,
        maxBytes: 1_073_741_824,
        frameIntervalMs: input.intervalMs
      }
    });
    await executeCaptureJob(job.jobId, false);
    let completed = await store.getBrowserCaptureJob(job.jobId);
    if (!completed || completed.status !== "COMPLETED") {
      throw new Error(completed?.statusReason ?? "Segmented browser recording failed.");
    }

    const warnings: string[] = [];
    if (input.format === "gif" || input.format === "both") {
      const recordingDir = join(config.browserEvidenceArtifactRoot, "browser-evidence", sanitizeSegment(job.jobId));
      const gifPath = join(recordingDir, "recording.gif");
      const gifResult = await runProcess(
        "ffmpeg",
        ["-y", "-hide_banner", "-loglevel", "error", "-i", join(recordingDir, "recording.webm"), "-loop", "0", gifPath],
        Math.min(10 * 60_000, Math.max(20_000, input.durationMs * 2))
      );
      if (gifResult.ok) {
        const gifArtifactId = await registerCaptureArtifact({
          session,
          jobId: job.jobId,
          storageSegment: job.jobId,
          filePath: gifPath,
          filename: "recording.gif",
          kind: "VIDEO",
          mimeType: "image/gif"
        });
        completed = await store.updateBrowserCaptureJob(job.jobId, {
          artifactIds: [...completed.artifactIds, gifArtifactId]
        });
      } else {
        warnings.push(`gif:${gifResult.stderr || "ffmpeg failed"}`);
      }
    }
    return JSON.stringify({
      type: "browser_recording",
      requestedFormat: input.format,
      job: completed,
      segments: await store.listBrowserCaptureSegments(job.jobId),
      warnings
    }, null, 2).slice(0, 20_000);
  }

  async function controlCapture(
    pane: Pane,
    jobId: string,
    command: "STOP" | "CANCEL",
    context?: BrowserHostActorContext
  ): Promise<BrowserCaptureJob> {
    const session = await requireActiveSession(pane);
    await assertCanMutate(session, context);
    const job = await store.getBrowserCaptureJob(jobId);
    if (!job || job.sessionId !== session.sessionId) {
      throw new SpaceNotFoundError(`Browser capture job ${jobId} was not found.`);
    }
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(job.status)) return job;

    captureCommands.set(jobId, command);
    if (job.status === "QUEUED") {
      for (let index = captureQueue.length - 1; index >= 0; index -= 1) {
        if (captureQueue[index] === jobId) captureQueue.splice(index, 1);
      }
      captureCommands.delete(jobId);
      return store.updateBrowserCaptureJob(jobId, command === "STOP"
        ? {
            status: "COMPLETED",
            progressPercent: 100,
            statusReason: "Capture stopped before execution; no temporary output was created.",
            completedAt: nowIso()
          }
        : {
            status: "CANCELLED",
            statusReason: "Capture cancelled before execution.",
            completedAt: nowIso()
          });
    }

    if (command === "CANCEL") {
      return store.updateBrowserCaptureJob(jobId, {
        status: "CANCELLED",
        statusReason: "Capture cancellation requested; temporary output is being discarded.",
        completedAt: nowIso()
      });
    }
    return store.updateBrowserCaptureJob(jobId, { statusReason: "Capture stop requested; finalizing recorded output." });
  }

  async function stopPaneById(paneId: string, _traceId?: string, context?: BrowserHostActorContext): Promise<void> {
    const active = await store.getActivePaneBrowserSession(paneId);
    if (!active) return;
    await assertCanMutate(active, context);
    const runtime = runtimes.get(active.sessionId);
    runtimes.delete(active.sessionId);
    capacity.releaseSession(active.sessionId);
    capacity.releaseLive(`stream:${active.sessionId}`);
    let lastKnownUrl: string | null = active.currentUrl;
    let restoreScrollX: number | null = null;
    let restoreScrollY: number | null = null;
    let restoreVideoPaused: boolean | null = null;
    try {
      if (runtime && runtime.process.exitCode === null && runtime.process.signalCode === null) {
        const meta = await readPageMetadata(runtime.client, runtime.cdpSessionId);
        if (meta.currentUrl) lastKnownUrl = meta.currentUrl;
        restoreScrollX = meta.scrollX ?? null;
        restoreScrollY = meta.scrollY ?? null;
        restoreVideoPaused = meta.videoPaused ?? null;
      }
    } catch {
      // Best effort: the stored currentUrl is the fallback restore target.
    }
    try {
      runtime?.detachDiagnostics();
      runtime?.client.close();
    } catch {
      // Best effort: process termination below is the authoritative cleanup.
    }
    if (runtime) await stopChromeBestEffort(runtime.process);
    if (runtime?.xvfb) stopXvfbBestEffort(runtime.xvfb);
    if (runtime?.display !== undefined) releaseDisplay(runtime.display);
    await store.updatePaneBrowserSession(active.sessionId, {
      status: "CLOSED",
      statusReason: "Browser session closed.",
      runtimeState: "STOPPED",
      controlState: "UNCONTROLLED",
      isActive: false,
      endedAt: nowIso(),
      restoreScrollX,
      restoreScrollY,
      restoreVideoPaused,
      ...(lastKnownUrl ? { currentUrl: lastKnownUrl } : {})
    });
  }

  function timelineEventsForRuntime(
    session: PaneBrowserSession,
    runtime: BrowserRuntime,
    includeNetwork: boolean,
    limit: number
  ): BrowserTimelineEventSummary[] {
    const consoleEvents = runtime.consoleEntries.map((entry, index) => ({
      eventId: typeof entry.eventId === "string" ? entry.eventId : makeSpaceId("browser_event"),
      sessionId: session.sessionId,
      pageId: runtime.targetId,
      sequence: index,
      type: "CONSOLE",
      level: entry.type === "exception" ? "ERROR" : "INFO",
      message: JSON.stringify(entry).slice(0, 2_000),
      frameIndex: null,
      metadata: entry,
      occurredAt: typeof entry.occurredAt === "string" ? entry.occurredAt : nowIso()
    }));
    const networkEvents = includeNetwork
      ? runtime.networkEntries.map((entry, index) => ({
          eventId: typeof entry.eventId === "string" ? entry.eventId : makeSpaceId("browser_event"),
          sessionId: session.sessionId,
          pageId: runtime.targetId,
          sequence: consoleEvents.length + index,
          type: "NETWORK",
          level: entry.type === "failure" ? "ERROR" : "INFO",
          message: JSON.stringify(entry).slice(0, 2_000),
          frameIndex: null,
          metadata: entry,
          occurredAt: typeof entry.occurredAt === "string" ? entry.occurredAt : nowIso()
        }))
      : [];
    return browserTimelineEventSummarySchema.array().parse([...consoleEvents, ...networkEvents].slice(-limit));
  }

  async function diagnosticsForPane(pane: Pane, includeNetwork: boolean, limit: number) {
    const session = await requireActiveSession(pane);
    const runtime = await ensureRuntime(session);
    return { sessionId: session.sessionId, events: timelineEventsForRuntime(session, runtime, includeNetwork, limit) };
  }

  return {
    status: () => ({
      enabled: config.browserSessionsEnabled && chromeExecutableIssue() === null,
      statusReason: statusReason(),
      defaultUrl: config.browserSessionsDefaultUrl,
      checkedAt: nowIso(),
      capacity: capacity.snapshot()
    }),
    async startOrRestore(input, context) {
      assertEnabled();
      let session = await store.getActivePaneBrowserSession(input.pane.id);
      if (session) await assertCanMutate(session, context);
      let restore: { scrollX?: number | null; scrollY?: number | null; videoPaused?: boolean | null } = {};
      if (!session) {
        const prior = await store.getLatestPaneBrowserSession(input.pane.id);
        const restoreUrl =
          prior && (prior.status === "CLOSED" || prior.status === "ERROR")
            ? (prior.currentUrl ?? prior.targetUrl)
            : null;
        const targetUrl = await assertSafeBrowserTargetUrl(
          restoreUrl ?? input.targetUrl ?? config.browserSessionsDefaultUrl,
          config.browserEvidenceTargetOrigin
        );
        if (prior && (prior.status === "CLOSED" || prior.status === "ERROR")) {
          restore = {
            scrollX: prior.restoreScrollX,
            scrollY: prior.restoreScrollY,
            videoPaused: prior.restoreVideoPaused
          };
        }
        session = await createStoredSession({ ...input, targetUrl });
      } else if (input.viewport && input.viewport !== session.viewport) {
        session = await store.updatePaneBrowserSession(session.sessionId, { viewport: input.viewport });
      }
      if (input.streamMode && input.streamMode !== session.streamMode) {
        session = await store.updatePaneBrowserSession(session.sessionId, {
          streamMode: input.streamMode,
          resolvedStreamMode: resolveBrowserStreamProfile(input.streamMode).resolvedMode
        });
      }
      if (browserSessionNeedsNavigation(session)) {
        session = await navigateSession(session, session.targetUrl);
        if (restore.scrollY != null || restore.scrollX != null || restore.videoPaused !== undefined) {
          try {
            const runtime = await ensureRuntime(session);
            await applyRestoreState(runtime.client, runtime.cdpSessionId, restore);
          } catch {
            // Restoring the exact visual position is best effort after navigation.
          }
        }
      } else {
        await ensureRuntime(session);
        session = await store.updatePaneBrowserSession(session.sessionId, {
          status: "READY",
          statusReason: "Browser session reconnected.",
          runtimeState: "READY",
          workerHeartbeatAt: nowIso()
        });
      }
      return responseFor(session, true);
    },
    async getActive(pane) {
      const session = await store.getActivePaneBrowserSession(pane.id);
      if (!session) return null;
      if (session.status === "CLOSED") return responseFor(session, false);
      if (browserSessionNeedsNavigation(session)) {
        return responseFor(await navigateSession(session, session.targetUrl), true);
      }
      await ensureRuntime(session);
      return responseFor(session, true);
    },
    async navigate(pane, url, _traceId, context) {
      assertEnabled();
      const session = await store.getActivePaneBrowserSession(pane.id);
      if (!session) throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
      await assertCanMutate(session, context);
      const updated = await navigateSession(session, url);
      return responseFor(updated, true);
    },
    setViewport: setPaneViewport,
    async setStreamMode(pane, mode, _traceId, context) {
      const session = await requireActiveSession(pane);
      await assertCanMutate(session, context);
      const profile = resolveBrowserStreamProfile(mode);
      const updated = await store.updatePaneBrowserSession(session.sessionId, {
        streamMode: mode,
        resolvedStreamMode: profile.resolvedMode,
        capacityState: "AVAILABLE"
      });
      return responseFor(updated, profile.resolvedMode !== "SILENT");
    },
    async listPages(pane) {
      const session = await requireActiveSession(pane);
      return refreshPages(session, await ensureRuntime(session));
    },
    async createPage(pane, rawUrl, activate, _traceId, context) {
      const session = await requireActiveSession(pane);
      await assertCanMutate(session, context);
      const runtime = await ensureRuntime(session);
      const url = rawUrl ? await assertSafeBrowserTargetUrl(rawUrl, config.browserEvidenceTargetOrigin) : "about:blank";
      const created = await runtime.client.send<{ targetId: string }>("Target.createTarget", { url, background: !activate });
      if (activate) await activateRuntimePage(session, runtime, created.targetId);
      return refreshPages(session, runtime);
    },
    async activatePage(pane, pageId, _traceId, context) {
      const session = await requireActiveSession(pane);
      await assertCanMutate(session, context);
      const runtime = await ensureRuntime(session);
      await activateRuntimePage(session, runtime, pageId);
      return refreshPages(session, runtime);
    },
    async closePage(pane, pageId, _traceId, context) {
      const session = await requireActiveSession(pane);
      await assertCanMutate(session, context);
      const runtime = await ensureRuntime(session);
      const pages = await refreshPages(session, runtime);
      if (!pages.pages.some((page) => page.pageId === pageId)) throw new SpaceNotFoundError(`Browser page ${pageId} was not found.`);
      if (pages.pages.length === 1) throw new SpaceConflictError("The last browser page cannot be closed.");
      const closingActive = runtime.targetId === pageId;
      await runtime.client.send("Target.closeTarget", { targetId: pageId });
      if (closingActive) {
        const replacement = pages.pages.find((page) => page.pageId !== pageId);
        if (replacement) await activateRuntimePage(session, runtime, replacement.pageId);
      }
      return refreshPages(session, runtime);
    },
    acquireControl: (pane, input, _traceId, context) => acquireControl(pane, input, context),
    heartbeatControl: (pane, input, _traceId, context) => updateControlLease(pane, input, false, context),
    releaseControl: (pane, input, _traceId, context) => updateControlLease(pane, input, true, context),
    async dispatchInput(pane, input, _traceId, context) {
      await dispatchRuntimeInput(pane, input, context);
    },
    async input(pane, input, _traceId, context) {
      return responseFor(await dispatchRuntimeInput(pane, input, context), false);
    },
    diagnostics: diagnosticsForPane,
    createCapture,
    async getCapture(pane, jobId) {
      const session = await requireActiveSession(pane);
      const job = await store.getBrowserCaptureJob(jobId);
      if (!job || job.sessionId !== session.sessionId) throw new SpaceNotFoundError(`Browser capture job ${jobId} was not found.`);
      return job;
    },
    stopCapture: (pane, jobId, _traceId, context) => controlCapture(pane, jobId, "STOP", context),
    cancelCapture: (pane, jobId, _traceId, context) => controlCapture(pane, jobId, "CANCEL", context),
    async action(pane, input, _traceId, context): Promise<BrowserToolActionResult> {
      assertEnabled();
      const session = input.sessionId ? await store.getPaneBrowserSession(input.sessionId) : await store.getActivePaneBrowserSession(pane.id);
      if (!session || session.paneId !== pane.id || !session.isActive) {
        throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
      }
      await assertCanMutate(session, context);
      if (input.type === "navigate") {
        const navigated = await navigateSession(session, input.url);
        return browserToolActionResultSchema.parse({ ...(await responseFor(navigated, true)), text: null });
      }
      if (input.type === "set_viewport") {
        const result = await setPaneViewport(pane, input.viewport, _traceId, context);
        return browserToolActionResultSchema.parse({ ...result, text: null });
      }
      const runtime = await ensureRuntime(session);
      if (input.type === "click") {
        await runtime.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: input.x, y: input.y, button: "left", clickCount: 1 }, runtime.cdpSessionId);
        await runtime.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: input.x, y: input.y, button: "left", clickCount: 1 }, runtime.cdpSessionId);
      }
      if (input.type === "type") {
        await runtime.client.send("Input.insertText", { text: input.text }, runtime.cdpSessionId);
      }
      if (input.type === "scroll") {
        await runtime.client.send(
          "Runtime.evaluate",
          { expression: `window.scrollBy(${JSON.stringify(input.deltaX)}, ${JSON.stringify(input.deltaY)})`, returnByValue: true },
          runtime.cdpSessionId
        );
      }
      let text: string | null = null;
      if (input.type === "extract_text") {
        const result = await runtime.client.send<{ result?: { value?: string } }>(
          "Runtime.evaluate",
          { expression: "document.body ? document.body.innerText : ''", returnByValue: true },
          runtime.cdpSessionId
        );
        text = sanitizePageText(readRuntimeValue(result) ?? "");
      }
      if (input.type === "diagnostics") {
        text = browserDiagnosticsText(runtime, input);
      }
      if (input.type === "record") {
        text = await executeActionRecording(session, runtime, input, context);
      }
      const frame = await captureFrame(session.sessionId);
      const fresh = await store.getPaneBrowserSession(session.sessionId);
      return browserToolActionResultSchema.parse({ session: fresh ?? session, frame, text });
    },
    captureFrame,
    startFrameStream,
    capacity: () => capacity.snapshot(),
    captureMetrics,
    stopPane: stopPaneById,
    async stopRoom(roomId, traceId, context) {
      const sessions = await store.listActivePaneBrowserSessions(roomId);
      await Promise.all(sessions.map((session) => stopPaneById(session.paneId, traceId, context)));
    },
    async closeAll() {
      const sessions = [...runtimes.keys()];
      await Promise.all(
        sessions.map(async (sessionId) => {
          const runtime = runtimes.get(sessionId);
          runtimes.delete(sessionId);
          capacity.releaseSession(sessionId);
          capacity.releaseLive(`stream:${sessionId}`);
          try {
            runtime?.detachDiagnostics();
            runtime?.client.close();
          } catch {
            // Closing the API should not hang on CDP socket state.
          }
          if (runtime) await stopChromeBestEffort(runtime.process);
          if (runtime?.xvfb) stopXvfbBestEffort(runtime.xvfb);
          if (runtime?.display !== undefined) releaseDisplay(runtime.display);
        })
      );
    },
    async recoverCaptureJobs() {
      const recovery = await recoverInterruptedBrowserCaptureJobs(store, config.browserEvidenceArtifactRoot);
      for (const jobId of recovery.requeuedJobs) {
        if (!captureQueue.includes(jobId)) captureQueue.push(jobId);
      }
      queueMicrotask(() => void pumpCaptureQueue());
      return recovery;
    },
    issueFrameTicket,
    issueAudioTicket: issueFrameTicket,
    acceptFrameTicket(paneId, sessionId, token) {
      const ticket = tickets.get(token);
      if (!ticket || ticket.paneId !== paneId || ticket.sessionId !== sessionId || ticket.expiresAt < Date.now()) {
        tickets.delete(token);
        return false;
      }
      tickets.delete(token);
      return true;
    },
    acceptAudioTicket(paneId, sessionId, token) {
      const ticket = tickets.get(token);
      if (!ticket || ticket.paneId !== paneId || ticket.sessionId !== sessionId || ticket.expiresAt < Date.now()) {
        tickets.delete(token);
        return false;
      }
      tickets.delete(token);
      return true;
    },
    startAudioStream
  };
}
