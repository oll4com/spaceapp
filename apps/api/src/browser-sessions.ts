import { spawn } from "./safe-child-process.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { accessSync, constants, createReadStream, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { nanoid } from "nanoid";
import type { BrowserHostActorContext, BrowserHostCaptureMetrics } from "@space/browser-host";
import {
  browserFrameSchema,
  freelanceEgressPac,
  resolveFreelanceCopilotPaneMetadata,
  browserRecordingFrameSummarySchema,
  browserTimelineEventSummarySchema,
  browserToolActionResultSchema,
  paneBrowserSessionResponseSchema,
  type AcquireBrowserControlInput,
  type FreelanceEgressRoute,
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
  type BrowserViewportDimensions,
  browserViewportDimensionsSchema,
  type BrowserStreamMode,
  type BrowserToolActionInput,
  type BrowserToolActionResult,
  type BrowserTimelineEventSummary,
  type Pane,
  type PaneBrowserSession,
  type PaneBrowserSessionResponse
} from "@space/contracts";
import type { VaultHostFillResult, VaultHostTarget } from "@space/contracts";
import { VAULT_BROKER_HOST_SOCKET_PATH, createSocketVaultBroker, sealedFillBroker } from "./vault/broker-client.js";
import { readVaultTarget, runSealedFill, type SealedFillPage } from "./vault/sealed-fill.js";
import { SpaceConflictError, SpaceFeatureDisabledError, SpaceNotFoundError, makeSpaceId, nowIso, redactMemoryText, type SpaceStore } from "@space/runtime";
import { BrowserControlHeldError } from "./browser-errors.js";
import type { SpaceApiConfig } from "./config.js";
import { youTubeAdBlockScript } from "./youtube-ad-block.js";
import {
  classifyGoogleBrowserEvidence,
  googleBrowserCheckPageUrl,
  googleListAccountsExpression,
  isGoogleAuthenticationUrl,
  parseGoogleBrowserEvidence,
  googleSignInCookieState,
  readAdoptionProbe,
  readGoogleBrowserCheck,
  writeAdoptionProbe,
  writeGoogleBrowserCheck,
  type GoogleBrowserCheck,
  type GoogleBrowserEvidence
} from "./google-browser-session-check.js";
import { childProcessEnv } from "./child-process-env.js";

interface ViewportSize {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
}

const DEEPSEEK_HARNESS_BROWSER_ORIGIN = "http://10.254.240.21:3080";

/** Chrome's saved-login stores in a profile (and their SQLite side files). */
export const CHROME_SAVED_LOGIN_FILES = ["Login Data", "Login Data For Account"]
  .flatMap(store => ["", "-journal", "-wal", "-shm"].map(suffix => store + suffix));

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
    REALTIME: { framesPerSecond: 35, quality: 72 }
  }[resolvedMode];
  return { requestedMode: mode, resolvedMode, ...profile, format: "jpeg" };
}

// Keep the sampling phase instead of resetting it to each compositor frame.
// Resetting it quantizes 35 fps to 30 (and 24 fps to 20) on a 60 Hz source.
export function nextBrowserFrameDeadline(now: number, deadline: number, fps: number): number | null {
  if (fps <= 0 || (deadline > 0 && now + 0.5 < deadline)) return null;
  const interval = 1000 / fps;
  return deadline > 0 && now - deadline < interval ? deadline + interval : now + interval;
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

  acquireLive(key: string, limit = this.maxLiveWorkloads): boolean {
    if (this.liveWorkloads.has(key)) return true;
    if (this.liveWorkloads.size >= limit) return false;
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

interface BrowserProfileRuntime {
  /** The proxy routes this Chrome started with (Freelance Copilot per-platform egress); null: no proxy. */
  egressKey?: string | null;
  process: ChildProcessWithoutNullStreams;
  xvfb?: ChildProcessWithoutNullStreams;
  display?: number;
  client: CdpClient;
  owners: Map<string, BrowserRuntime>;
  attachments: Map<string, string>;
  members: Set<BrowserRuntime>;
  detach: () => void;
}

interface BrowserRuntime {
  profile: BrowserProfileRuntime;
  profilePath: string;
  ownedPages: Set<string>;
  closing: boolean;
  viewportDimensions?: BrowserViewportDimensions;
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
  /** Chrome profiles of the pane's tabs in other Google accounts, by profile path. */
  accountTabs: Map<string, BrowserAccountTab>;
  /** Tab -> profile path of a tab in another account's Chrome; the pane's own tabs are absent. */
  pageProfiles: Map<string, string>;
  /** Serializes joining, switching and leaving account Chromes. */
  accountWork: Promise<unknown>;
  /** Set by a Vault sealed fill: this page keeps no console or network entries from then on (ADR-012). */
  vaultProtected?: boolean;
}

/** Another Google account's Chrome (shared with the panes that use that account) holding some of a pane's tabs. */
interface BrowserAccountTab {
  profile: BrowserProfileRuntime;
  account: { profileId: string; label: string | null };
  detach: () => void;
}

/** Server-derived identity of an account tab's Chrome profile, kept so a restart reopens the tab in its account. */
export type BrowserAccountTabIdentity = Pick<StartBrowserSessionInput, "googleAccount" | "sharedProfileKey" | "profileKey">;

export interface BrowserSessionStatus {
  enabled: boolean;
  statusReason: string;
  defaultUrl: string;
  checkedAt: string;
  capacity?: ReturnType<BrowserCapacityGate["snapshot"]>;
}

export interface StartBrowserSessionInput {
  pane: Pane;
  /** Server-derived, verified registry identity; never accepted as a public request field. */
  googleAccount?: { ownerUserId: string; accountId: string };
  /** Legacy YouTube account scope; never a client-supplied path. */
  profileKey?: string | null;
  /**
   * Server-derived key of a CLI (Gemini) account for this user: one Chrome profile
   * shared by every Browser and YouTube pane that selects that account.
   */
  sharedProfileKey?: string;
  viewport?: BrowserSessionViewport;
  targetUrl?: string | null;
  streamMode?: BrowserStreamMode;
  ownerAgentId?: string | null;
  includeInitialFrame?: boolean;
  /**
   * Moves a tab of the running pane into the Google account named by the identity fields above (profileId null:
   * back to the pane's account) instead of starting the pane. It travels in the start input, so the Browser Host IPC
   * is unchanged; a host that predates it ignores it, so callers check that page summaries carry `account` first.
   */
  accountTab?: { pageId: string; profileId: string | null; label: string | null; url?: string | null };
  traceId: string;
}

export interface GoogleAccountBrowserIdentity {
  ownerUserId: string;
  accountId: string;
}

/** A pane's own (non-shared) profile: the per-pane directory or a legacy account scope inside it. */
export interface PaneProfileSource {
  ownerUserId: string;
  roomId: string;
  paneId: string;
  profileKey: string | null;
  /** Only this linked account may receive the profile (an explicit pane choice). */
  accountId?: string;
}

export type PaneProfileAdoptionResult = {
  result: "ADOPTED" | "ALREADY_CONNECTED" | "TARGET_IN_USE" | "SOURCE_IN_USE" | "SOURCE_MISSING" | "NO_SIGN_IN" | "OTHER_ACCOUNT" | "CHECK_FAILED";
  /** Registry account whose Google session the pane profile holds, when verified. */
  accountId: string | null;
};

/** Redacted result of checking a verified account's persistent profile with Google. */
export type GoogleAccountBrowserCheckResult = Pick<GoogleBrowserCheck, "status" | "reason" | "connectedAt"> & { checkedAt: string | null };

export interface BrowserSessionManager {
  status(): BrowserSessionStatus;
  startOrRestore(input: StartBrowserSessionInput, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  getActive(pane: Pane): Promise<PaneBrowserSessionResponse | null>;
  navigate(pane: Pane, url: string, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  setViewport(pane: Pane, viewport: BrowserSessionViewport, traceId: string, context?: BrowserHostActorContext, dimensions?: BrowserViewportDimensions): Promise<PaneBrowserSessionResponse>;
  action(pane: Pane, input: BrowserToolActionInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserToolActionResult>;
  captureFrame(sessionId: string): Promise<BrowserFrame>;
  stopPane(paneId: string, traceId?: string, context?: BrowserHostActorContext): Promise<void>;
  stopDetached?(session: PaneBrowserSession): Promise<void>;
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
  /** Vault sealed fill (ADR-012); only the Browser Host process implements them. */
  vaultTarget?(pane: Pane): Promise<VaultHostTarget>;
  vaultFill?(pane: Pane, request: unknown, traceId: string): Promise<VaultHostFillResult>;
  /** Verifies the account's profile with Google; launches it only when `launch` is true and no pane is using it. */
  checkGoogleAccount?(identity: GoogleAccountBrowserIdentity, launch: boolean, context?: BrowserHostActorContext): Promise<GoogleAccountBrowserCheckResult>;
  /**
   * Moves a closed pane profile into the shared profile of the registry account it
   * is verifiably signed in to (Google ListAccounts), so one sign-in serves every pane.
   */
  adoptPaneGoogleProfile?(source: PaneProfileSource, context?: BrowserHostActorContext): Promise<PaneProfileAdoptionResult>;
}

const viewportSizes: Record<BrowserSessionViewport, ViewportSize> = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
  tablet: { width: 834, height: 1112, deviceScaleFactor: 2, mobile: true },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  wide: { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }
};

const displayBase = 100;
const displayCapacity = 10;
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

async function waitForDisplaySocket(display: number, timeoutMs: number, child: ChildProcessWithoutNullStreams, stderr: () => string): Promise<void> {
  const socketPath = `/tmp/.X11-unix/X${display}`;
  const lockPath = `/tmp/.X${display}-lock`;
  const deadline = Date.now() + timeoutMs;
  let spawnError: Error | null = null;
  const onError = (error: Error) => { spawnError = error; };
  child.once("error", onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Xvfb exited before display ${display} was ready. ${stderr()}`);
      try {
        accessSync(socketPath);
        // The display is ready only when its lock names this Xvfb. Another X server on the
        // same display, or one killed without cleaning up, leaves a socket too; this Xvfb
        // then exits ("already active") and must not be reported as ready.
        if (Number(readFileSync(lockPath, "utf8").trim()) === child.pid) return;
      } catch {
        // Not created yet.
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for Xvfb display ${display}. ${stderr()}`);
  } finally { child.off("error", onError); }
}

async function startXvfb(display: number, width: number, height: number, xvfbPath: string): Promise<ChildProcessWithoutNullStreams> {
  // Prepare the shared socket directory before concurrent X servers launch.
  // Xorg's unprivileged directory creation races on a fresh PrivateTmp.
  await mkdir("/tmp/.X11-unix", { recursive: true, mode: 0o1777 });
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
  let stderr = "";
  xvfb.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-500); });
  try {
    await waitForDisplaySocket(display, 8_000, xvfb, () => stderr);
    return xvfb;
  } catch (error) {
    await stopXvfbBestEffort(xvfb);
    throw error;
  }
}

async function stopXvfbBestEffort(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => process.once("exit", () => resolve()));
  process.kill("SIGTERM");
  await withTimeout(exited, 1000, "Xvfb stop timed out.").catch(() => {
    if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
  });
  if (process.exitCode === null && process.signalCode === null) await withTimeout(exited, 1000, "Xvfb exit timed out.").catch(() => undefined);
  if (process.exitCode === null && process.signalCode === null) throw new Error("Xvfb did not exit; its display remains reserved.");
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

interface BrowserFrameTreeNode { frame: { id: string }; childFrames?: BrowserFrameTreeNode[] }
// The masked screenshot's style (Vault fence, 2026-10-19): every form field, text area and editable area drawn as dots,
// including a password field a "show password" toggle turned into text. Applied for one shot, then removed.
const VAULT_MASK_CSS = "input,textarea,select,[contenteditable]:not([contenteditable=false]),[contenteditable]:not([contenteditable=false]) *"
  + "{-webkit-text-security:disc!important}";
export const VAULT_MASK_APPLY = `(() => { let s = document.getElementById("__space_vault_mask"); if (!s) { s = document.createElement("style");
  s.id = "__space_vault_mask"; (document.head || document.documentElement).appendChild(s); } s.textContent = ${JSON.stringify(VAULT_MASK_CSS)};
  return getComputedStyle(document.documentElement) !== null; })()`;
export const VAULT_MASK_REMOVE = `(() => { document.getElementById("__space_vault_mask")?.remove(); return true; })()`;

/**
 * A PNG (base64) of the page with every form field, text area and editable area drawn as dots (Vault fence, 2026-10-19):
 * the mask goes into an isolated world of every frame of this page for this one shot and is removed after it. Without the
 * mask on the page's own frame nothing is captured; a frame of another process (out of this session) holds nothing a fill
 * of this page typed.
 */
export async function captureMaskedScreenshot(send: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>): Promise<string> {
  const tree = await send<{ frameTree: BrowserFrameTreeNode }>("Page.getFrameTree");
  const frameIds: string[] = [];
  const walk = (node: BrowserFrameTreeNode) => { frameIds.push(node.frame.id); for (const child of node.childFrames ?? []) walk(child); };
  walk(tree.frameTree);
  const contexts: number[] = [];
  try {
    for (const [index, frameId] of frameIds.entries()) {
      try {
        const world = await send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId, worldName: "space-vault-mask" });
        const applied = await send<{ result?: { value?: unknown } }>("Runtime.evaluate", { contextId: world.executionContextId, returnByValue: true, expression: VAULT_MASK_APPLY });
        if (applied.result?.value !== true) throw new Error("mask not applied");
        contexts.push(world.executionContextId);
      } catch (error) {
        if (index === 0) throw new SpaceConflictError(`The masked screenshot could not mask the page: ${error instanceof Error ? error.message : "unknown"}.`);
      }
    }
    return (await send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })).data;
  } finally {
    for (const contextId of contexts) await send("Runtime.evaluate", { contextId, expression: VAULT_MASK_REMOVE }).catch(() => undefined);
  }
}

/** Enter (with its submit char), Tab or Shift+Tab as real key events in the page. */
export async function pressBrowserKey(client: { send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> }, sessionId: string,
  key: "Enter" | "Tab" | "Shift+Tab"): Promise<void> {
  const name = key === "Enter" ? "Enter" : "Tab";
  const base = { key: name, code: name, windowsVirtualKeyCode: name === "Enter" ? 13 : 9, modifiers: key === "Shift+Tab" ? 8 : 0 };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base }, sessionId);
  if (name === "Enter") await client.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base }, sessionId);
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
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
  // Tabs in another Google account reopen in that account's Chrome, never in the pane's.
  const persisted = session.pages
    .filter((page): page is typeof page & { url: string } => Boolean(!page.account && page.url && /^https?:\/\//i.test(page.url)))
    .slice(0, 100);
  const active = persisted.find((page) => page.pageId === session.activePageId || page.isActive);
  const accountTabActive = session.pages.some((page) => page.account && (page.pageId === session.activePageId || page.isActive));
  // A navigation owns the active page: it is about to load it, or Chrome died
  // before the navigation committed (never reload a target that may crash it).
  // The background tabs are unrelated to the navigation and are still restored.
  if (session.status === "NAVIGATING") {
    return {
      activeUrl: null,
      backgroundUrls: Array.from(new Set(persisted.filter((page) => page !== active && page.url !== active?.url).map((page) => page.url)))
    };
  }
  const activeUrl = active?.url ?? (accountTabActive ? persisted[0]?.url ?? null
    : session.currentUrl && /^https?:\/\//i.test(session.currentUrl) ? session.currentUrl : null);
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
  private readonly allowedLocalOrigins: Set<string>;

  constructor(
    allowedLocalOrigins: string | string[],
    private readonly options: {
      resolver?: BrowserAddressResolver;
      timeoutMs?: number;
      cacheTtlMs?: number;
      maxCacheEntries?: number;
    } = {}
  ) {
    this.allowedLocalOrigins = new Set(
      (Array.isArray(allowedLocalOrigins) ? allowedLocalOrigins : [allowedLocalOrigins])
        .map((origin) => new URL(origin).origin)
    );
  }

  async assertAllowed(raw: string): Promise<string> {
    // A new tab is a safe local document and must remain navigable/restorable.
    if (raw === "about:blank") return raw;
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new SpaceFeatureDisabledError("BROWSER_TARGET_BLOCKED", "Browser navigation target must use http or https.", {
        protocol: url.protocol
      });
    }
    if (!this.allowedLocalOrigins.has(url.origin)) {
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
  return new BrowserRequestGuard([allowedLocalOrigin, DEEPSEEK_HARNESS_BROWSER_ORIGIN]).assertAllowed(raw);
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
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error("Chrome DevTools Protocol socket is not open.");
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
    });
    try {
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.reject(error instanceof Error ? error : new Error("Chrome DevTools Protocol send failed."));
    }
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
  // Keep layout-aware Latin shortcuts (e.g. Ctrl+A on AZERTY). Numpad
  // digits have their own virtual keys and are resolved below.
  if (!code?.startsWith("Numpad") && /^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  // CDP expects Windows virtual keys, not character codes ('.' is 46 in
  // ASCII, but VK_DELETE is 46). The physical code also handles Shift and
  // non-Latin layouts without changing the text supplied by the client.
  if (code) {
    const physical: Record<string, number> = {
      Space: 32,
      Semicolon: 186, Equal: 187, Comma: 188, Minus: 189,
      Period: 190, Slash: 191, Backquote: 192,
      BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222,
      IntlBackslash: 226,
      NumpadMultiply: 106, NumpadAdd: 107, NumpadComma: 108,
      NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111
    };
    if (Object.hasOwn(physical, code)) return physical[code]!;
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
    if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(6));
    const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
    if (functionKey) return 111 + Number(functionKey[1]);
  }
  // Older/synthetic clients may omit code. Only ASCII letters and digits
  // share their character code with a Windows virtual key.
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  const printable: Record<string, number> = {
    " ": 32, ";": 186, ":": 186, "=": 187, "+": 187,
    ",": 188, "<": 188, "-": 189, "_": 189, ".": 190, ">": 190,
    "/": 191, "?": 191, "`": 192, "~": 192,
    "[": 219, "{": 219, "\\": 220, "|": 220, "]": 221, "}": 221,
    "'": 222, '"': 222,
    "!": 49, "@": 50, "#": 51, "$": 52, "%": 53,
    "^": 54, "&": 55, "*": 56, "(": 57, ")": 48
  };
  if (Object.hasOwn(printable, key)) return printable[key]!;
  return 0;
}

/**
 * The clock and languages of a Freelance route's exit country, so pages show the time and language the exit implies
 * (English first: the operator's accounts are in English). Direct is this server's own zone.
 * shortcut: Mullvad and Nord rotate cities, so they keep the server's zone; map them when a route pins one country.
 */
const egressLocales: Partial<Record<FreelanceEgressRoute, { timeZone: string; acceptLang: string }>> = {
  thailand: { timeZone: "Asia/Bangkok", acceptLang: "en-US,en,th" },
  greece: { timeZone: "Europe/Athens", acceptLang: "en-US,en,el" }
};

export function googleBrowserProfilePathFor(profileRoot: string, ownerUserId: string, accountId: string): string {
  if (!ownerUserId || !/^google_account:[A-Za-z0-9_-]+$/.test(accountId)) throw new SpaceConflictError("Invalid Google account profile identity.");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return join(profileRoot, "google-accounts", hash(ownerUserId), hash(accountId));
}

/** One shared profile per user and CLI account (the key already binds both). */
export function sharedCliProfilePathFor(profileRoot: string, sharedProfileKey: string): string {
  if (!/^[a-f0-9]{64}$/.test(sharedProfileKey)) throw new SpaceConflictError("Invalid shared browser account profile.");
  return join(profileRoot, "cli-accounts", sharedProfileKey);
}

export function browserProfilePathFor(profileRoot: string, roomId: string, paneId: string, profileKey?: string | null): string {
  const root = join(profileRoot, sanitizeSegment(roomId), sanitizeSegment(paneId));
  if (profileKey == null) return root;
  if (!/^[a-f0-9]{64}$/.test(profileKey)) throw new Error("Invalid browser account profile scope.");
  return join(root, "accounts", profileKey);
}

/** The Chrome profile of an account identity: a Google account's, a shared CLI account's or one of the pane's own. */
export function browserProfilePathForIdentity(profileRoot: string, pane: Pick<Pane, "id" | "roomId">, identity: BrowserAccountTabIdentity): string {
  return identity.googleAccount
    ? googleBrowserProfilePathFor(profileRoot, identity.googleAccount.ownerUserId, identity.googleAccount.accountId)
    : identity.sharedProfileKey
      ? sharedCliProfilePathFor(profileRoot, identity.sharedProfileKey)
      : browserProfilePathFor(profileRoot, pane.roomId, pane.id, identity.profileKey);
}

// Server-only record of the account tabs' identities, outside every Chrome profile (a pane's own profile is its
// directory, and adopting a sign-in moves that directory into a shared account).
export const browserAccountTabsFile = (profileRoot: string, paneId: string) => join(profileRoot, "account-tabs", `${sanitizeSegment(paneId)}.json`);

/** The identity behind each of a pane's account tabs, keyed by the tab's account profile id. */
export async function readBrowserAccountTabIdentities(profileRoot: string, paneId: string): Promise<Record<string, BrowserAccountTabIdentity>> {
  const raw = await readFile(browserAccountTabsFile(profileRoot, paneId), "utf8").catch(() => null);
  const parsed = (() => { try { return raw ? JSON.parse(raw) as { accounts?: unknown } : null; } catch { return null; } })();
  const result: Record<string, BrowserAccountTabIdentity> = {};
  const key = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  for (const [profileId, value] of Object.entries(parsed?.accounts && typeof parsed.accounts === "object" ? parsed.accounts : {})) {
    const entry = value as Record<string, unknown> & { googleAccount?: Record<string, unknown> };
    if (entry.googleAccount && typeof entry.googleAccount.ownerUserId === "string" && typeof entry.googleAccount.accountId === "string") {
      result[profileId] = { googleAccount: { ownerUserId: entry.googleAccount.ownerUserId, accountId: entry.googleAccount.accountId } };
    } else if (key(entry.sharedProfileKey)) result[profileId] = { sharedProfileKey: entry.sharedProfileKey as string };
    else if (entry.profileKey === null || key(entry.profileKey)) result[profileId] = { profileKey: entry.profileKey as string | null };
  }
  return result;
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

async function stopChromeBestEffort(process: ChildProcessWithoutNullStreams, client?: Pick<CdpClient, "send" | "close">): Promise<void> {
  const isRunning = () => process.exitCode === null && process.signalCode === null;
  let onExit: () => void = () => undefined;
  const exited = new Promise<void>(resolve => { onExit = resolve; process.once("exit", onExit); });
  try {
    if (isRunning() && client) {
      // Chrome must flush profile storage and cookies before its process exits.
      await withTimeout(client.send("Browser.close", {}), 1000, "Chrome close command timed out.").catch(() => undefined);
      if (isRunning()) await withTimeout(exited, 3000, "Chrome graceful exit timed out.").catch(() => undefined);
    }
    if (isRunning()) {
      process.kill("SIGTERM");
      await withTimeout(exited, 1000, "Chrome stop timed out.").catch(() => undefined);
    }
    if (isRunning()) {
      process.kill("SIGKILL");
      await withTimeout(exited, 1000, "Chrome exit timed out.").catch(() => undefined);
    }
    if (isRunning()) throw new Error("Chrome did not exit; its display remains reserved.");
  } finally {
    process.off("exit", onExit);
    try { client?.close(); } catch { /* The process exit is authoritative. */ }
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
  const profiles = new Map<string, BrowserProfileRuntime>();
  const profileTails = new Map<string, Promise<unknown>>();
  function withProfileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const next = (profileTails.get(path) ?? Promise.resolve()).catch(() => undefined).then(operation);
    profileTails.set(path, next);
    void next.finally(() => { if (profileTails.get(path) === next) profileTails.delete(path); }).catch(() => undefined);
    return next;
  }
  function profilePathForInput(input: StartBrowserSessionInput): string {
    return browserProfilePathForIdentity(config.browserSessionsProfileRoot, input.pane, input);
  }
  /** Account identity of a start request; panes with the same identity share one Chrome. */
  function profileIdentityForInput(input: StartBrowserSessionInput): string | null {
    if (input.googleAccount) return `google-account:${input.googleAccount.accountId}`;
    if (input.sharedProfileKey) return `cli-account:${input.sharedProfileKey}`;
    return null;
  }

  // The shared profile of a CLI account. Before it exists, the account's earlier
  // per-pane profiles (<room>/<pane>/accounts/<key>) are its history: a pane still
  // using one is joined (same Chrome, so the sign-in is shared at once); otherwise
  // the most recently signed-in one becomes the shared profile, moved whole.
  async function prepareSharedCliProfile(sharedProfileKey: string): Promise<string> {
    const root = config.browserSessionsProfileRoot;
    const shared = sharedCliProfilePathFor(root, sharedProfileKey);
    await profileMoveRecovery;
    return withProfileLock(shared, async () => {
      if (await stat(shared).then(() => true, () => false)) return shared;
      const activePaths = new Set((await store.listActivePaneBrowserSessions()).map(session => session.profilePath));
      const inUse = async (path: string) => profileRunning(path) || activePaths.has(path) || await foreignChromeHolds(path);
      const candidates: Array<{ path: string; signedIn: boolean; modifiedMs: number; inUse: boolean }> = [];
      for (const room of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!room.isDirectory() || !room.name.startsWith("room_")) continue;
        for (const pane of await readdir(join(root, room.name), { withFileTypes: true }).catch(() => [])) {
          if (!pane.isDirectory()) continue;
          const path = join(root, room.name, pane.name, "accounts", sharedProfileKey);
          if (!await stat(path).then(entry => entry.isDirectory(), () => false)) continue;
          // A profile this service cannot open is useless to Chrome too: skip it. Any other
          // unreadable cookie store (e.g. held by a Chrome) counts as in use, never as signed out.
          const cookies = await googleSignInCookieState(path).catch((error: NodeJS.ErrnoException & { errcode?: number }) =>
            error.code === "EACCES" || error.code === "EPERM" || error.errcode === 14 ? "inaccessible" as const : null);
          if (cookies === "inaccessible") continue;
          const modifiedMs = cookies?.modifiedMs ?? (await stat(path)).mtimeMs;
          candidates.push({ path, signedIn: cookies?.hasSignInCookies ?? true, modifiedMs, inUse: cookies === null || await inUse(path) });
        }
      }
      if (!candidates.length) return shared;
      candidates.sort((a, b) => Number(b.signedIn) - Number(a.signedIn) || b.modifiedMs - a.modifiedMs);
      // A pane still using the account wins: join its Chrome so nothing it holds is left behind.
      const open = candidates.find(candidate => candidate.inUse);
      if (open) return open.path;
      const best = candidates[0]!;
      return withProfileLock(best.path, async () => {
        if (!await stat(best.path).then(() => true, () => false)) return shared;
        if (await inUse(best.path)) return best.path;
        await mkdir(dirname(shared), { recursive: true, mode: 0o700 });
        await trackMove(rename(best.path, shared));
        for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await rm(join(shared, name), { force: true });
        await writeFile(`${shared}.adoption.json`, JSON.stringify({ version: 1, adoptedAt: nowIso(), from: best.path.slice(root.length + 1), signedIn: best.signedIn }), { mode: 0o600 });
        return shared;
      });
    });
  }
  async function assertGoogleAccount(input: StartBrowserSessionInput, context?: BrowserHostActorContext) {
    if (!input.googleAccount) return;
    const { ownerUserId, accountId } = input.googleAccount;
    const room = await store.getRoom(input.pane.roomId);
    if (room.kind === "AGENT_PROOF" || (context?.holderType === "OPERATOR" && context.holderId !== ownerUserId) ||
        !(await store.listGoogleAccounts(ownerUserId)).some(account => account.id === accountId)) {
      throw new SpaceConflictError("The Google account does not belong to this owner or is unavailable in a proof room.");
    }
  }

  // Verified-account profiles whose owner is known to this host process. Checks
  // open a private background page that no pane owns, lists or can activate.
  const googleProfileIdentities = new Map<string, GoogleAccountBrowserIdentity>();
  const googleChecks = new Map<string, { promise: Promise<GoogleAccountBrowserCheckResult>; strength: number }>();
  const googleCheckTimers = new Map<string, { timer: NodeJS.Timeout; forced: boolean }>();
  const googleProbeTargets = new Set<string>();
  const googleMainFrameUrls = new Map<string, string>();
  // Popup page -> the page that opened it, so a popup that closes itself hands the pane back to its opener.
  const pageOpeners = new Map<string, string>();
  const googleCheckStaleMs = 10 * 60_000;
  const redactedCheck = ({ status, reason, checkedAt, connectedAt }: GoogleBrowserCheck): GoogleAccountBrowserCheckResult => ({ status, reason, checkedAt, connectedAt });

  async function probeGoogleListAccounts(profile: BrowserProfileRuntime, account: { googleSub: string; email: string }): Promise<GoogleBrowserEvidence> {
    const { client } = profile;
    const { targetId } = await client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true });
    googleProbeTargets.add(targetId);
    try {
      const sid = profile.attachments.get(targetId) ??
        (await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
      await client.send("Page.enable", {}, sid);
      await client.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => undefined);
      const loaded = client.waitFor("Page.loadEventFired", sid, 10_000).catch(() => null);
      const navigation = await client.send<{ errorText?: string }>("Page.navigate", { url: googleBrowserCheckPageUrl }, sid);
      if (navigation.errorText) return { ok: false, httpStatus: null, error: "NETWORK" };
      await loaded;
      const result = await client.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
        expression: googleListAccountsExpression({ sub: account.googleSub, email: account.email }),
        awaitPromise: true,
        returnByValue: true
      }, sid);
      return parseGoogleBrowserEvidence(readRuntimeValue(result));
    } finally {
      await client.send("Target.closeTarget", { targetId }).catch(() => undefined);
      profile.attachments.delete(targetId);
      googleProbeTargets.delete(targetId);
    }
  }

  function checkGoogleAccountProfile(identity: GoogleAccountBrowserIdentity, launch: boolean, onlyIfOlderThanMs?: number): Promise<GoogleAccountBrowserCheckResult> {
    const path = googleBrowserProfilePathFor(config.browserSessionsProfileRoot, identity.ownerUserId, identity.accountId);
    // Join an equal or stronger check; a weaker one (no launch, or freshness-only) cannot answer this request.
    const strength = launch ? 2 : onlyIfOlderThanMs === undefined ? 1 : 0;
    const running = googleChecks.get(path);
    if (running && running.strength >= strength) return running.promise;
    if (running) return running.promise.catch(() => undefined).then(() => checkGoogleAccountProfile(identity, launch, onlyIfOlderThanMs));
    const checking = withProfileLock(path, async (): Promise<GoogleAccountBrowserCheckResult> => {
      const account = (await store.listGoogleAccounts(identity.ownerUserId)).find(candidate => candidate.id === identity.accountId);
      if (!account) throw new SpaceNotFoundError("Google account not found.");
      googleProfileIdentities.set(path, { ...identity });
      const exists = await stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (!exists) return { status: "NOT_CONNECTED", reason: "PROFILE_MISSING", checkedAt: nowIso(), connectedAt: null };
      const previous = await readGoogleBrowserCheck(path);
      if (previous && onlyIfOlderThanMs !== undefined && Date.now() - Date.parse(previous.checkedAt) < onlyIfOlderThanMs) return redactedCheck(previous);
      let profile = profiles.get(path);
      if (profile && (profile.process.exitCode !== null || profile.process.signalCode !== null)) {
        await closeProfile(profile, path);
        profile = undefined;
      }
      let launched = false;
      if (!profile) {
        if (!launch || closingAll) return previous ? redactedCheck(previous) : { status: "UNKNOWN", reason: "NOT_CHECKED", checkedAt: null, connectedAt: null };
        try {
          assertEnabled();
          profile = await launchProfile({ profilePath: path, viewport: "desktop" });
          launched = true;
        } catch {
          return { status: "UNKNOWN", reason: "BROWSER_UNAVAILABLE", checkedAt: nowIso(), connectedAt: previous?.connectedAt ?? null };
        }
      }
      try {
        const evidence = await withTimeout(probeGoogleListAccounts(profile, account), 20_000, "Timed out checking the Google session.")
          .catch((): GoogleBrowserEvidence => ({ ok: false, httpStatus: null, error: "NETWORK" }));
        const check = classifyGoogleBrowserEvidence(evidence, previous, nowIso());
        // A failed check is reported once but never replaces the last verified state.
        if (check.status !== "UNKNOWN") await writeGoogleBrowserCheck(path, check);
        return redactedCheck(check);
      } finally {
        if (launched && !profile.members.size && profiles.get(path) === profile) await closeProfile(profile, path);
      }
    });
    googleChecks.set(path, { promise: checking, strength });
    void checking.finally(() => { if (googleChecks.get(path)?.promise === checking) googleChecks.delete(path); }).catch(() => undefined);
    return checking;
  }

  function scheduleGoogleAccountCheck(path: string, delayMs: number, onlyIfOlderThanMs?: number) {
    const identity = googleProfileIdentities.get(path);
    if (!identity || closingAll) return;
    const forced = onlyIfOlderThanMs === undefined;
    const pending = googleCheckTimers.get(path);
    if (pending?.forced && !forced) return;
    if (pending) clearTimeout(pending.timer);
    const timer = setTimeout(() => {
      if (googleCheckTimers.get(path)?.timer === timer) googleCheckTimers.delete(path);
      void checkGoogleAccountProfile(identity, false, onlyIfOlderThanMs).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    googleCheckTimers.set(path, { timer, forced });
  }

  const profileRunning = (path: string) => {
    const profile = profiles.get(path);
    return Boolean(profile && profile.process.exitCode === null && profile.process.signalCode === null);
  };
  // Chrome's SingletonLock ("<host>-<pid>") also reveals a Chrome this process does not manage.
  async function foreignChromeHolds(path: string): Promise<boolean> {
    const lock = await readlink(join(path, "SingletonLock")).catch(() => null);
    const pid = lock ? Number(/-(\d+)$/.exec(lock)?.[1]) : Number.NaN;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    // A recycled pid must not block forever: require that process to be Chrome on this directory.
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    return commandLine.split("\0").includes(`--user-data-dir=${path}`);
  }

  // Moves a pane's own profile into the account's shared profile after Google
  // confirms which registry account it holds. Source and target must be closed;
  // a target that never held a session is closed first (its panes reconnect).
  // Adoption must finish well inside the 30 s Browser Host IPC timeout: a caller that
  // gave up must never see its pane directory moved afterwards.
  const adoptionBudgetMs = 22_000;
  const profileMoves = new Set<Promise<unknown>>();
  function trackMove<T>(work: Promise<T>): Promise<T> {
    profileMoves.add(work);
    void work.finally(() => profileMoves.delete(work)).catch(() => undefined);
    return work;
  }

  async function adoptPaneProfile(source: PaneProfileSource): Promise<PaneProfileAdoptionResult> {
    const none = (result: PaneProfileAdoptionResult["result"], accountId: string | null = null): PaneProfileAdoptionResult => ({ result, accountId });
    const deadline = Date.now() + adoptionBudgetMs;
    const remaining = () => Math.max(1_000, deadline - Date.now());
    const accounts = (await store.listGoogleAccounts(source.ownerUserId))
      .filter(account => !source.accountId || account.id === source.accountId);
    if (!accounts.length) return none("NO_SIGN_IN");
    const sourcePath = browserProfilePathFor(config.browserSessionsProfileRoot, source.roomId, source.paneId, source.profileKey);
    await profileMoveRecovery;
    const probeWith = async (profile: BrowserProfileRuntime, account: (typeof accounts)[number], previous: GoogleBrowserCheck | null) => {
      const evidence = await withTimeout(probeGoogleListAccounts(profile, account), remaining(), "Timed out checking the Google session.")
        .catch((): GoogleBrowserEvidence => ({ ok: false, httpStatus: null, error: "NETWORK" }));
      return classifyGoogleBrowserEvidence(evidence, previous, nowIso());
    };
    return withProfileLock(sourcePath, async () => {
      const exists = await stat(sourcePath).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      if (!exists) return none("SOURCE_MISSING");
      // In use: a Chrome of this host, an active pane session (also after a host restart), or a foreign Chrome.
      const activePaths = (await store.listActivePaneBrowserSessions()).map(session => session.profilePath);
      const within = (path: string) => path === sourcePath || path.startsWith(`${sourcePath}/`);
      if ([...profiles.keys()].some(path => within(path) && profileRunning(path)) || activePaths.some(within) || await foreignChromeHolds(sourcePath)) {
        return none("SOURCE_IN_USE");
      }
      const cookies = await googleSignInCookieState(sourcePath).catch(() => null);
      if (!cookies) return none("SOURCE_IN_USE");
      if (!cookies.hasSignInCookies || cookies.modifiedMs === null) return none("NO_SIGN_IN");
      const remembered = await readAdoptionProbe(sourcePath).catch(() => null);
      if (remembered && remembered.cookiesModifiedMs === cookies.modifiedMs) return none(remembered.result);
      if (closingAll) return none("CHECK_FAILED");
      let probe: BrowserProfileRuntime;
      try {
        assertEnabled();
        probe = await launchProfile({ profilePath: sourcePath, viewport: "desktop" });
      } catch { return none("CHECK_FAILED"); }
      const checks: Array<{ account: (typeof accounts)[number]; check: GoogleBrowserCheck }> = [];
      try {
        for (const account of accounts) checks.push({ account, check: await probeWith(probe, account, null) });
      } finally {
        if (profiles.get(sourcePath) === probe && !probe.members.size) await closeProfile(probe, sourcePath);
      }
      // Registry order puts the primary account first; it wins a multi-login profile.
      const verified = checks.find(entry => entry.check.status === "CONNECTED");
      if (!verified) {
        if (checks.some(entry => entry.check.status === "UNKNOWN")) return none("CHECK_FAILED");
        const result = checks.some(entry => entry.check.reason === "OTHER_ACCOUNT") ? "OTHER_ACCOUNT" : "NO_SIGN_IN";
        // Remember against the cookies as the check left them (the check itself may touch them).
        const after = await googleSignInCookieState(sourcePath).catch(() => null);
        if (after?.modifiedMs != null) {
          await writeAdoptionProbe(sourcePath, { version: 1, cookiesModifiedMs: after.modifiedMs, result, checkedAt: nowIso() }).catch(() => undefined);
        }
        return none(result);
      }
      const accountId = verified.account.id;
      const targetPath = googleBrowserProfilePathFor(config.browserSessionsProfileRoot, source.ownerUserId, accountId);
      googleProfileIdentities.set(targetPath, { ownerUserId: source.ownerUserId, accountId });
      return withProfileLock(targetPath, async (): Promise<PaneProfileAdoptionResult> => {
        const previous = await readGoogleBrowserCheck(targetPath);
        const targetExists = await stat(targetPath).then(() => true, () => false);
        if (targetExists) {
          // Replace the shared profile only when Google confirms, now, that it never held a session.
          if (previous?.connectedAt) return none(previous.status === "CONNECTED" ? "ALREADY_CONNECTED" : "TARGET_IN_USE", accountId);
          if (activePaths.includes(targetPath) && !profileRunning(targetPath)) return none("TARGET_IN_USE", accountId);
          if (await foreignChromeHolds(targetPath)) return none("TARGET_IN_USE", accountId);
          let target = profileRunning(targetPath) ? profiles.get(targetPath)! : undefined;
          const launched = !target;
          if (!target) {
            try { target = await launchProfile({ profilePath: targetPath, viewport: "desktop" }); }
            catch { return none("TARGET_IN_USE", accountId); }
          }
          let current: GoogleBrowserCheck;
          try { current = await probeWith(target, verified.account, previous); }
          finally { if (launched && profiles.get(targetPath) === target && !target.members.size) await closeProfile(target, targetPath); }
          if (current.status === "CONNECTED") {
            await writeGoogleBrowserCheck(targetPath, current);
            return none("ALREADY_CONNECTED", accountId);
          }
          if (current.reason !== "NO_GOOGLE_SESSION") return none("TARGET_IN_USE", accountId);
          if (Date.now() > deadline) return none("CHECK_FAILED", accountId);
          // The open shared profile never held a session: close it like a crash so its
          // panes relaunch on the adopted profile at the same path.
          const open = profiles.get(targetPath);
          if (open && profileRunning(targetPath)) await closeProfile(open, targetPath);
        }
        if (Date.now() > deadline) return none("CHECK_FAILED", accountId);
        const stamp = Date.now();
        const replaced = `${targetPath}.replaced-${stamp}`;
        const parkedAccounts = `${sourcePath}.accounts-${stamp}`;
        const nested = source.profileKey === null && await stat(join(sourcePath, "accounts")).then(() => true, () => false);
        await trackMove((async () => {
          await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
          if (targetExists) await rename(targetPath, replaced);
          try {
            // A per-pane directory also contains the pane's legacy account scopes; they stay put.
            if (nested) await rename(join(sourcePath, "accounts"), parkedAccounts);
            await rename(sourcePath, targetPath);
            if (nested) {
              await mkdir(sourcePath, { mode: 0o700 });
              await rename(parkedAccounts, join(sourcePath, "accounts"));
            }
          } catch (error) {
            if (nested) await rename(parkedAccounts, join(sourcePath, "accounts")).catch(() => undefined);
            if (targetExists) await rename(replaced, targetPath).catch(() => undefined);
            throw error;
          }
        })());
        for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await rm(join(targetPath, name), { force: true });
        await rm(`${sourcePath}.account-probe.json`, { force: true });
        await writeGoogleBrowserCheck(targetPath, { ...verified.check, connectedAt: verified.check.checkedAt });
        await writeFile(`${targetPath}.adoption.json`, JSON.stringify({
          version: 1, adoptedAt: nowIso(),
          from: sourcePath.slice(config.browserSessionsProfileRoot.length + 1),
          replaced: targetExists ? replaced.slice(config.browserSessionsProfileRoot.length + 1) : null
        }), { mode: 0o600 });
        return none("ADOPTED", accountId);
      });
    });
  }

  // A crash between the renames of a move leaves "<pane>.accounts-<time>" or
  // "<profile>.replaced-<time>" behind; put them back where nothing replaced them.
  async function recoverInterruptedProfileMoves(): Promise<void> {
    const root = config.browserSessionsProfileRoot;
    for (const room of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!room.isDirectory() || !room.name.startsWith("room_")) continue;
      for (const entry of await readdir(join(root, room.name), { withFileTypes: true }).catch(() => [])) {
        const parked = /^(.+)\.accounts-\d+$/.exec(entry.name);
        if (!entry.isDirectory() || !parked) continue;
        const paneDir = join(root, room.name, parked[1]!);
        if (await stat(join(paneDir, "accounts")).then(() => true, () => false)) continue;
        await mkdir(paneDir, { recursive: true, mode: 0o700 });
        await rename(join(root, room.name, entry.name), join(paneDir, "accounts")).catch(() => undefined);
      }
    }
    const accountsRoot = join(root, "google-accounts");
    for (const owner of await readdir(accountsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!owner.isDirectory()) continue;
      for (const entry of await readdir(join(accountsRoot, owner.name), { withFileTypes: true }).catch(() => [])) {
        const replaced = /^([a-f0-9]{64})\.replaced-\d+$/.exec(entry.name);
        if (!entry.isDirectory() || !replaced) continue;
        const target = join(accountsRoot, owner.name, replaced[1]!);
        if (await stat(target).then(() => true, () => false)) continue;
        await rename(join(accountsRoot, owner.name, entry.name), target).catch(() => undefined);
      }
    }
  }
  const profileMoveRecovery = recoverInterruptedProfileMoves().catch(() => undefined);

  function noteGoogleProfileNavigation(path: string, profile: BrowserProfileRuntime, sessionId: string, url: string) {
    if (!googleProfileIdentities.has(path)) return;
    const targetId = [...profile.attachments].find(([, attached]) => attached === sessionId)?.[0];
    if (!targetId || googleProbeTargets.has(targetId) || !profile.owners.has(targetId)) return;
    const previous = googleMainFrameUrls.get(sessionId);
    googleMainFrameUrls.set(sessionId, url);
    // Sign-in, account chooser, challenge and sign-out flows all pass through these URLs.
    if (isGoogleAuthenticationUrl(previous) || isGoogleAuthenticationUrl(url)) scheduleGoogleAccountCheck(path, 4_000);
  }

  const closingSessions = new Set<string>();
  let closingAll = false;
  const runtimeStarts = new Map<string, Promise<BrowserRuntime>>();
  const paneStarts = new Map<string, Promise<PaneBrowserSessionResponse>>();
  // Sessions this process is navigating right now (a count, for overlapping navigations).
  const navigationsInFlight = new Map<string, number>();
  const tickets = new Map<string, { paneId: string; sessionId: string; expiresAt: number }>();
  const capacity = new BrowserCapacityGate(10, 4);
  const captureQueue: string[] = [];
  const captureCommands = new Map<string, "STOP" | "CANCEL">();
  const requestGuard = new BrowserRequestGuard([
    config.browserEvidenceTargetOrigin,
    DEEPSEEK_HARNESS_BROWSER_ORIGIN
  ]);
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

  // Every command is written before this returns (in order), but none is awaited one by one: a popup that
  // waits for the debugger answers them only after Runtime.runIfWaitingForDebugger, which claimPage sends next.
  async function enablePageSecurity(client: CdpClient, cdpSessionId: string): Promise<void> {
    await Promise.all([
      client.send("Page.enable", {}, cdpSessionId),
      client.send("Runtime.enable", {}, cdpSessionId),
      client.send("Network.enable", {}, cdpSessionId),
      client.send("Fetch.enable", {
        patterns: [
          { urlPattern: "http://*/*", requestStage: "Request" },
          { urlPattern: "https://*/*", requestStage: "Request" }
        ]
      }, cdpSessionId),
      config.browserSessionsYouTubeAdBlockEnabled
        ? client.send("Page.addScriptToEvaluateOnNewDocument", { source: youTubeAdBlockScript() }, cdpSessionId).catch(() => undefined)
        : undefined
    ]);
  }

  async function handlePausedRequest(runtime: BrowserRuntime, client: CdpClient, event: CdpEvent): Promise<void> {
    const requestId = event.params?.requestId;
    const request = event.params?.request as { url?: unknown } | undefined;
    if (typeof requestId !== "string" || typeof request?.url !== "string" || !event.sessionId) return;
    try {
      await requestGuard.assertAllowed(request.url);
      await client.send("Fetch.continueRequest", { requestId }, event.sessionId);
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
      await client.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, event.sessionId).catch(() => undefined);
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

  async function createStoredSession(input: StartBrowserSessionInput, profilePath = profilePathForInput(input)): Promise<PaneBrowserSession> {
    const sessionId = makeSpaceId("browser_session");
    const profileId = profileIdentityForInput(input) ?? `profile:${sanitizeSegment(input.pane.roomId)}:${sanitizeSegment(input.pane.id)}${input.profileKey ? `:${input.profileKey}` : ""}`;
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

  async function setViewport(runtime: BrowserRuntime, viewport: BrowserSessionViewport, dimensions?: BrowserViewportDimensions) {
    const size = { ...viewportSizes[viewport], ...dimensions };
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
    runtime.viewportDimensions = { width: size.width, height: size.height };
  }

  function ensureRuntime(session: PaneBrowserSession): Promise<BrowserRuntime> {
    if (closingAll || closingSessions.has(session.sessionId)) return Promise.reject(new SpaceConflictError("The browser session is closing."));
    const existing = runtimes.get(session.sessionId);
    if (existing && existing.process.exitCode === null && existing.process.signalCode === null) return Promise.resolve(existing);
    const pending = runtimeStarts.get(session.sessionId);
    if (pending) return pending;
    // A crashed pane Chrome leaves its account tabs open elsewhere; they close here and reopen with the relaunch.
    const starting = (existing ? releaseAccountTabs(existing) : Promise.resolve()).then(() => withProfileLock(session.profilePath, () => launchRuntime(session))).then((runtime) => {
      void restoreAccountTabs(session, runtime).catch(() => undefined);
      return runtime;
    });
    runtimeStarts.set(session.sessionId, starting);
    void starting.finally(() => { if (runtimeStarts.get(session.sessionId) === starting) runtimeStarts.delete(session.sessionId); }).catch(() => undefined);
    return starting;
  }

  /**
   * The Chrome flags of a Freelance Copilot pane's per-platform egress (its PAC, WebRTC kept on the proxied routes, and
   * the clock and languages of the pane's own route), with a key that names them; null for every other pane and for
   * an all-direct pane. The PAC holds the pane's route, so a route change changes the key and relaunches Chrome.
   */
  async function egressFor(paneId: string): Promise<{ args: string[]; env: Record<string, string>; key: string } | null> {
    const pane = await Promise.resolve(store.getPane(paneId)).catch(() => null);
    if (pane?.mode !== "FREELANCE_COPILOT") return null;
    const settings = resolveFreelanceCopilotPaneMetadata(pane.freelanceCopilotMetadata).settings;
    const pac = freelanceEgressPac(settings);
    if (!pac) return null;
    const locale = egressLocales[settings.browserEgress];
    return {
      args: [`--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString("base64")}`, "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ...(locale ? [`--accept-lang=${locale.acceptLang}`] : [])],
      env: locale ? { TZ: locale.timeZone } : {},
      key: createHash("sha256").update(pac).digest("hex")
    };
  }

  // Chrome's own saved logins are removed before each launch of an agent-driven profile: a saved password is autofilled
  // and reaches an agent's page snapshot (Freelance Copilot, 2026-10-19). The managed policy deploy/chrome-policies stops
  // new saves and autofill; this removes logins saved earlier. Chrome is not running for the profile here.
  async function forgetChromeSavedLogins(profilePath: string) {
    await Promise.all(CHROME_SAVED_LOGIN_FILES.map(name => rm(join(profilePath, "Default", name), { force: true })));
  }

  async function launchProfile(session: Pick<PaneBrowserSession, "profilePath" | "viewport">, egress: { args: string[]; env: Record<string, string>; key: string } | null = null): Promise<BrowserProfileRuntime> {
    await mkdir(session.profilePath, { recursive: true, mode: 0o700 });
    await forgetChromeSavedLogins(session.profilePath);
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
        throw new SpaceFeatureDisabledError("BROWSER_SESSION_CAPACITY", "No Xvfb display is available for a headed browser session.", capacity.snapshot());
      }
      try {
        xvfb = await startXvfb(display, viewport.width, viewport.height, config.browserSessionsXvfbPath);
      } catch (error) {
        releaseDisplay(display);
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
        ...(egress?.args ?? []),
        "about:blank"
      ],
      { env: { ...childProcessEnv(), HOME: session.profilePath, ...audioEnv, ...egress?.env, ...(xvfb ? { DISPLAY: `:${display}` } : {}) } }
    );
    let client: CdpClient | undefined;
    try {
      const wsUrl = await waitForChromeWebSocket(chrome, 10_000);
      client = await CdpClient.connect(wsUrl, 10_000);
      const profile: BrowserProfileRuntime = {
        egressKey: egress?.key ?? null, process: chrome, client, ...(xvfb ? { xvfb } : {}), ...(display !== null ? { display } : {}),
        owners: new Map(), attachments: new Map(), members: new Set(), detach: () => undefined
      };
      profile.detach = client.onEvent(event => {
        if (event.method === "Target.attachedToTarget") {
          const sid = event.params?.sessionId;
          const info = event.params?.targetInfo as { targetId?: string; type?: string; openerId?: string } | undefined;
          if (typeof sid !== "string" || info?.type !== "page" || !info.targetId) return;
          profile.attachments.set(info.targetId, sid);
          if (info.openerId) pageOpeners.set(info.targetId, info.openerId);
          const owner = profile.owners.get(info.targetId) ?? (info.openerId ? profile.owners.get(info.openerId) : undefined);
          if (owner) {
            // A popup opened by the page the pane shows (Sign in with Google) takes the view, as in a desktop browser.
            const focus = Boolean(info.openerId) && owner.targetId === info.openerId;
            const targetId = info.targetId;
            void claimPage(owner, targetId, sid, profile).then(
              () => { if (focus) void focusPopup(owner, targetId).catch(() => undefined); },
              () => profile.client.send("Target.closeTarget", { targetId }).catch(() => undefined)
            );
          }
        } else if (event.method === "Page.frameNavigated" && event.sessionId) {
          const frame = event.params?.frame as { parentId?: string; url?: string } | undefined;
          if (frame && !frame.parentId && typeof frame.url === "string") noteGoogleProfileNavigation(session.profilePath, profile, event.sessionId, frame.url);
        } else if (event.method === "Target.detachedFromTarget") {
          const sid = event.params?.sessionId;
          if (typeof sid === "string") googleMainFrameUrls.delete(sid);
          for (const [id, attached] of profile.attachments) {
            if (attached !== sid) continue;
            profile.attachments.delete(id);
            const owner = profile.owners.get(id);
            owner?.ownedPages.delete(id);
            owner?.pageSessions.delete(id);
            owner?.pageProfiles.delete(id);
            profile.owners.delete(id);
            const opener = pageOpeners.get(id);
            pageOpeners.delete(id);
            // A page that closes itself (a sign-in popup) must not leave its pane on a dead target.
            if (owner && owner.targetId === id && !owner.closing) void reactivateOwnedPage(owner, opener).catch(() => undefined);
            if (owner && owner.profile !== profile && !owner.closing) void pruneAccountTabs(owner).catch(() => undefined);
          }
        }
      });
      await client.send("Target.setAutoAttach", {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: "page", exclude: false }]
      });
      profiles.set(session.profilePath, profile);
      return profile;
    } catch (error) {
      await stopChromeBestEffort(chrome, client);
      if (xvfb) await stopXvfbBestEffort(xvfb);
      if (display !== null) releaseDisplay(display);
      throw error;
    }
  }

  async function claimPage(runtime: BrowserRuntime, targetId: string, attachedId?: string, profile = runtime.profile): Promise<string> {
    if (runtime.closing) {
      await profile.client.send("Target.closeTarget", { targetId }).catch(() => undefined);
      throw new SpaceConflictError("The browser pane is closing.");
    }
    const owner = profile.owners.get(targetId);
    if (owner && owner !== runtime) throw new SpaceNotFoundError("Browser page was not found.");
    profile.owners.set(targetId, runtime);
    runtime.ownedPages.add(targetId);
    const accountPath = profile === runtime.profile ? undefined : [...runtime.accountTabs].find(([, tab]) => tab.profile === profile)?.[0];
    if (accountPath) runtime.pageProfiles.set(targetId, accountPath);
    const existing = runtime.pageSessions.get(targetId);
    if (existing) return existing;
    const sid = attachedId ?? profile.attachments.get(targetId) ??
      (await profile.client.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
    profile.attachments.set(targetId, sid);
    runtime.pageSessions.set(targetId, sid);
    // The guard (Fetch.enable) is written before the resume, so the page's first request still waits for it.
    // Awaiting the guard first deadlocked noopener popups (Gmail links): their tab stayed blank and wedged the pane.
    await Promise.all([enablePageSecurity(profile.client, sid), profile.client.send("Runtime.runIfWaitingForDebugger", {}, sid)]);
    return sid;
  }

  /** The runtime's session while its pane is live, so background tab switches never touch a closing pane. */
  async function liveSessionOf(runtime: BrowserRuntime): Promise<PaneBrowserSession | undefined> {
    const sessionId = [...runtimes].find(([, candidate]) => candidate === runtime)?.[0];
    const session = sessionId ? await store.getPaneBrowserSession(sessionId) : undefined;
    return session?.isActive && !closingAll && !closingSessions.has(session.sessionId) && !runtime.closing ? session : undefined;
  }

  async function reactivateOwnedPage(runtime: BrowserRuntime, openerId: string | undefined): Promise<void> {
    const session = await liveSessionOf(runtime);
    if (!session) return;
    const next = openerId && runtime.ownedPages.has(openerId) ? openerId : [...runtime.ownedPages][0] ?? await createOwnedPage(runtime, "about:blank");
    await activateRuntimePage(session, runtime, next);
    await refreshPages(session, runtime);
  }

  async function focusPopup(runtime: BrowserRuntime, pageId: string): Promise<void> {
    const session = await liveSessionOf(runtime);
    if (!session || !runtime.ownedPages.has(pageId)) return;
    await activateRuntimePage(session, runtime, pageId);
    await refreshPages(session, runtime);
  }

  async function createOwnedPage(runtime: BrowserRuntime, url: string, background = false, profile = runtime.profile): Promise<string> {
    // Claim and guard an inert page before any network navigation can run. While another pane shares this
    // Chrome, the page gets its own window: as a background tab of a shared window it would be hidden
    // (no rendering, no input, hCaptcha on every submit) whenever another pane's tab is in front.
    const newWindow = [...profile.members].some((member) => member !== runtime);
    const { targetId } = await profile.client.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background, ...(newWindow ? { newWindow: true } : {}) });
    const sid = await claimPage(runtime, targetId, undefined, profile);
    if (url !== "about:blank") await profile.client.send("Page.navigate", { url }, sid);
    return targetId;
  }

  /** The Chrome a pane's tab lives in: its account tab's, else the pane's own. */
  function pageProfile(runtime: BrowserRuntime, pageId: string): BrowserProfileRuntime {
    const path = runtime.pageProfiles.get(pageId);
    return (path && runtime.accountTabs.get(path)?.profile) || runtime.profile;
  }

  function withAccountWork<T>(runtime: BrowserRuntime, operation: () => Promise<T>): Promise<T> {
    const next = runtime.accountWork.catch(() => undefined).then(operation);
    runtime.accountWork = next;
    return next;
  }

  const chromeAlive = (profile: BrowserProfileRuntime) => profile.process.exitCode === null && profile.process.signalCode === null;

  /** Joins (or starts) another account's Chrome for a pane's tabs; its pages report to the pane like its own. */
  async function joinAccountTab(runtime: BrowserRuntime, session: PaneBrowserSession, path: string, account: BrowserAccountTab["account"]): Promise<BrowserProfileRuntime> {
    const joined = runtime.accountTabs.get(path);
    if (joined && chromeAlive(joined.profile)) {
      joined.account = account;
      return joined.profile;
    }
    if (joined) await leaveAccountTab(runtime, path);
    return withProfileLock(path, async () => {
      if (runtime.closing) throw new SpaceConflictError("The browser pane is closing.");
      let profile = profiles.get(path);
      if (profile && !chromeAlive(profile)) {
        await closeProfile(profile, path);
        profile = undefined;
      }
      profile ??= await launchProfile({ profilePath: path, viewport: session.viewport });
      profile.members.add(runtime);
      // The listener comes first: the request guard holds every request of a claimed page until it answers.
      runtime.accountTabs.set(path, { profile, account, detach: profile.client.onEvent(runtimeEventListener(runtime, profile.client, session.sessionId)) });
      scheduleGoogleAccountCheck(path, 6_000, googleCheckStaleMs);
      return profile;
    });
  }

  async function leaveAccountTab(runtime: BrowserRuntime, path: string): Promise<void> {
    const tab = runtime.accountTabs.get(path);
    if (!tab) return;
    runtime.accountTabs.delete(path);
    tab.detach();
    await withProfileLock(path, async () => {
      tab.profile.members.delete(runtime);
      if (!tab.profile.members.size && profiles.get(path) === tab.profile) await closeProfile(tab.profile, path);
    });
  }

  /** Leaves the account Chromes where the pane has no tab left. */
  function pruneAccountTabs(runtime: BrowserRuntime): Promise<void> {
    return withAccountWork(runtime, async () => {
      const used = new Set(runtime.pageProfiles.values());
      for (const path of [...runtime.accountTabs.keys()]) if (!used.has(path)) await leaveAccountTab(runtime, path);
    });
  }

  /** An account Chrome that died takes its tabs with it; the view returns to the pane's own tabs. */
  async function dropDeadAccountTabs(session: PaneBrowserSession, runtime: BrowserRuntime): Promise<void> {
    const dead = [...runtime.accountTabs].filter(([, tab]) => !chromeAlive(tab.profile)).map(([path]) => path);
    if (!dead.length) return;
    let activeLost = false;
    for (const [id, path] of [...runtime.pageProfiles]) {
      if (!dead.includes(path)) continue;
      activeLost ||= runtime.targetId === id;
      runtime.ownedPages.delete(id);
      runtime.pageSessions.delete(id);
      runtime.pageProfiles.delete(id);
    }
    for (const path of dead) await leaveAccountTab(runtime, path);
    if (!activeLost) return;
    // The live view restarts on the pane's tab (stopping it on the dead Chrome is skipped).
    runtime.client = runtime.profile.client;
    await activateRuntimePage(session, runtime, [...runtime.ownedPages][0] ?? await createOwnedPage(runtime, "about:blank"));
  }

  const readAccountTabIdentities = (paneId: string) => readBrowserAccountTabIdentities(config.browserSessionsProfileRoot, paneId);

  async function saveAccountTabIdentity(paneId: string, profileId: string, identity: BrowserAccountTabIdentity): Promise<void> {
    const file = browserAccountTabsFile(config.browserSessionsProfileRoot, paneId);
    const accounts = { ...await readAccountTabIdentities(paneId), [profileId]: identity };
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
  }

  /** The Chrome profile of an account tab's identity, with the same checks as a pane start in that account. */
  async function accountTabProfilePath(pane: Pane, identity: BrowserAccountTabIdentity, context?: BrowserHostActorContext): Promise<string> {
    const input: StartBrowserSessionInput = { pane, ...identity, traceId: "account-tab" };
    await assertGoogleAccount(input, context);
    if (input.sharedProfileKey && (await store.getRoom(pane.roomId)).kind === "AGENT_PROOF") {
      throw new SpaceConflictError("Shared account profiles are unavailable in proof rooms.");
    }
    const path = input.sharedProfileKey ? await prepareSharedCliProfile(input.sharedProfileKey) : profilePathForInput(input);
    if (input.googleAccount) googleProfileIdentities.set(path, { ...input.googleAccount });
    return path;
  }

  /** After a Chrome or host restart: the pane's tabs in other accounts reopen in those accounts, in the background. */
  async function restoreAccountTabs(session: PaneBrowserSession, runtime: BrowserRuntime): Promise<void> {
    const tabs = session.pages.filter((page) => page.account && page.url && /^https?:\/\//i.test(page.url)).slice(0, 20);
    if (!tabs.length) return;
    const pane = await store.getPane(session.paneId);
    if (pane.mode === "FREELANCE_COPILOT") return;
    const identities = await readAccountTabIdentities(pane.id);
    await withAccountWork(runtime, async () => {
      let active: string | null = null;
      for (const page of tabs) {
        const identity = identities[page.account!.profileId];
        if (!identity) continue;
        try {
          const path = await accountTabProfilePath(pane, identity);
          const chrome = path === runtime.profilePath ? runtime.profile : await joinAccountTab(runtime, session, path, page.account!);
          const pageId = await createOwnedPage(runtime, await requestGuard.assertAllowed(page.url!), true, chrome);
          if (page.pageId === session.activePageId || page.isActive) active = pageId;
        } catch {
          // A tab whose account is gone (or unavailable here) stays closed rather than opening in another account.
        }
      }
      if (active) await activateRuntimePage(session, runtime, active);
    });
    await refreshPages(session, runtime);
  }

  /** Moves a tab into another Google account's Chrome (or back to the pane's): same place in the pane, other cookies. */
  async function switchPageAccount(input: StartBrowserSessionInput, accountTab: NonNullable<StartBrowserSessionInput["accountTab"]>, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse> {
    const { pane } = input;
    // Freelance Copilot tabs leave through the platform's egress route, which another account's Chrome does not use.
    if (pane.mode === "FREELANCE_COPILOT") throw new SpaceConflictError("FREELANCE_EGRESS: Freelance Copilot tabs keep the pane's Google account.");
    await paneStarts.get(pane.id)?.catch(() => undefined);
    const session = await requireActiveSession(pane);
    await assertCanMutate(session, context);
    const identity: BrowserAccountTabIdentity = { googleAccount: input.googleAccount, sharedProfileKey: input.sharedProfileKey, profileKey: input.profileKey };
    const path = accountTab.profileId === null ? null : await accountTabProfilePath(pane, identity, context);
    const runtime = await ensureRuntime(session);
    await withAccountWork(runtime, async () => {
      const from = pageProfile(runtime, accountTab.pageId);
      const targets = await from.client.send<{ targetInfos?: Array<{ targetId: string; type?: string; url?: string }> }>("Target.getTargets");
      const page = (targets.targetInfos ?? []).find((target) => target.targetId === accountTab.pageId && target.type === "page");
      if (!page || !runtime.ownedPages.has(accountTab.pageId)) throw new SpaceNotFoundError(`Browser page ${accountTab.pageId} was not found.`);
      const home = path === null || path === runtime.profilePath;
      const chrome = home ? runtime.profile : await joinAccountTab(runtime, session, path, { profileId: accountTab.profileId!, label: accountTab.label });
      if (chrome === from) {
        // Already in that account: a sign-in request opens Google sign-in in the tab.
        if (accountTab.url) await from.client.send("Page.navigate", { url: await assertSafeBrowserTargetUrl(accountTab.url, config.browserEvidenceTargetOrigin) }, runtime.pageSessions.get(accountTab.pageId));
        return;
      }
      const rawUrl = accountTab.url ?? (page.url && /^https?:\/\//i.test(page.url) ? page.url : "about:blank");
      const url = rawUrl === "about:blank" ? rawUrl : await assertSafeBrowserTargetUrl(rawUrl, config.browserEvidenceTargetOrigin);
      const pageId = await createOwnedPage(runtime, url, runtime.targetId !== accountTab.pageId, chrome);
      // The new tab takes the view first, so the old one never closes while the pane shows it.
      if (runtime.targetId === accountTab.pageId) await activateRuntimePage(session, runtime, pageId);
      await from.client.send("Target.closeTarget", { targetId: accountTab.pageId }).catch(() => undefined);
      if (!home) await saveAccountTabIdentity(pane.id, accountTab.profileId!, identity);
    });
    await refreshPages(session, runtime);
    return responseFor(await store.getPaneBrowserSession(session.sessionId) ?? session, false);
  }

  async function closeProfile(profile: BrowserProfileRuntime, path: string): Promise<void> {
    profile.detach();
    await stopChromeBestEffort(profile.process, profile.client);
    if (profile.xvfb) await stopXvfbBestEffort(profile.xvfb);
    if (profile.display !== undefined) releaseDisplay(profile.display);
    if (profiles.get(path) === profile) profiles.delete(path);
  }

  /** Closes a pane's tabs in other accounts and leaves those Chromes; never inside the pane's own profile lock. */
  async function releaseAccountTabs(runtime: BrowserRuntime): Promise<void> {
    for (const [id, path] of [...runtime.pageProfiles]) {
      const chrome = runtime.accountTabs.get(path)?.profile;
      await chrome?.client.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
      runtime.ownedPages.delete(id);
      runtime.pageSessions.delete(id);
      runtime.pageProfiles.delete(id);
      chrome?.owners.delete(id);
      chrome?.attachments.delete(id);
    }
    for (const path of [...runtime.accountTabs.keys()]) await leaveAccountTab(runtime, path);
  }

  async function releaseRuntime(runtime: BrowserRuntime): Promise<void> {
    runtime.closing = true;
    // Another account's lock is never taken inside the pane's own: two panes may use each other's accounts.
    await releaseAccountTabs(runtime);
    await withProfileLock(runtime.profilePath, async () => {
      runtime.detachDiagnostics();
      const profile = runtime.profile;
      // Keep ownership while closing: late popups must still belong to this pane.
      while (runtime.ownedPages.size) {
        const ids = [...runtime.ownedPages];
        for (const id of ids) {
          await profile.client.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
          runtime.ownedPages.delete(id);
          runtime.pageSessions.delete(id);
          profile.owners.delete(id);
          profile.attachments.delete(id);
        }
      }
      profile.members.delete(runtime);
      if (!profile.members.size && profiles.get(runtime.profilePath) === profile) await closeProfile(profile, runtime.profilePath);
    });
  }

  /** Live view frames, console, network and the request guard of a pane's pages in one Chrome (its own or an account tab's). */
  function runtimeEventListener(runtime: BrowserRuntime, client: CdpClient, sessionId: string): (event: CdpEvent) => void {
    return (event) => {
      if (!event.sessionId || ![...runtime.pageSessions.values()].includes(event.sessionId)) return;
      if (event.method === "Fetch.requestPaused") {
        void handlePausedRequest(runtime, client, event);
        return;
      }
      if (event.sessionId !== runtime.cdpSessionId || client !== runtime.client) return;
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
          const nextDeadline = nextBrowserFrameDeadline(now, subscriber.lastSentAt, subscriber.profile.framesPerSecond);
          if (nextDeadline === null) continue;
          subscriber.lastSentAt = nextDeadline;
          void Promise.resolve(
            subscriber.onFrame({
              sessionId,
              sequence: runtime.streamSequence,
              data: Buffer.from(data, "base64"),
              mimeType: "image/jpeg",
              capturedAt,
              metadata: { ...sanitizeValue(event.params?.metadata ?? {}) as Record<string, unknown>, viewportDimensions: runtime.viewportDimensions }
            })
          ).catch(() => undefined);
        }
        return;
      }
      if (runtime.vaultProtected) return;
      if (event.method === "Runtime.consoleAPICalled" || event.method === "Runtime.exceptionThrown") {
        pushBounded(runtime.consoleEntries, normalizeConsoleEvent(event), 500);
        return;
      }
      if (event.method.startsWith("Network.")) {
        const normalized = normalizeNetworkEvent(event);
        if (normalized) pushBounded(runtime.networkEntries, normalized, 1_000);
      }
    };
  }

  async function launchRuntime(session: PaneBrowserSession): Promise<BrowserRuntime> {
    const stale = runtimes.get(session.sessionId);
    if (stale) {
      stale.detachDiagnostics();
      runtimes.delete(session.sessionId);
      capacity.releaseLive(`stream:${session.sessionId}`);
    }
    const fresh = await store.getPaneBrowserSession(session.sessionId);
    if (!fresh?.isActive || fresh.status === "CLOSED") throw new SpaceConflictError("The browser session is closed.");
    assertEnabled();
    if (!capacity.acquireSession(session.sessionId)) {
      throw new SpaceFeatureDisabledError("BROWSER_SESSION_CAPACITY", `Browser limit reached: ${capacity.maxSessions} browsers can be open at once. Close another browser pane first.`, capacity.snapshot());
    }
    let profile = profiles.get(session.profilePath);
    if (profile && (profile.process.exitCode !== null || profile.process.signalCode !== null)) {
      await closeProfile(profile, session.profilePath);
      profile = undefined;
    }
    // A Freelance Copilot pane only joins a Chrome started with its own routes: an idle one restarts with them, one
    // that another pane uses is refused (the pane would otherwise leave from the wrong country).
    let egress: Awaited<ReturnType<typeof egressFor>> = null;
    try {
      egress = await egressFor(session.paneId);
      if (egress && profile && (profile.egressKey ?? null) !== egress.key) {
        if (profile.members.size) throw new SpaceConflictError("FREELANCE_EGRESS: this browser account is open in another pane without the Freelance Copilot's routes; close it there or give the Freelance Copilot its own browser account.");
        await closeProfile(profile, session.profilePath);
        profile = undefined;
      }
    } catch (error) { capacity.releaseSession(session.sessionId); throw error; }
    try { profile ??= await launchProfile(session, egress); }
    catch (error) { capacity.releaseSession(session.sessionId); throw error; }
    const { client, process: chrome, xvfb, display } = profile;
    let runtime: BrowserRuntime | undefined;
    try {
      runtime = {
        profile, profilePath: session.profilePath, ownedPages: new Set(), closing: false,
        process: chrome,
        ...(xvfb ? { xvfb } : {}),
        ...(display !== null ? { display } : {}),
        client,
        targetId: "",
        cdpSessionId: "",
        pageSessions: new Map(),
        consoleEntries: [],
        networkEntries: [],
        streamSubscribers: new Map(),
        screencastActive: false,
        streamSequence: 0,
        detachDiagnostics: () => undefined,
        accountTabs: new Map(),
        pageProfiles: new Map(),
        accountWork: Promise.resolve()
      };
      profile.members.add(runtime);
      runtime.targetId = await createOwnedPage(runtime, "about:blank");
      runtime.cdpSessionId = runtime.pageSessions.get(runtime.targetId)!;
      runtime.detachDiagnostics = client.onEvent(runtimeEventListener(runtime, client, session.sessionId));
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
        await createOwnedPage(runtime, url, true);
      }
      runtimes.set(session.sessionId, runtime);
      scheduleGoogleAccountCheck(session.profilePath, 6_000, googleCheckStaleMs);
      return runtime;
    } catch (error) {
      capacity.releaseSession(session.sessionId);
      if (runtime) {
        runtime.detachDiagnostics();
        for (const id of runtime.ownedPages) {
          await client.send("Target.closeTarget", { targetId: id }).catch(() => undefined);
          profile.owners.delete(id); profile.attachments.delete(id);
        }
        profile.members.delete(runtime);
      }
      if (!profile.members.size) await closeProfile(profile, session.profilePath);
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
    // One stream per session, so open (also minimized or hidden) browsers stream up to the session limit;
    // recordings keep maxLiveWorkloads.
    if (!capacity.acquireLive(workloadKey, capacity.maxSessions)) {
      throw new SpaceFeatureDisabledError("BROWSER_LIVE_CAPACITY", `Live browser limit reached: ${capacity.maxSessions} browsers can stream at once. Close another browser pane or set it to Silent.`, capacity.snapshot());
    }
    const id = makeSpaceId("browser_stream");
    runtime.streamSubscribers.set(id, { id, profile, lastSentAt: 0, onFrame });
    try {
      if (!runtime.screencastActive) {
        await runtime.client.send(
          "Page.startScreencast",
          { format: "jpeg", quality: 72, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
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
        // A runtime that was replaced after a crash (or stopped) already gave up
        // this session's slot; it now belongs to the replacement's stream.
        if (runtimes.get(sessionId) !== runtime) return;
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
          ...childProcessEnv(),
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
    await dropDeadAccountTabs(session, runtime);
    type TargetInfo = { targetId: string; type?: string; title?: string; url?: string; openerId?: string };
    const chromes = [runtime.profile, ...[...runtime.accountTabs.values()].map((tab) => tab.profile)];
    const lists = await Promise.all(chromes.map((chrome, index) => {
      const request = chrome.client.send<{ targetInfos?: TargetInfo[] }>("Target.getTargets").then((result) => result.targetInfos ?? []);
      return index ? request.catch((): TargetInfo[] => []) : request;
    }));
    const pages = lists.flat()
      .filter((target) => target.type === "page" && runtime.ownedPages.has(target.targetId))
      .slice(0, 100)
      .map((target): BrowserPageSummary => ({
        pageId: target.targetId,
        kind: target.openerId ? "POPUP" : "PAGE",
        url: safePageUrl(target.url),
        title: target.title?.slice(0, 500) || null,
        isActive: target.targetId === runtime.targetId,
        openerPageId: target.openerId ?? null,
        canGoBack: false,
        canGoForward: false,
        account: runtime.accountTabs.get(runtime.pageProfiles.get(target.targetId) ?? "")?.account ?? null
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
    const chrome = pageProfile(runtime, pageId);
    const targets = await chrome.client.send<{ targetInfos?: Array<{ targetId: string; type?: string }> }>("Target.getTargets");
    if (!runtime.ownedPages.has(pageId) || !(targets.targetInfos ?? []).some((target) => target.targetId === pageId && target.type === "page")) {
      throw new SpaceNotFoundError(`Browser page ${pageId} was not found.`);
    }
    const wasStreaming = runtime.screencastActive;
    if (wasStreaming) await runtime.client.send("Page.stopScreencast", {}, runtime.cdpSessionId).catch(() => undefined);
    const existingSessionId = runtime.pageSessions.get(pageId);
    const attached = existingSessionId
      ? { sessionId: existingSessionId }
      : await chrome.client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: pageId, flatten: true });
    // Every active-page command (live view, input, navigation, screenshots) goes to the active tab's Chrome.
    runtime.client = chrome.client;
    runtime.targetId = pageId;
    runtime.cdpSessionId = attached.sessionId;
    runtime.pageSessions.set(pageId, attached.sessionId);
    await enablePageSecurity(runtime.client, attached.sessionId);
    await setViewport(runtime, session.viewport, runtime.viewportDimensions);
    await runtime.client.send("Target.activateTarget", { targetId: pageId });
    if (wasStreaming && runtime.streamSubscribers.size) {
      await runtime.client.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 72, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
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
    navigationsInFlight.set(session.sessionId, (navigationsInFlight.get(session.sessionId) ?? 0) + 1);
    try {
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
    } finally {
      const remaining = (navigationsInFlight.get(session.sessionId) ?? 1) - 1;
      if (remaining > 0) navigationsInFlight.set(session.sessionId, remaining);
      else navigationsInFlight.delete(session.sessionId);
    }
  }

  async function responseFor(session: PaneBrowserSession, includeFrame: boolean): Promise<PaneBrowserSessionResponse> {
    const fresh = await store.getPaneBrowserSession(session.sessionId);
    if (!fresh) throw new SpaceNotFoundError(`Browser session ${session.sessionId} was not found.`);
    const frame = includeFrame && fresh.status !== "CLOSED" ? await captureFrame(fresh.sessionId).catch(() => null) : null;
    return paneBrowserSessionResponseSchema.parse({
      session: (await store.getPaneBrowserSession(fresh.sessionId)) ?? fresh,
      viewportDimensions: runtimes.get(fresh.sessionId)?.viewportDimensions,
      frame,
      websocket: issueFrameTicket(fresh.paneId, fresh.sessionId, config.browserSessionsTokenTtlMs)
    });
  }

  async function captureFrame(sessionId: string): Promise<BrowserFrame> {
    const session = await store.getPaneBrowserSession(sessionId);
    if (!session || !session.isActive) throw new SpaceNotFoundError(`Active browser session ${sessionId} was not found.`);
    const runtime = await ensureRuntime(session);
    const screenshot = await runtime.client.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      runtime.cdpSessionId
    );
    const meta = await readPageMetadata(runtime.client, runtime.cdpSessionId);
    // A NAVIGATING session that no navigation of this process is loading was abandoned:
    // Chrome or the host died before it committed. The frame shows what is really open, so
    // the target follows it; otherwise the next start or getActive (which navigate to the
    // target when no page URL is known) would load the page that may have crashed Chrome.
    const abandonedNavigation = session.status === "NAVIGATING" && !navigationsInFlight.has(session.sessionId);
    const updated = await store.updatePaneBrowserSession(session.sessionId, {
      currentUrl: meta.currentUrl,
      ...(abandonedNavigation ? { targetUrl: meta.currentUrl } : {}),
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
    context?: BrowserHostActorContext,
    dimensions?: BrowserViewportDimensions
  ): Promise<PaneBrowserSessionResponse> {
    assertEnabled();
    const boundedDimensions = dimensions ? browserViewportDimensionsSchema.parse(dimensions) : undefined;
    const session = await store.getActivePaneBrowserSession(pane.id);
    if (!session) throw new SpaceNotFoundError(`Active browser session for pane ${pane.id} was not found.`);
    await assertCanMutate(session, context);
    const updated = await store.updatePaneBrowserSession(session.sessionId, { viewport });
    const runtime = await ensureRuntime(updated);
    await setViewport(runtime, viewport, boundedDimensions);
    return responseFor(updated, !boundedDimensions);
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

  /** The pane that filled a Vault page sees its labels and buttons, never a value (captureMaskedScreenshot). */
  async function maskedScreenshot(session: PaneBrowserSession, runtime: BrowserRuntime): Promise<{ artifactId: string; path: string; masked: true }> {
    const data = await captureMaskedScreenshot((method, params) => runtime.client.send(method, params, runtime.cdpSessionId));
    const segment = sanitizeSegment(`masked-${randomUUID()}`);
    const directory = join(config.browserEvidenceArtifactRoot, "browser-evidence", segment);
    const filename = "masked-screenshot.png";
    const path = join(directory, filename);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    await writeFile(path, Buffer.from(data, "base64"), { mode: 0o640 });
    const artifactId = await registerCaptureArtifact({ session, jobId: segment, filePath: path, filename, kind: "SCREENSHOT", mimeType: "image/png" });
    return { artifactId, path, masked: true };
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
      const resolved = await resolveElementScreenshotClip(runtime.client, runtime.cdpSessionId, job.options.selector);
      if (!resolved || resolved.width <= 0 || resolved.height <= 0) {
        throw new SpaceNotFoundError(`Browser element ${job.options.selector} was not found.`);
      }
      clip = resolved;
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

  async function stopPaneById(paneId: string, _traceId?: string, context?: BrowserHostActorContext, skipStartWait = false): Promise<void> {
    if (!skipStartWait) await paneStarts.get(paneId)?.catch(() => undefined);
    const active = await store.getActivePaneBrowserSession(paneId);
    if (!active) return;
    await assertCanMutate(active, context);
    closingSessions.add(active.sessionId);
    try {
      await runtimeStarts.get(active.sessionId)?.catch(() => undefined);
      const runtime = runtimes.get(active.sessionId);
      runtimes.delete(active.sessionId);
      capacity.releaseSession(active.sessionId);
      capacity.releaseLive(`stream:${active.sessionId}`);
      let lastKnownUrl: string | null = active.currentUrl;
      let restoreScrollX: number | null = null;
      let restoreScrollY: number | null = null;
      let restoreVideoPaused: boolean | null = null;
      try {
        if (runtime && runtime.process.exitCode === null && runtime.process.signalCode === null && !runtime.pageProfiles.has(runtime.targetId)) {
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
      } catch {
        // Best effort: process termination below is the authoritative cleanup.
      }
      if (runtime) await releaseRuntime(runtime);
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
    } finally { closingSessions.delete(active.sessionId); }
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

  // Vault sealed fill (ADR-012): the pane's own tab, also in a shared Chrome (the API fences the filled browser, protection.ts).
  function vaultPage(pane: Pane, runtime: BrowserRuntime): SealedFillPage {
    return { cdp: runtime.client, sessionId: runtime.cdpSessionId, targetId: runtime.targetId, paneId: pane.id };
  }
  // H2 Option A: the Browser Host talks to the broker over its own socket, never through the API.
  const vaultBroker = sealedFillBroker(createSocketVaultBroker(VAULT_BROKER_HOST_SOCKET_PATH));
  async function vaultTargetForPane(pane: Pane): Promise<VaultHostTarget> {
    return readVaultTarget(vaultPage(pane, await ensureRuntime(await requireActiveSession(pane))));
  }
  async function vaultFillForPane(pane: Pane, request: unknown): Promise<VaultHostFillResult> {
    const runtime = await ensureRuntime(await requireActiveSession(pane));
    runtime.vaultProtected = true;
    runtime.consoleEntries.length = 0;
    runtime.networkEntries.length = 0;
    return runSealedFill(vaultPage(pane, runtime), vaultBroker, request);
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
    startOrRestore(input, context) {
      if (input.accountTab) return switchPageAccount(input, input.accountTab, context);
      const pending = paneStarts.get(input.pane.id);
      if (pending) return pending.then(async (response) => {
        await assertGoogleAccount(input, context);
        await assertCanMutate(response.session, context);
        const identity = profileIdentityForInput(input);
        if (identity ? response.session.profileId !== identity : input.profileKey !== undefined && response.session.profilePath !== profilePathForInput(input)) {
          throw new SpaceConflictError("The Google account is changing. Retry after the current browser start finishes.");
        }
        return response;
      });
      const starting = (async () => {
        assertEnabled();
        await assertGoogleAccount(input, context);
        if (input.googleAccount) googleProfileIdentities.set(profilePathForInput(input), { ...input.googleAccount });
        let session = await store.getActivePaneBrowserSession(input.pane.id);
        if (session) await assertCanMutate(session, context);
        if (input.sharedProfileKey && (await store.getRoom(input.pane.roomId)).kind === "AGENT_PROOF") {
          throw new SpaceConflictError("Shared account profiles are unavailable in proof rooms.");
        }
        const identity = profileIdentityForInput(input);
        const expectedProfilePath = input.sharedProfileKey && !(session && session.profileId === identity)
          ? await prepareSharedCliProfile(input.sharedProfileKey)
          : profilePathForInput(input);
        // A running pane already on the resolved directory (e.g. the joined per-pane profile) keeps running.
        const changesAccount = identity
          ? Boolean(session && session.profileId !== identity && session.profilePath !== expectedProfilePath)
          : input.profileKey !== undefined && Boolean(session && session.profilePath !== expectedProfilePath);
        if (changesAccount && session) {
          // This start owns paneStarts; stop only the previous account runtime.
          await stopPaneById(input.pane.id, input.traceId, context, true);
          session = null;
        }
        let restore: { scrollX?: number | null; scrollY?: number | null; videoPaused?: boolean | null } = {};
        if (!session) {
          const prior = await store.getLatestPaneBrowserSession(input.pane.id);
          const restoreUrl =
            prior && (prior.status === "CLOSED" || prior.status === "ERROR") && input.pane.mode !== "YOUTUBE"
              ? (prior.currentUrl ?? prior.targetUrl)
              : null;
          const targetUrl = await assertSafeBrowserTargetUrl(
            input.targetUrl ?? restoreUrl ?? config.browserSessionsDefaultUrl,
            config.browserEvidenceTargetOrigin
          );
          if (prior?.profilePath === expectedProfilePath && (!input.targetUrl || targetUrl === (prior.currentUrl ?? prior.targetUrl)) && (prior.status === "CLOSED" || prior.status === "ERROR")) {
            restore = {
              scrollX: prior.restoreScrollX,
              scrollY: prior.restoreScrollY,
              videoPaused: prior.restoreVideoPaused
            };
          }
          session = await createStoredSession({ ...input, targetUrl }, expectedProfilePath);
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
        return responseFor(session, input.includeInitialFrame !== false);
      })();
      paneStarts.set(input.pane.id, starting);
      void starting.finally(() => { if (paneStarts.get(input.pane.id) === starting) paneStarts.delete(input.pane.id); }).catch(() => undefined);
      return starting;
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
      const pageId = await createOwnedPage(runtime, url, !activate);
      if (activate) await activateRuntimePage(session, runtime, pageId);
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
      // Move off the page before closing it, so its detach never finds it active.
      if (runtime.targetId === pageId) {
        const replacement = pages.pages.find((page) => page.pageId !== pageId);
        if (replacement) await activateRuntimePage(session, runtime, replacement.pageId);
      }
      await pageProfile(runtime, pageId).client.send("Target.closeTarget", { targetId: pageId });
      return refreshPages(session, runtime);
    },
    async acquireControl(pane, input, _traceId, context) {
      const lease = await acquireControl(pane, input, context);
      // The holder drives the pane's active tab; Chrome holds each input to a background tab for 5 s and streams
      // no frames from it, and an agent's own tab switch can leave the pane's tab behind another one.
      const runtime = runtimes.get(lease.sessionId);
      await runtime?.client.send("Target.activateTarget", { targetId: runtime.targetId }).catch(() => undefined);
      return lease;
    },
    heartbeatControl: (pane, input, _traceId, context) => updateControlLease(pane, input, false, context),
    releaseControl: (pane, input, _traceId, context) => updateControlLease(pane, input, true, context),
    async dispatchInput(pane, input, _traceId, context) {
      await dispatchRuntimeInput(pane, input, context);
    },
    async input(pane, input, _traceId, context) {
      return responseFor(await dispatchRuntimeInput(pane, input, context), false);
    },
    diagnostics: diagnosticsForPane,
    vaultTarget: vaultTargetForPane,
    vaultFill: (pane, request) => vaultFillForPane(pane, request),
    async adoptPaneGoogleProfile(source, context) {
      if (context && (context.holderType !== "OPERATOR" || context.holderId !== source.ownerUserId)) {
        throw new SpaceConflictError("Only the account owner can move a pane's Google sign-in.");
      }
      const room = await store.getRoom(source.roomId);
      if (room.kind === "AGENT_PROOF") return { result: "SOURCE_MISSING", accountId: null };
      return adoptPaneProfile(source);
    },
    async checkGoogleAccount(identity, launch, context) {
      if (context && (context.holderType !== "OPERATOR" || context.holderId !== identity.ownerUserId)) {
        throw new SpaceConflictError("The Google account does not belong to this operator.");
      }
      return checkGoogleAccountProfile(identity, launch);
    },
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
      if (input.type === "press") {
        await pressBrowserKey(runtime.client, runtime.cdpSessionId, input.key);
        text = `Pressed ${input.key}.`;
      }
      if (input.type === "masked_screenshot") {
        text = JSON.stringify(await maskedScreenshot(session, runtime));
      }
      if (input.type === "record") {
        text = await executeActionRecording(session, runtime, input, context);
      }
      // A masked screenshot returns no unmasked live frame next to it.
      const frame = input.type === "masked_screenshot" ? null : await captureFrame(session.sessionId);
      const fresh = await store.getPaneBrowserSession(session.sessionId);
      return browserToolActionResultSchema.parse({ session: fresh ?? session, frame, text });
    },
    captureFrame,
    startFrameStream,
    capacity: () => capacity.snapshot(),
    captureMetrics,
    stopPane: stopPaneById,
    async stopDetached(session) {
      closingSessions.add(session.sessionId);
      try {
        await runtimeStarts.get(session.sessionId)?.catch(() => undefined);
        const runtime = runtimes.get(session.sessionId);
        runtimes.delete(session.sessionId);
        capacity.releaseSession(session.sessionId);
        capacity.releaseLive(`stream:${session.sessionId}`);
        try {
          runtime?.detachDiagnostics();
        } catch {
          // Best effort: process termination below is the authoritative cleanup.
        }
        if (runtime) await releaseRuntime(runtime);
      } finally { closingSessions.delete(session.sessionId); }
    },
    async stopRoom(roomId, traceId, context) {
      const sessions = await store.listActivePaneBrowserSessions(roomId);
      await Promise.all(sessions.map((session) => stopPaneById(session.paneId, traceId, context)));
    },
    async closeAll() {
      closingAll = true;
      for (const { timer } of googleCheckTimers.values()) clearTimeout(timer);
      googleCheckTimers.clear();
      await Promise.allSettled([...paneStarts.values(), ...runtimeStarts.values(), ...[...googleChecks.values()].map(check => check.promise), ...profileMoves, profileMoveRecovery]);
      const sessions = [...runtimes.keys()];
      await Promise.all(
        sessions.map(async (sessionId) => {
          const runtime = runtimes.get(sessionId);
          runtimes.delete(sessionId);
          capacity.releaseSession(sessionId);
          capacity.releaseLive(`stream:${sessionId}`);
          try {
            runtime?.detachDiagnostics();
          } catch {
            // Closing the API should not hang on CDP socket state.
          }
          if (runtime) await releaseRuntime(runtime);
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

export interface ElementScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export async function resolveElementScreenshotClip(
  client: { send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any> },
  sessionId: string,
  selector: string
): Promise<ElementScreenshotClip | null> {
  const doc = await client.send("DOM.getDocument", {}, sessionId);
  if (!doc?.root?.nodeId) return null;
  const queried = await client.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector }, sessionId);
  if (!queried?.nodeId) return null;
  const box = await client.send("DOM.getBoxModel", { nodeId: queried.nodeId }, sessionId);
  const border = box?.model?.border;
  if (!border || !Array.isArray(border) || border.length < 8) return null;
  const xs = [border[0], border[2], border[4], border[6]];
  const ys = [border[1], border[3], border[5], border[7]];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    scale: 1
  };
}
