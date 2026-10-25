import type {
  AcquireBrowserControlInput,
  BrowserCaptureJob,
  BrowserCaptureMetrics,
  BrowserCaptureOptions,
  BrowserControlLease,
  BrowserControlLeaseActionInput,
  BrowserFrame,
  BrowserPageSummary,
  BrowserRuntimeInput,
  BrowserSessionViewport,
  BrowserViewportDimensions,
  BrowserStreamMode,
  BrowserToolActionInput,
  BrowserToolActionResult,
  Pane,
  PaneBrowserSessionResponse
} from "@space/contracts";

export interface BrowserHostActionContext {
  holderType: "OPERATOR" | "AGENT";
  holderId: string;
}
export type BrowserHostActorContext = BrowserHostActionContext;

export interface BrowserHostStartInput {
  pane: Pane;
  profileKey?: string | null;
  sharedProfileKey?: string;
  googleAccount?: { ownerUserId: string; accountId: string };
  viewport?: BrowserSessionViewport;
  targetUrl?: string | null;
  streamMode?: BrowserStreamMode;
  ownerAgentId?: string | null;
  traceId: string;
}

export interface BrowserHostStreamHints {
  visible?: boolean;
  focused?: boolean;
  resourcePressure?: boolean;
}

export interface BrowserHostStreamProfile {
  requestedMode: BrowserStreamMode;
  resolvedMode: Exclude<BrowserStreamMode, "AUTO">;
  framesPerSecond: number;
  format: "jpeg";
  quality: number;
}

export interface BrowserHostBinaryFrame {
  sessionId: string;
  sequence: number;
  data: Buffer;
  mimeType: "image/jpeg";
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface BrowserHostStreamHandle {
  id: string;
  profile: BrowserHostStreamProfile;
  stop(): Promise<void>;
}

export interface BrowserHostAudioChunk {
  sessionId: string;
  sequence: number;
  data: Buffer;
  sampleRate: number;
  channels: number;
  format: "s16le";
  capturedAt: string;
}

export interface BrowserHostAudioStreamHandle {
  id: string;
  sampleRate: number;
  channels: number;
  format: "s16le";
  stop(): Promise<void>;
}

export type BrowserHostRuntimeInput = BrowserRuntimeInput;

export interface BrowserHostCaptureContext {
  requestedByType: "AGENT" | "OPERATOR";
  requestedById: string;
  traceId: string;
}

export interface BrowserHostStatus {
  enabled: boolean;
  statusReason: string;
  defaultUrl: string;
  checkedAt: string;
  capacity?: BrowserHostCapacity;
}

export interface BrowserHostCapacity {
  activeSessions: number;
  maxSessions: number;
  activeLiveWorkloads: number;
  maxLiveWorkloads: number;
}

export type BrowserHostCaptureMetrics = BrowserCaptureMetrics;

export interface BrowserHostHealth {
  hostPid: number;
  startedAt: string;
  buildCommit: string | null;
  status: BrowserHostStatus;
  capacity: BrowserHostCapacity | null;
  captureMetrics: BrowserHostCaptureMetrics;
}

export interface BrowserHostPageList {
  sessionId: string;
  activePageId: string | null;
  pages: BrowserPageSummary[];
}

export interface BrowserHostGoogleAccountIdentity {
  ownerUserId: string;
  accountId: string;
}

/** Redacted Google session state of a verified account's persistent profile. */
export interface BrowserHostGoogleAccountCheck {
  status: "NOT_CONNECTED" | "CONNECTED" | "REAUTHENTICATION_REQUIRED" | "UNKNOWN";
  reason: string;
  checkedAt: string | null;
  connectedAt: string | null;
}

export interface BrowserHostPaneProfileSource {
  ownerUserId: string;
  roomId: string;
  paneId: string;
  profileKey: string | null;
  accountId?: string;
}

export interface BrowserHostPaneProfileAdoption {
  result: "ADOPTED" | "ALREADY_CONNECTED" | "TARGET_IN_USE" | "SOURCE_IN_USE" | "SOURCE_MISSING" | "NO_SIGN_IN" | "OTHER_ACCOUNT" | "CHECK_FAILED";
  accountId: string | null;
}

export interface BrowserHostDiagnostics {
  sessionId: string;
  events: Array<Record<string, unknown>>;
}

export interface BrowserHostRuntime {
  status(): BrowserHostStatus | Promise<BrowserHostStatus>;
  capacity?(): BrowserHostCapacity;
  captureMetrics?(): Promise<BrowserHostCaptureMetrics>;
  startOrRestore(input: BrowserHostStartInput, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  getActive(pane: Pane): Promise<PaneBrowserSessionResponse | null>;
  navigate(pane: Pane, url: string, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  setViewport(pane: Pane, viewport: BrowserSessionViewport, traceId: string, context?: BrowserHostActorContext, dimensions?: BrowserViewportDimensions): Promise<PaneBrowserSessionResponse>;
  setStreamMode?(pane: Pane, mode: BrowserStreamMode, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  action(pane: Pane, input: BrowserToolActionInput, traceId: string, context?: BrowserHostActionContext): Promise<BrowserToolActionResult>;
  captureFrame(sessionId: string): Promise<BrowserFrame>;
  stopPane(paneId: string, traceId?: string, context?: BrowserHostActorContext): Promise<void>;
  stopRoom(roomId: string, traceId?: string, context?: BrowserHostActorContext): Promise<void>;
  listPages?(pane: Pane): Promise<BrowserHostPageList>;
  createPage?(pane: Pane, url: string | undefined, activate: boolean, traceId: string, context?: BrowserHostActorContext): Promise<BrowserHostPageList>;
  activatePage?(pane: Pane, pageId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserHostPageList>;
  closePage?(pane: Pane, pageId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserHostPageList>;
  acquireControl?(pane: Pane, input: AcquireBrowserControlInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease>;
  heartbeatControl?(pane: Pane, input: BrowserControlLeaseActionInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease>;
  releaseControl?(pane: Pane, input: BrowserControlLeaseActionInput, traceId: string, context?: BrowserHostActorContext): Promise<BrowserControlLease>;
  dispatchInput?(pane: Pane, input: BrowserHostRuntimeInput, traceId: string, context?: BrowserHostActorContext): Promise<void>;
  input?(pane: Pane, input: BrowserHostRuntimeInput, traceId: string, context?: BrowserHostActorContext): Promise<PaneBrowserSessionResponse>;
  createCapture?(pane: Pane, options: BrowserCaptureOptions, context: BrowserHostCaptureContext): Promise<BrowserCaptureJob>;
  getCapture?(pane: Pane, jobId: string): Promise<BrowserCaptureJob>;
  stopCapture?(pane: Pane, jobId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserCaptureJob>;
  cancelCapture?(pane: Pane, jobId: string, traceId: string, context?: BrowserHostActorContext): Promise<BrowserCaptureJob>;
  diagnostics?(pane: Pane, includeNetwork: boolean, limit: number): Promise<BrowserHostDiagnostics>;
  /** Vault (ADR-012): the pane's live top frame for a broker use capability, and the sealed fill itself. */
  vaultTarget?(pane: Pane): Promise<unknown>;
  vaultFill?(pane: Pane, request: unknown, traceId: string): Promise<unknown>;
  checkGoogleAccount?(identity: BrowserHostGoogleAccountIdentity, launch: boolean, context?: BrowserHostActorContext): Promise<BrowserHostGoogleAccountCheck>;
  adoptPaneGoogleProfile?(source: BrowserHostPaneProfileSource, context?: BrowserHostActorContext): Promise<BrowserHostPaneProfileAdoption>;
  startFrameStream?(
    sessionId: string,
    mode: BrowserStreamMode,
    onFrame: (frame: BrowserHostBinaryFrame) => void | Promise<void>,
    hints?: BrowserHostStreamHints
  ): Promise<BrowserHostStreamHandle>;
  startAudioStream?(
    sessionId: string,
    onChunk: (chunk: BrowserHostAudioChunk) => void | Promise<void>
  ): Promise<BrowserHostAudioStreamHandle>;
  closeAll(): Promise<void>;
}

export type BrowserHostMethod =
  | "health"
  | "startOrRestore"
  | "getActive"
  | "navigate"
  | "setViewport"
  | "setStreamMode"
  | "action"
  | "captureFrame"
  | "stopPane"
  | "stopRoom"
  | "listPages"
  | "createPage"
  | "activatePage"
  | "closePage"
  | "acquireControl"
  | "heartbeatControl"
  | "releaseControl"
  | "dispatchInput"
  | "input"
  | "createCapture"
  | "getCapture"
  | "stopCapture"
  | "cancelCapture"
  | "diagnostics"
  | "vaultTarget"
  | "vaultFill"
  | "checkGoogleAccount"
  | "adoptPaneGoogleProfile"
  | "startFrameStream"
  | "stopFrameStream"
  | "startAudioStream"
  | "stopAudioStream";

export interface BrowserHostRequestHandler {
  health(): Promise<BrowserHostHealth>;
  request(method: Exclude<BrowserHostMethod, "health" | "startFrameStream" | "stopFrameStream" | "startAudioStream" | "stopAudioStream">, params: Record<string, unknown>): Promise<unknown>;
  startFrameStream(
    params: Record<string, unknown>,
    onFrame: (frame: BrowserHostBinaryFrame) => void | Promise<void>
  ): Promise<BrowserHostStreamHandle>;
  startAudioStream(
    params: Record<string, unknown>,
    onChunk: (chunk: BrowserHostAudioChunk) => void | Promise<void>
  ): Promise<BrowserHostAudioStreamHandle>;
}
