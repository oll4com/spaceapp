import {
  Bookmark,
  BookmarkPlus,
  Bug,
  Camera,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Download,
  Globe2,
  Keyboard,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Send,
  Smartphone,
  Square,
  Tablet,
  Trash2,
  Upload,
  UserCheck,
  Video,
  X
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent
} from "react";
import {
  browserStreamWebSocketServerMessageSchema,
  type Artifact,
  type BrowserBookmark,
  type BrowserFrame,
  type BrowserSessionViewport,
  type Pane,
  type PaneBrowserSessionResponse
} from "@space/contracts";
import {
  api,
  type BrowserCaptureJobPayload,
  type BrowserCaptureSegmentListPayload,
  type BrowserCaptureTimelinePayload,
  type BrowserControlLeasePayload,
  type BrowserDiagnosticsPayload,
  type BrowserInputPayload,
  type BrowserPageListPayload,
  type BrowserPageSummaryPayload,
  type BrowserRecordingManifestPayload,
  type BrowserStatusPayload,
  type BrowserStreamMode
} from "../../api.js";
import { browserGateway } from "../../runtime/SpaceRuntime.js";
import { useDismissibleToolbarLayer, usePersistentIconToolbar, type IconToolbarAction } from "../../icon-toolbar.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { BrowserCanvas, type BrowserCanvasHandle, type BrowserCanvasInput } from "./BrowserCanvas.js";
import {
  BROWSER_PANE_ACTION_EVENT,
  parseBrowserPaneActionDetail,
  registerBrowserPaneEventTarget
} from "./events.js";

export {
  BROWSER_PANE_ACTION_EVENT,
  parseBrowserPaneActionDetail,
  type BrowserPaneAction,
  type BrowserPaneActionDetail
} from "./events.js";

interface BrowserPaneProps {
  pane: Pane;
  agentNumber: number;
}

type BrowserFrameMessage =
  | { type: "ready"; paneId: string; sessionId: string }
  | { type: "frame"; frame: BrowserFrame }
  | { type: "status"; status: string; statusReason?: string | null }
  | { type: "error"; code: string; message: string };

const defaultViewport: BrowserSessionViewport = "desktop";
const BROWSER_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY = "space.browserToolbar.hiddenActionIds";
const BROWSER_TOOLBAR_ACTION_ORDER_STORAGE_KEY = "space.browserToolbar.actionOrder";

const recordingDurationOptions = [
  { label: "10s", milliseconds: 10_000 },
  { label: "30s", milliseconds: 30_000 },
  { label: "1m", milliseconds: 60_000 },
  { label: "5m", milliseconds: 300_000 },
  { label: "30m", milliseconds: 1_800_000 }
] as const;

type BrowserDebugTab = "console" | "network" | "timeline" | "artifacts";
type BrowserSessionV2 = PaneBrowserSessionResponse["session"];

const streamModeOptions: Array<{ id: BrowserStreamMode; label: string }> = [
  { id: "AUTO", label: "Auto" },
  { id: "SILENT", label: "Silent" },
  { id: "PREVIEW", label: "Preview" },
  { id: "INTERACTIVE", label: "Interactive" },
  { id: "REALTIME", label: "Real-time" }
];

const emptyDiagnostics: BrowserDiagnosticsPayload = { sessionId: "browser:pending", events: [] };

function metadataText(metadata: Record<string, unknown>, key: string, fallback = "-"): string {
  const value = metadata[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

function isUnavailableV2Feature(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 405 || status === 501) return true;
  }
  return error instanceof Error && error.message.toLowerCase().includes("legacy browser host");
}

const viewportOptions: Array<{ id: BrowserSessionViewport; label: string; title: string; Icon: typeof Monitor }> = [
  { id: "desktop", label: "PC", title: "PC view", Icon: Monitor },
  { id: "tablet", label: "Tablet", title: "Tablet view", Icon: Tablet },
  { id: "mobile", label: "Mobile", title: "Mobile view", Icon: Smartphone }
];

const viewportSizes: Record<BrowserSessionViewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 }
};

const browserInputAckTimeoutMs = 2_000;
const browserStreamReconnectMessage = "Browser frame stream disconnected; reconnecting.";

interface PendingBrowserInputAck {
  sentAt: number;
  timeoutId: number;
}

function displayUrl(response: PaneBrowserSessionResponse | null, status: BrowserStatusPayload | null): string {
  return response?.session.currentUrl ?? response?.session.targetUrl ?? status?.defaultUrl ?? "https://www.example.invalid/";
}

function isBrowserFrameMessage(value: unknown): value is BrowserFrameMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

function scrollPaneIntoView(element: HTMLElement | null) {
  if (typeof element?.scrollIntoView !== "function") return;
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function BrowserPane({ pane, agentNumber }: BrowserPaneProps) {
  const [status, setStatus] = useState<BrowserStatusPayload | null>(null);
  const [response, setResponse] = useState<PaneBrowserSessionResponse | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [url, setUrl] = useState("https://www.example.invalid/");
  const [handoff, setHandoff] = useState(false);
  const [controlLease, setControlLease] = useState<BrowserControlLeasePayload | null>(null);
  const [streamMode, setStreamMode] = useState<BrowserStreamMode>("AUTO");
  const [pages, setPages] = useState<BrowserPageSummaryPayload[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [canvasHistoryLength, setCanvasHistoryLength] = useState(0);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState<number | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugTab, setDebugTab] = useState<BrowserDebugTab>("console");
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnosticsPayload>(emptyDiagnostics);
  const [diagnosticsPending, setDiagnosticsPending] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<string | null>(null);
  const [captureJobs, setCaptureJobs] = useState<BrowserCaptureJobPayload[]>([]);
  const [recordingControlsOpen, setRecordingControlsOpen] = useState(false);
  const [recordingDurationMs, setRecordingDurationMs] = useState(60_000);
  const [recordingActionPending, setRecordingActionPending] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactsPending, setArtifactsPending] = useState(false);
  const [selectedRecordingJobId, setSelectedRecordingJobId] = useState<string | null>(null);
  const [loadedRecordingManifest, setLoadedRecordingManifest] = useState<{
    artifactId: string;
    payload: BrowserRecordingManifestPayload;
  } | null>(null);
  const [recordingManifestPendingId, setRecordingManifestPendingId] = useState<string | null>(null);
  const [recordingManifestFailedId, setRecordingManifestFailedId] = useState<string | null>(null);
  const [recordingTimeline, setRecordingTimeline] = useState<{ jobId: string; payload: BrowserCaptureTimelinePayload } | null>(null);
  const [recordingSegments, setRecordingSegments] = useState<{ jobId: string; payload: BrowserCaptureSegmentListPayload } | null>(null);
  const [recordingTimelinePending, setRecordingTimelinePending] = useState(false);
  const [persistedRecordingFrame, setPersistedRecordingFrame] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [textInputOpen, setTextInputOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarksLoaded, setBookmarksLoaded] = useState(false);
  const [bookmarksPending, setBookmarksPending] = useState(false);
  const [bookmarkNotice, setBookmarkNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<BrowserCanvasHandle | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  const browserToolbarRef = useRef<HTMLDivElement | null>(null);
  const bookmarkImportRef = useRef<HTMLInputElement | null>(null);
  const handoffInputRef = useRef<HTMLInputElement | null>(null);
  const persistedRecordingVideoRef = useRef<HTMLVideoElement | null>(null);
  const controlLeaseRef = useRef<BrowserControlLeasePayload | null>(null);
  const controlAcquirePromiseRef = useRef<Promise<BrowserControlLeasePayload | null> | null>(null);
  const legacyControlRef = useRef(false);
  const legacyPointerDownRef = useRef<{ x: number; y: number; button: string } | null>(null);
  const browserStreamSocketRef = useRef<WebSocket | null>(null);
  const browserStreamAttemptedSessionsRef = useRef(new Set<string>());
  const browserInputSequenceRef = useRef(0);
  const pendingBrowserInputAcksRef = useRef(new Map<string, PendingBrowserInputAck>());
  const coalescedBrowserInputRef = useRef<BrowserInputPayload | null>(null);
  const coalescedBrowserInputFrameRef = useRef<number | null>(null);

  const session = (response?.session as BrowserSessionV2 | undefined) ?? null;
  const viewport = session?.viewport ?? defaultViewport;
  const activeFrame = frame ?? response?.frame ?? null;
  const statusText = session?.statusReason ?? status?.statusReason ?? "Browser session";
  const canUseSession = Boolean(session && status?.enabled);
  const activeRecordingJob = captureJobs.find(
    (job) => job.options.kind === "RECORDING" && (job.status === "QUEUED" || job.status === "RUNNING")
  ) ?? null;
  const recording = Boolean(activeRecordingJob);
  const persistedRecordings = useMemo(() => artifacts.flatMap((videoArtifact) => {
    const jobId = typeof videoArtifact.metadata.browserCaptureJobId === "string"
      ? videoArtifact.metadata.browserCaptureJobId
      : null;
    const filename = typeof videoArtifact.metadata.filename === "string" ? videoArtifact.metadata.filename : null;
    if (
      videoArtifact.kind !== "VIDEO" ||
      videoArtifact.mimeType !== "video/webm" ||
      !jobId ||
      (filename !== null && filename !== "recording.webm")
    ) return [];
    const manifestArtifact = artifacts.find((candidate) =>
      candidate.kind === "EXPORT" &&
      candidate.mimeType === "application/json" &&
      candidate.metadata.browserCaptureJobId === jobId
    ) ?? null;
    return [{ jobId, videoArtifact, manifestArtifact }];
  }), [artifacts]);
  const selectedPersistedRecording = persistedRecordings.find((recordingItem) => recordingItem.jobId === selectedRecordingJobId)
    ?? persistedRecordings[0]
    ?? null;
  const recordingManifest = selectedPersistedRecording?.manifestArtifact && loadedRecordingManifest?.artifactId === selectedPersistedRecording.manifestArtifact.id
    ? loadedRecordingManifest.payload
    : null;
  const persistedTimeline = selectedPersistedRecording && recordingTimeline?.jobId === selectedPersistedRecording.jobId
    ? recordingTimeline.payload
    : null;
  const persistedSegments = selectedPersistedRecording && recordingSegments?.jobId === selectedPersistedRecording.jobId
    ? recordingSegments.payload.segments
    : [];
  const persistedFrameCount = persistedTimeline?.frames.length ?? recordingManifest?.frameCount ?? 0;
  const timelineEvents = persistedTimeline?.events ?? diagnostics.events;

  function appendFrame(nextFrame: BrowserFrame | null) {
    if (!nextFrame) return;
    setFrame(nextFrame);
    setSelectedFrameIndex(null);
  }

  function updateBrowserStreamTelemetry(state: string, input: { fps?: number; mode?: string } = {}) {
    const element = paneRef.current;
    if (!element) return;
    element.dataset.browserStreamState = state;
    if (input.fps !== undefined) element.dataset.browserStreamFps = String(input.fps);
    if (input.mode !== undefined) element.dataset.browserStreamMode = input.mode;
  }

  function updateBrowserInputTelemetry(lastAck?: "ok" | "failed" | "timeout") {
    const element = paneRef.current;
    if (!element) return;
    element.dataset.browserInputPending = String(pendingBrowserInputAcksRef.current.size);
    if (lastAck) element.dataset.browserInputLastAck = lastAck;
  }

  function clearPendingBrowserInputAcks(lastAck?: "timeout") {
    for (const pendingAck of pendingBrowserInputAcksRef.current.values()) {
      window.clearTimeout(pendingAck.timeoutId);
    }
    pendingBrowserInputAcksRef.current.clear();
    updateBrowserInputTelemetry(lastAck);
  }

  function sendBrowserInputNow(input: BrowserInputPayload): boolean {
    const socket = browserStreamSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    browserInputSequenceRef.current += 1;
    const requestId = `browser-input:${Date.now().toString(36)}:${browserInputSequenceRef.current.toString(36)}`;
    const sentAt = performance.now();
    const timeoutId = window.setTimeout(() => {
      const pendingAck = pendingBrowserInputAcksRef.current.get(requestId);
      if (!pendingAck) return;
      pendingBrowserInputAcksRef.current.delete(requestId);
      updateBrowserInputTelemetry("timeout");
    }, browserInputAckTimeoutMs);
    pendingBrowserInputAcksRef.current.set(requestId, { sentAt, timeoutId });
    updateBrowserInputTelemetry();
    try {
      socket.send(JSON.stringify({ type: "input", requestId, input }));
      return true;
    } catch {
      window.clearTimeout(timeoutId);
      pendingBrowserInputAcksRef.current.delete(requestId);
      updateBrowserInputTelemetry();
      return false;
    }
  }

  function flushCoalescedBrowserInput(): void {
    if (coalescedBrowserInputFrameRef.current !== null) {
      window.cancelAnimationFrame(coalescedBrowserInputFrameRef.current);
      coalescedBrowserInputFrameRef.current = null;
    }
    const pendingInput = coalescedBrowserInputRef.current;
    coalescedBrowserInputRef.current = null;
    if (pendingInput) sendBrowserInputNow(pendingInput);
  }

  function discardCoalescedBrowserInput(): void {
    if (coalescedBrowserInputFrameRef.current !== null) {
      window.cancelAnimationFrame(coalescedBrowserInputFrameRef.current);
      coalescedBrowserInputFrameRef.current = null;
    }
    coalescedBrowserInputRef.current = null;
  }

  function sendRealtimeBrowserInput(input: BrowserInputPayload): boolean {
    const socket = browserStreamSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const coalescible =
      (input.type === "POINTER" && input.eventType === "mouseMoved") ||
      (input.type === "TOUCH" && input.eventType === "touchMove");
    if (!coalescible) {
      flushCoalescedBrowserInput();
      return sendBrowserInputNow(input);
    }
    coalescedBrowserInputRef.current = input;
    if (coalescedBrowserInputFrameRef.current === null) {
      coalescedBrowserInputFrameRef.current = window.requestAnimationFrame(() => {
        coalescedBrowserInputFrameRef.current = null;
        const pendingInput = coalescedBrowserInputRef.current;
        coalescedBrowserInputRef.current = null;
        if (pendingInput) sendBrowserInputNow(pendingInput);
      });
    }
    return true;
  }

  function syntheticPage(nextSession: BrowserSessionV2): BrowserPageSummaryPayload[] {
    if (nextSession.pages?.length) return nextSession.pages;
    return [
      {
        pageId: nextSession.activePageId ?? `legacy:${nextSession.sessionId}`,
        kind: "PAGE",
        title: nextSession.title ?? "Browser",
        url: nextSession.currentUrl ?? nextSession.targetUrl,
        isActive: true,
        openerPageId: null,
        canGoBack: false,
        canGoForward: false
      }
    ];
  }

  useEffect(() => {
    const jobId = selectedPersistedRecording?.jobId ?? null;
    if (!jobId) {
      setRecordingTimeline(null);
      setRecordingSegments(null);
      setRecordingTimelinePending(false);
      return;
    }
    let cancelled = false;
    setRecordingTimelinePending(true);
    Promise.all([
      api.browserCaptureTimeline(pane.id, jobId),
      api.browserCaptureSegments(pane.id, jobId)
    ]).then(([timeline, segments]) => {
      if (cancelled) return;
      setRecordingTimeline({ jobId, payload: timeline });
      setRecordingSegments({ jobId, payload: segments });
      setPersistedRecordingFrame(0);
    }).catch(() => {
      if (cancelled) return;
      setRecordingTimeline(null);
      setRecordingSegments(null);
    }).finally(() => {
      if (!cancelled) setRecordingTimelinePending(false);
    });
    return () => { cancelled = true; };
  }, [pane.id, selectedPersistedRecording?.jobId]);

  useEffect(() => {
    recordLifecycleDebugEvent({
      type: "component_mounted",
      scope: "BrowserPane",
      detail: `pane=${pane.title}`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    return () => {
      recordLifecycleDebugEvent({
        type: "component_unmounted",
        scope: "BrowserPane",
        detail: `pane=${pane.title}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
    };
  }, [pane.id, pane.mode, pane.title]);

  function applyResponse(next: PaneBrowserSessionResponse) {
    setResponse(next);
    appendFrame(next.frame);
    setUrl(displayUrl(next, status));
    const nextSession = next.session as BrowserSessionV2;
    setStreamMode(nextSession.streamMode ?? "AUTO");
    const nextPages = syntheticPage(nextSession);
    setPages(nextPages);
    setActivePageId(nextSession.activePageId ?? nextPages.find((page) => page.isActive)?.pageId ?? nextPages[0]?.pageId ?? null);
  }

  async function loadPages() {
    try {
      const next = await api.browserPages(pane.id);
      setPages(next.pages);
      setActivePageId(next.activePageId);
    } catch {
      // The legacy browser host exposes one implicit page through the session response.
    }
  }

  async function loadArtifacts() {
    setArtifactsPending(true);
    try {
      const next = await api.artifacts({ roomId: pane.roomId, paneId: pane.id, pageSize: 100, sortOrder: "desc" });
      setArtifacts(next.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser artifacts failed to load");
    } finally {
      setArtifactsPending(false);
    }
  }

  async function loadOrStart(showPending = true) {
    if (showPending) setPending(true);
    setError(null);
    try {
      const nextStatus = await api.browserStatus();
      setStatus(nextStatus);
      setUrl((current) => current || nextStatus.defaultUrl);
      if (!nextStatus.enabled) {
        setResponse(null);
        setFrame(null);
        return;
      }
      try {
        const nextResponse = await api.browserSession(pane.id);
        applyResponse(nextResponse);
        void loadPages();
        recordLifecycleDebugEvent({
          type: "session_sync",
          scope: "BrowserPane",
          detail: `status=${nextResponse.session.status} viewport=${nextResponse.session.viewport}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
      } catch {
        const nextResponse = await api.startBrowserSession(pane.id, {
          viewport: defaultViewport,
          targetUrl: nextStatus.defaultUrl,
          ownerAgentId: `agent:${agentNumber}`
        });
        applyResponse(nextResponse);
        void loadPages();
        recordLifecycleDebugEvent({
          type: "session_sync",
          scope: "BrowserPane",
          detail: `started viewport=${nextResponse.session.viewport} status=${nextResponse.session.status}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser session failed to load");
    } finally {
      if (showPending) setPending(false);
    }
  }

  useEffect(() => {
    void loadOrStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    const fallbackTicket = response?.websocket ?? null;
    const sessionId = session?.sessionId ?? null;
    if (!fallbackTicket || !sessionId || streamMode === "SILENT") {
      updateBrowserStreamTelemetry(streamMode === "SILENT" ? "silent" : "idle");
      return;
    }
    let disposed = false;
    let activeSocket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let connectionAttempt = 0;
    const isFirstConnectionForSession = !browserStreamAttemptedSessionsRef.current.has(sessionId);
    browserStreamAttemptedSessionsRef.current.add(sessionId);

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== null) return;
      const delayMs = Math.min(2_000, 250 * (2 ** Math.min(reconnectAttempt, 3)));
      reconnectAttempt += 1;
      updateBrowserStreamTelemetry("reconnecting");
      setError((current) => current ?? browserStreamReconnectMessage);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delayMs);
    };

    const connect = async () => {
      const isInitialAttempt = connectionAttempt === 0;
      connectionAttempt += 1;
      updateBrowserStreamTelemetry("ticket");
      let ticket = null;
      try {
        ticket = (await api.browserStreamTicket(pane.id)).websocket;
      } catch {
        if (isInitialAttempt && isFirstConnectionForSession) ticket = fallbackTicket;
        else {
          scheduleReconnect();
          return;
        }
      }
      if (disposed) return;
      if (ticket.paneId !== pane.id || ticket.sessionId !== sessionId) {
        setError("Browser frame stream returned a ticket for a different session.");
        scheduleReconnect();
        return;
      }
      const realtimeUrl = api.browserStreamWebSocketUrl?.(ticket, streamMode) ?? null;
      const socketUrl = realtimeUrl ?? api.browserFrameWebSocketUrl(ticket);
      if (!socketUrl) {
        scheduleReconnect();
        return;
      }
      const realtime = Boolean(realtimeUrl);
      const socket = browserGateway.connect(socketUrl);
      activeSocket = socket;
      socket.binaryType = "blob";
      updateBrowserStreamTelemetry("connecting");
      socket.addEventListener("open", () => {
        if (!disposed) updateBrowserStreamTelemetry("open");
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof Blob) {
          canvasRef.current?.present(event.data, new Date().toISOString());
          return;
        }
        try {
          const decoded = JSON.parse(String(event.data)) as unknown;
          const realtimeMessage = browserStreamWebSocketServerMessageSchema.safeParse(decoded);
          if (realtimeMessage.success) {
            const message = realtimeMessage.data;
            if (message.type === "ready") {
              if (message.paneId !== pane.id || message.sessionId !== sessionId) {
                setError("Browser frame stream connected to a different session.");
                socket.close(1008, "Browser stream identity mismatch");
                return;
              }
              if (realtime) browserStreamSocketRef.current = socket;
              reconnectAttempt = 0;
              updateBrowserStreamTelemetry(realtime ? "ready" : "legacy-ready", {
                fps: message.framesPerSecond,
                mode: message.resolvedMode
              });
              setError((current) => current === browserStreamReconnectMessage ? null : current);
              return;
            }
            if (message.type === "inputAck") {
              const pendingAck = pendingBrowserInputAcksRef.current.get(message.requestId);
              if (pendingAck) {
                window.clearTimeout(pendingAck.timeoutId);
                pendingBrowserInputAcksRef.current.delete(message.requestId);
                const roundTripMs = Math.max(0, Math.round(performance.now() - pendingAck.sentAt));
                if (paneRef.current) paneRef.current.dataset.browserInputRttMs = String(roundTripMs);
                updateBrowserInputTelemetry(message.ok ? "ok" : "failed");
              }
              if (!message.ok) setError(message.error.message);
              return;
            }
            setError(message.message);
            return;
          }
          if (!isBrowserFrameMessage(decoded)) throw new Error("invalid browser stream message");
          if (decoded.type === "ready") {
            if (decoded.paneId !== pane.id || decoded.sessionId !== sessionId) {
              socket.close(1008, "Browser frame identity mismatch");
              return;
            }
            reconnectAttempt = 0;
            updateBrowserStreamTelemetry("legacy-ready");
          } else if (decoded.type === "frame") {
            appendFrame(decoded.frame);
          } else if (decoded.type === "error") {
            setError(decoded.message);
          }
        } catch {
          setError("Browser frame stream returned invalid data.");
        }
      });
      socket.addEventListener("error", () => {
        if (disposed) return;
        updateBrowserStreamTelemetry("error");
        socket.close();
      });
      socket.addEventListener("close", () => {
        if (browserStreamSocketRef.current === socket) browserStreamSocketRef.current = null;
        discardCoalescedBrowserInput();
        if (pendingBrowserInputAcksRef.current.size > 0) clearPendingBrowserInputAcks("timeout");
        if (!disposed) scheduleReconnect();
      });
    };

    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (browserStreamSocketRef.current === activeSocket) browserStreamSocketRef.current = null;
      discardCoalescedBrowserInput();
      clearPendingBrowserInputAcks();
      activeSocket?.close();
      updateBrowserStreamTelemetry("closed");
    };
    // Browser input refs intentionally keep high-frequency ACKs outside React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, response?.websocket?.token, session?.sessionId, streamMode]);

  useEffect(() => {
    controlLeaseRef.current = controlLease?.status === "ACTIVE" ? controlLease : null;
  }, [controlLease]);

  useEffect(() => {
    if (!debugOpen || debugTab !== "timeline") return;
    const updateHistoryLength = () => setCanvasHistoryLength(canvasRef.current?.historyLength() ?? 0);
    updateHistoryLength();
    const interval = window.setInterval(updateHistoryLength, 250);
    return () => window.clearInterval(interval);
  }, [debugOpen, debugTab]);

  useEffect(() => {
    if (!session || streamMode === "SILENT") return;
    const intervalMs = streamMode === "PREVIEW" || streamMode === "AUTO" ? 5000 : streamMode === "INTERACTIVE" ? 1500 : 5000;
    const interval = window.setInterval(() => {
      if (browserStreamSocketRef.current?.readyState === WebSocket.OPEN) return;
      api.browserFrame(pane.id, session.sessionId).then(appendFrame).catch(() => undefined);
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [pane.id, session?.sessionId, streamMode]);

  useEffect(() => {
    if (!controlLease) return;
    const interval = window.setInterval(() => {
      api.heartbeatBrowserControl(pane.id, { leaseId: controlLease.leaseId, ttlSeconds: 60 })
        .then((next) => {
          if (next.lease.status === "ACTIVE") {
            setControlLease(next.lease);
          } else {
            setControlLease(null);
            setHandoff(false);
          }
        })
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [controlLease?.leaseId, pane.id]);

  useEffect(() => {
    const activeJobs = captureJobs.filter((job) => job.status === "QUEUED" || job.status === "RUNNING");
    if (activeJobs.length === 0) return;
    const interval = window.setInterval(() => {
      void Promise.all(activeJobs.map((job) => api.browserCapture(pane.id, job.jobId).then((next) => next.job).catch(() => job))).then((updated) => {
        setCaptureJobs((current) => current.map((job) => updated.find((next) => next.jobId === job.jobId) ?? job));
        if (updated.some((job) => job.status === "COMPLETED" && job.artifactIds.length > 0)) void loadArtifacts();
      });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [captureJobs, pane.id]);

  useEffect(() => {
    if (!selectedPersistedRecording) {
      setSelectedRecordingJobId(null);
      setLoadedRecordingManifest(null);
      return;
    }
    if (selectedRecordingJobId !== selectedPersistedRecording.jobId) {
      setSelectedRecordingJobId(selectedPersistedRecording.jobId);
    }
  }, [selectedPersistedRecording, selectedRecordingJobId]);

  useEffect(() => {
    const manifestArtifact = selectedPersistedRecording?.manifestArtifact ?? null;
    if (!manifestArtifact) {
      setLoadedRecordingManifest(null);
      setRecordingManifestPendingId(null);
      setRecordingManifestFailedId(null);
      return;
    }
    if (loadedRecordingManifest?.artifactId === manifestArtifact.id) return;
    let cancelled = false;
    setLoadedRecordingManifest(null);
    setRecordingManifestPendingId(manifestArtifact.id);
    setRecordingManifestFailedId(null);
    setPersistedRecordingFrame(0);
    api.browserRecordingManifest(manifestArtifact.id)
      .then((payload) => {
        if (!cancelled) setLoadedRecordingManifest({ artifactId: manifestArtifact.id, payload });
      })
      .catch((err) => {
        if (!cancelled) {
          setRecordingManifestFailedId(manifestArtifact.id);
          setError(err instanceof Error ? err.message : "Browser recording manifest failed to load");
        }
      })
      .finally(() => {
        if (!cancelled) setRecordingManifestPendingId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [loadedRecordingManifest?.artifactId, selectedPersistedRecording?.manifestArtifact]);

  useEffect(() => {
    function syncFullscreenState() {
      if (!document.fullscreenElement) setFocusMode(false);
    }
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  async function navigate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      applyResponse(await api.navigateBrowser(pane.id, url.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser navigation failed");
    } finally {
      setPending(false);
    }
  }

  async function setViewport(nextViewport: BrowserSessionViewport) {
    if (pending || nextViewport === viewport) return;
    setPending(true);
    setError(null);
    try {
      applyResponse(await api.setBrowserViewport(pane.id, nextViewport));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser viewport update failed");
    } finally {
      setPending(false);
    }
  }

  async function setStream(nextMode: BrowserStreamMode) {
    if (!session || pending || nextMode === streamMode) return;
    const previous = streamMode;
    setStreamMode(nextMode);
    setPending(true);
    setError(null);
    try {
      applyResponse(await api.updateBrowserSession(pane.id, { streamMode: nextMode }));
    } catch (err) {
      if (!isUnavailableV2Feature(err)) {
        setStreamMode(previous);
        setError(err instanceof Error ? err.message : "Browser stream mode update failed");
        return;
      }
      setStreamMode(nextMode);
      setCaptureNotice(`Using ${streamModeOptions.find((option) => option.id === nextMode)?.label ?? nextMode} through the legacy frame fallback.`);
      if (!response) setStreamMode(previous);
    } finally {
      setPending(false);
    }
  }

  function applyPagePayload(next: BrowserPageListPayload) {
    setPages(next.pages);
    setActivePageId(next.activePageId);
    const active = next.pages.find((page) => page.pageId === next.activePageId);
    if (active?.url) setUrl(active.url);
  }

  async function activatePage(pageId: string) {
    if (!session || pageId === activePageId || pageId.startsWith("legacy:")) return;
    setPending(true);
    setError(null);
    try {
      applyPagePayload(await api.activateBrowserPage(pane.id, pageId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser tab failed to activate");
    } finally {
      setPending(false);
    }
  }

  async function createPage() {
    if (!session) return;
    setPending(true);
    setError(null);
    try {
      applyPagePayload(await api.createBrowserPage(pane.id, { activate: true }));
    } catch {
      setCaptureNotice("New tabs require the Browser Host v2 runtime.");
    } finally {
      setPending(false);
    }
  }

  async function closePage(pageId: string) {
    if (pages.length <= 1 || pageId.startsWith("legacy:")) return;
    setPending(true);
    try {
      applyPagePayload(await api.closeBrowserPage(pane.id, pageId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser tab failed to close");
    } finally {
      setPending(false);
    }
  }

  async function capture(kind: "SCREENSHOT" | "RECORDING", maxDurationMs = recordingDurationMs) {
    if (!session || pending || recordingActionPending || (kind === "RECORDING" && activeRecordingJob)) return;
    setPending(true);
    if (kind === "RECORDING") setRecordingActionPending(true);
    setCaptureNotice(null);
    try {
      const options =
        kind === "SCREENSHOT"
          ? { kind, format: "PNG" as const, target: "VIEWPORT" as const, selector: null, quality: null }
          : { kind, format: "WEBM" as const, maxDurationMs, maxBytes: 1024 * 1024 * 1024, frameIntervalMs: 100 };
      const next = await api.createBrowserCapture(pane.id, { options });
      setCaptureJobs((current) => [next.job, ...current.filter((job) => job.jobId !== next.job.jobId)].slice(0, 20));
      setCaptureNotice(`${kind === "SCREENSHOT" ? "Screenshot" : "Recording"} ${next.job.status.toLowerCase()}.`);
    } catch (err) {
      if (!isUnavailableV2Feature(err)) {
        setError(err instanceof Error ? err.message : "Browser capture failed");
        return;
      }
      try {
        const result = await api.browserAction(
          pane.id,
          kind === "SCREENSHOT"
            ? { type: "screenshot", sessionId: session.sessionId }
            : { type: "record", sessionId: session.sessionId, durationMs: maxDurationMs, intervalMs: 500, format: "webm" }
        );
        appendFrame(result.frame);
        setCaptureNotice(`${kind === "SCREENSHOT" ? "Screenshot" : "Recording"} captured with the legacy browser runtime.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Browser capture failed");
      }
    } finally {
      setPending(false);
      if (kind === "RECORDING") setRecordingActionPending(false);
    }
  }

  function replaceCaptureJob(nextJob: BrowserCaptureJobPayload) {
    setCaptureJobs((current) => [nextJob, ...current.filter((job) => job.jobId !== nextJob.jobId)].slice(0, 20));
  }

  async function stopRecording() {
    if (!activeRecordingJob || recordingActionPending) return;
    setRecordingActionPending(true);
    setCaptureNotice(null);
    try {
      const next = await api.stopBrowserCapture(pane.id, activeRecordingJob.jobId);
      replaceCaptureJob(next.job);
      setCaptureNotice(`Recording ${next.job.status.toLowerCase()} and saved.`);
      if (next.job.artifactIds.length > 0) await loadArtifacts();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser recording could not be stopped");
    } finally {
      setRecordingActionPending(false);
    }
  }

  async function cancelRecording() {
    if (!activeRecordingJob || recordingActionPending) return;
    setRecordingActionPending(true);
    setCaptureNotice(null);
    try {
      const next = await api.cancelBrowserCapture(pane.id, activeRecordingJob.jobId);
      replaceCaptureJob(next.job);
      setCaptureNotice("Recording cancelled and discarded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser recording could not be cancelled");
    } finally {
      setRecordingActionPending(false);
    }
  }

  async function loadDiagnostics() {
    if (!session || diagnosticsPending) return;
    setDiagnosticsPending(true);
    setError(null);
    try {
      setDiagnostics(await api.browserDiagnostics(pane.id, { includeNetwork: true, limit: 100 }));
    } catch {
      try {
        const result = await api.browserAction(pane.id, {
          type: "diagnostics",
          sessionId: session.sessionId,
          includeNetwork: true,
          limit: 100
        });
        setDiagnostics({
          sessionId: session.sessionId,
          events: result.text
            ? [{
                eventId: `legacy:${Date.now()}`,
                sessionId: session.sessionId,
                pageId: null,
                sequence: 0,
                type: "CONSOLE",
                level: "INFO",
                message: result.text,
                frameIndex: null,
                metadata: {},
                occurredAt: new Date().toISOString()
              }]
            : []
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Browser diagnostics failed");
      }
    } finally {
      setDiagnosticsPending(false);
    }
  }

  async function toggleDebug() {
    const next = !debugOpen;
    setDebugOpen(next);
    if (next) await Promise.all([loadDiagnostics(), loadArtifacts()]);
  }

  async function selectDebugTab(tab: BrowserDebugTab) {
    setDebugTab(tab);
    if (tab === "artifacts") await loadArtifacts();
  }

  async function toggleArtifactPin(artifact: Artifact) {
    const pinned = artifact.pinnedAt !== null;
    try {
      const updated = await api.updateArtifactRetention(
        artifact.id,
        pinned
          ? { pinnedAt: null, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() }
          : { pinnedAt: new Date().toISOString() }
      );
      setArtifacts((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser artifact retention update failed");
    }
  }

  function seekPersistedRecordingFrame(frameIndex: number) {
    const video = persistedRecordingVideoRef.current;
    if (!video || persistedFrameCount <= 0) return;
    if (!video.paused) video.pause();
    const boundedIndex = Math.min(persistedFrameCount - 1, Math.max(0, frameIndex));
    const persistedFrame = persistedTimeline?.frames[boundedIndex];
    if (persistedFrame) {
      video.currentTime = persistedFrame.elapsedMs / 1000;
    } else if (recordingManifest && Number.isFinite(recordingManifest.fps) && recordingManifest.fps > 0) {
      video.currentTime = boundedIndex / recordingManifest.fps;
    }
    setPersistedRecordingFrame(boundedIndex);
  }

  function stepPersistedRecording(direction: -1 | 1) {
    seekPersistedRecordingFrame(persistedRecordingFrame + direction);
  }

  async function toggleFocusMode() {
    if (focusMode) {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
      setFocusMode(false);
      return;
    }
    setFocusMode(true);
    if (paneRef.current?.requestFullscreen) {
      try {
        await paneRef.current.requestFullscreen();
      } catch {
        // CSS focus mode remains available when the browser blocks fullscreen.
      }
    }
  }

  async function reconnect() {
    setPending(true);
    setError(null);
    try {
      applyResponse(await api.startBrowserSession(pane.id, { viewport, targetUrl: url, ownerAgentId: `agent:${agentNumber}` }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser reconnect failed");
    } finally {
      setPending(false);
    }
  }

  async function refreshFrame() {
    if (!session) return;
    setPending(true);
    setError(null);
    try {
      appendFrame(await api.browserFrame(pane.id, session.sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser refresh failed");
    } finally {
      setPending(false);
    }
  }

  async function loadBookmarks() {
    if (!session) {
      setError("Start a browser session before using bookmarks.");
      return;
    }
    setBookmarksPending(true);
    setError(null);
    setBookmarkNotice(null);
    try {
      const next = await api.browserBookmarks(pane.id);
      setBookmarks(next.bookmarks);
      setBookmarksLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser bookmarks failed to load");
    } finally {
      setBookmarksPending(false);
    }
  }

  async function toggleBookmarks() {
    const nextOpen = !bookmarksOpen;
    setBookmarksOpen(nextOpen);
    if (nextOpen && (!bookmarksLoaded || session)) {
      await loadBookmarks();
    }
  }

  async function openBookmarks() {
    if (!session) {
      setError("Start a browser session before using bookmarks.");
      return;
    }
    scrollPaneIntoView(paneRef.current);
    setBookmarksOpen(true);
    if (!bookmarksLoaded) await loadBookmarks();
  }

  async function openBookmarkImport() {
    if (!session) {
      setError("Start a browser session before importing bookmarks.");
      return;
    }
    scrollPaneIntoView(paneRef.current);
    setBookmarksOpen(true);
    if (!bookmarksLoaded) await loadBookmarks();
    bookmarkImportRef.current?.click();
  }

  async function acquireControlForInput(): Promise<BrowserControlLeasePayload | null> {
    if (!session) return null;
    if (controlLeaseRef.current?.status === "ACTIVE") return controlLeaseRef.current;
    if (controlAcquirePromiseRef.current) return controlAcquirePromiseRef.current;
    const acquisition = api.acquireBrowserControl(pane.id, {
      holderType: "OPERATOR",
      holderId: "space-user",
      reason: "Direct browser interaction",
      ttlSeconds: 60
    }).then((next) => {
      legacyControlRef.current = false;
      controlLeaseRef.current = next.lease;
      setControlLease(next.lease);
      setHandoff(true);
      return next.lease;
    }).catch((err: unknown) => {
      if (isUnavailableV2Feature(err)) {
        legacyControlRef.current = true;
        setHandoff(true);
        return null;
      }
      legacyControlRef.current = false;
      setError(err instanceof Error ? err.message : "Browser control could not be acquired");
      return null;
    }).finally(() => {
      controlAcquirePromiseRef.current = null;
    });
    controlAcquirePromiseRef.current = acquisition;
    return acquisition;
  }

  async function joinSession() {
    if (!session) {
      setError("Start a browser session before joining.");
      return;
    }
    scrollPaneIntoView(paneRef.current);
    setPending(true);
    setError(null);
    const lease = await acquireControlForInput();
    if (!lease && !legacyControlRef.current) {
      setPending(false);
      return;
    }
    setHandoff(true);
    setTextInputOpen(true);
    setPending(false);
    window.setTimeout(() => handoffInputRef.current?.focus(), 0);
  }

  async function releaseControl() {
    discardCoalescedBrowserInput();
    if (controlLease) {
      setPending(true);
      try {
        const next = await api.releaseBrowserControl(pane.id, { leaseId: controlLease.leaseId });
        setControlLease(next.lease);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Browser control release failed");
        setPending(false);
        return;
      }
      setPending(false);
    }
    controlLeaseRef.current = null;
    legacyControlRef.current = false;
    setControlLease(null);
    setHandoff(false);
    setTextInputOpen(false);
  }

  async function saveBookmark() {
    if (!session || bookmarksPending) return;
    setBookmarksPending(true);
    setError(null);
    setBookmarkNotice(null);
    try {
      const next = await api.addBrowserBookmark(pane.id);
      setBookmarks(next.bookmarks);
      setBookmarksLoaded(true);
      setBookmarksOpen(true);
      setBookmarkNotice("Saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser bookmark failed to save");
    } finally {
      setBookmarksPending(false);
    }
  }

  async function importBookmarks(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!session || !file || bookmarksPending) return;
    setBookmarksPending(true);
    setError(null);
    setBookmarkNotice(null);
    try {
      const next = await api.importBrowserBookmarks(pane.id, file);
      setBookmarks(next.bookmarks);
      setBookmarksLoaded(true);
      setBookmarksOpen(true);
      setBookmarkNotice(`Imported ${next.importedCount}; skipped ${next.skippedCount}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser bookmark import failed");
    } finally {
      setBookmarksPending(false);
    }
  }

  async function openBookmark(bookmark: BrowserBookmark) {
    if (!session || bookmarksPending) return;
    setBookmarksPending(true);
    setError(null);
    try {
      applyResponse(await api.openBrowserBookmark(pane.id, bookmark.id));
      setBookmarksOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser bookmark failed to open");
    } finally {
      setBookmarksPending(false);
    }
  }

  async function stopSession() {
    setPending(true);
    setError(null);
    try {
      await api.stopBrowserSession(pane.id);
      setResponse(null);
      setFrame(null);
      setPages([]);
      setActivePageId(null);
      browserStreamSocketRef.current = null;
      discardCoalescedBrowserInput();
      clearPendingBrowserInputAcks();
      controlLeaseRef.current = null;
      legacyControlRef.current = false;
      setControlLease(null);
      setHandoff(false);
      setTextInputOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser stop failed");
    } finally {
      setPending(false);
    }
  }

  async function sendCanvasInput(input: BrowserCanvasInput) {
    if (!session) return;
    const lease = await acquireControlForInput();
    if (lease) {
      const payload = { ...input, leaseId: lease.leaseId } as BrowserInputPayload;
      if (sendRealtimeBrowserInput(payload)) return;
      try {
        const result = await api.browserInput(pane.id, payload);
        appendFrame(result.frame);
        return;
      } catch (err) {
        if (!isUnavailableV2Feature(err)) {
          setError(err instanceof Error ? err.message : "Browser input failed");
          return;
        }
        legacyControlRef.current = true;
      }
    }
    if (!legacyControlRef.current) return;
    if (input.type === "POINTER" && input.eventType === "mousePressed") {
      legacyPointerDownRef.current = { x: input.x, y: input.y, button: input.button };
      return;
    }
    if (input.type === "POINTER" && input.eventType === "mouseReleased") {
      const pressed = legacyPointerDownRef.current;
      legacyPointerDownRef.current = null;
      if (!pressed || pressed.button !== "left" || input.button !== "left") return;
      appendFrame((await api.browserAction(pane.id, { type: "click", x: input.x, y: input.y, sessionId: session.sessionId })).frame);
      return;
    }
    if (input.type === "POINTER" && input.eventType === "mouseWheel") {
      appendFrame((await api.browserAction(pane.id, {
        type: "scroll",
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
        sessionId: session.sessionId
      })).frame);
      return;
    }
    if (input.type === "TOUCH" && input.eventType !== "touchEnd" && input.touchPoints[0]) {
      legacyPointerDownRef.current = { x: input.touchPoints[0].x, y: input.touchPoints[0].y, button: "left" };
      return;
    }
    if (input.type === "TOUCH" && input.eventType === "touchEnd") {
      const pressed = legacyPointerDownRef.current;
      legacyPointerDownRef.current = null;
      if (pressed) appendFrame((await api.browserAction(pane.id, { type: "click", x: pressed.x, y: pressed.y, sessionId: session.sessionId })).frame);
      return;
    }
    if (input.type === "KEY" && input.eventType === "keyDown" && input.text) {
      appendFrame((await api.browserAction(pane.id, { type: "type", text: input.text, sessionId: session.sessionId })).frame);
    }
  }

  async function sendText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !textInput.trim()) return;
    const text = textInput;
    setTextInput("");
    const lease = await acquireControlForInput();
    if (lease) {
      const payload: BrowserInputPayload = {
        type: "KEY",
        eventType: "char",
        key: text.length === 1 ? text : "Unidentified",
        text,
        leaseId: lease.leaseId
      };
      if (sendRealtimeBrowserInput(payload)) return;
      try {
        const result = await api.browserInput(pane.id, payload);
        appendFrame(result.frame);
        return;
      } catch (err) {
        if (!isUnavailableV2Feature(err)) {
          setError(err instanceof Error ? err.message : "Browser text input failed");
          return;
        }
        legacyControlRef.current = true;
      }
    }
    if (!legacyControlRef.current) return;
    const result = await api.browserAction(pane.id, { type: "type", text, sessionId: session.sessionId });
    appendFrame(result.frame);
  }

  useEffect(() => {
    function handleBrowserPaneAction(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const detail = parseBrowserPaneActionDetail(event.detail);
      if (!detail || detail.paneId !== pane.id) return;
      if (detail.action === "bookmarks") {
        void openBookmarks();
        return;
      }
      if (detail.action === "import") {
        void openBookmarkImport();
        return;
      }
      if (detail.action === "handoff") {
        joinSession();
      }
    }
    window.addEventListener(BROWSER_PANE_ACTION_EVENT, handleBrowserPaneAction);
    const unregisterTarget = registerBrowserPaneEventTarget(pane.id);
    return () => {
      unregisterTarget();
      window.removeEventListener(BROWSER_PANE_ACTION_EVENT, handleBrowserPaneAction);
    };
  });

  const browserToolbarActions = useMemo<IconToolbarAction[]>(
    () => [
      {
        id: "bookmarks",
        label: "Browser bookmarks",
        title: session ? "Browser bookmarks" : "Start a browser session before using bookmarks.",
        ariaLabel: `Browser bookmarks ${pane.title}`,
        icon: Bookmark,
        onClick: () => void toggleBookmarks(),
        disabled: !session || pending,
        ariaExpanded: bookmarksOpen,
        className: bookmarksOpen ? "selected" : ""
      },
      {
        id: "refresh",
        label: "Refresh browser frame",
        title: "Refresh browser frame",
        ariaLabel: `Refresh browser frame ${pane.title}`,
        icon: RefreshCw,
        onClick: () => void refreshFrame(),
        disabled: !session || pending
      },
      {
        id: "reconnect",
        label: "Reconnect browser",
        title: "Reconnect browser",
        ariaLabel: `Reconnect browser ${pane.title}`,
        icon: RotateCw,
        onClick: () => void reconnect(),
        disabled: !status?.enabled || pending
      },
      {
        id: "type-text",
        label: "Type text",
        title: "Type text into browser",
        ariaLabel: `Type text into browser ${pane.title}`,
        icon: Keyboard,
        onClick: () => void joinSession(),
        disabled: !session || pending,
        ariaExpanded: textInputOpen,
        className: textInputOpen ? "selected" : ""
      },
      {
        id: "screenshot",
        label: "Capture screenshot",
        title: "Capture browser screenshot",
        ariaLabel: `Capture browser screenshot ${pane.title}`,
        icon: Camera,
        onClick: () => void capture("SCREENSHOT"),
        disabled: !session || pending
      },
      {
        id: "record",
        label: recording ? "Recording" : "Record browser",
        title: "Record browser session",
        ariaLabel: `Record browser session ${pane.title}`,
        icon: Video,
        onClick: () => setRecordingControlsOpen((current) => recording ? true : !current),
        disabled: !session || pending || recordingActionPending,
        ariaExpanded: recordingControlsOpen,
        ariaPressed: recording,
        className: `${recording ? "recording" : ""}${recordingControlsOpen ? " selected" : ""}`.trim()
      },
      {
        id: "debug",
        label: "Browser debugger",
        title: "Open browser debugger",
        ariaLabel: `Open browser debugger ${pane.title}`,
        icon: Bug,
        onClick: () => void toggleDebug(),
        disabled: !session,
        ariaExpanded: debugOpen,
        className: debugOpen ? "selected" : ""
      },
      {
        id: "stop",
        label: "Stop browser session",
        title: "Stop browser session",
        ariaLabel: `Stop browser session ${pane.title}`,
        icon: CircleStop,
        onClick: () => void stopSession(),
        disabled: !session || pending
      }
    ],
    [bookmarksOpen, debugOpen, pane.title, pending, recording, recordingActionPending, recordingControlsOpen, session, status?.enabled, textInputOpen]
  );
  const browserToolbar = usePersistentIconToolbar({
    actions: browserToolbarActions,
    hiddenStorageKey: BROWSER_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY,
    orderStorageKey: BROWSER_TOOLBAR_ACTION_ORDER_STORAGE_KEY
  });
  useDismissibleToolbarLayer({
    containerRef: browserToolbarRef,
    active: bookmarksOpen || recordingControlsOpen || textInputOpen || browserToolbar.isOverflowOpen || Boolean(browserToolbar.actionMenu),
    onDismiss: () => {
      setBookmarksOpen(false);
      setRecordingControlsOpen(Boolean(activeRecordingJob));
      setTextInputOpen(false);
      browserToolbar.closeMenus();
    }
  });
  const consoleEvents = diagnostics.events.filter((entry) => entry.type === "CONSOLE" || entry.type === "ERROR");
  const networkEvents = diagnostics.events.filter((entry) => entry.type === "NETWORK");

  return (
    <section
      ref={paneRef}
      className={`browser-pane${focusMode ? " browser-pane-focus" : ""}${debugOpen ? " debugger-open" : ""}`}
      aria-label={`${pane.title} browser session`}
      data-browser-agent={agentNumber}
    >
      <div className="browser-tab-strip" role="tablist" aria-label={`Browser tabs ${pane.title}`}>
        <div className="browser-tab-scroll">
          {pages.map((page) => {
            const selected = page.pageId === activePageId || page.isActive;
            return (
              <div key={page.pageId} className={`browser-tab${selected ? " selected" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={page.title ?? page.url ?? "Browser tab"}
                  title={page.url ?? page.title ?? "Browser tab"}
                  onClick={() => void activatePage(page.pageId)}
                >
                  <Globe2 aria-hidden="true" />
                  <span>{page.title ?? page.url ?? "New tab"}</span>
                </button>
                {pages.length > 1 ? (
                  <button
                    type="button"
                    className="browser-tab-close"
                    aria-label={`Close browser tab ${page.title ?? page.url ?? "tab"}`}
                    title="Close tab"
                    onClick={() => void closePage(page.pageId)}
                  >
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        <button type="button" className="browser-new-tab" aria-label={`New browser tab ${pane.title}`} title="New tab" onClick={() => void createPage()} disabled={!session || pending}>
          <Plus aria-hidden="true" />
        </button>
      </div>
      <div className="browser-pane-toolbar">
        <form onSubmit={navigate} className="browser-url-form">
          <Globe2 aria-hidden="true" />
          <input name="browser-url" value={url} onChange={(event) => setUrl(event.target.value)} aria-label={`Browser URL ${pane.title}`} disabled={!canUseSession || pending} />
          <button type="submit" title="Navigate browser" aria-label={`Navigate browser ${pane.title}`} disabled={!canUseSession || pending || !url.trim()}>
            <Send aria-hidden="true" />
          </button>
        </form>
        <div className="browser-compact-controls">
          <label className="browser-stream-select">
            <span
              className={`browser-runtime-indicator ${pending ? "working" : session?.status.toLowerCase() ?? (status?.enabled ? "ready" : "disabled")}`}
              role="status"
              aria-label={`${pending ? "Working" : session?.status ?? (status?.enabled ? "Ready" : "Disabled")}: ${statusText}`}
              title={statusText}
            />
            <select
              name="browser-stream-mode"
              value={streamMode}
              onChange={(event) => void setStream(event.target.value as BrowserStreamMode)}
              aria-label={`Stream mode ${pane.title}`}
              disabled={!session || pending}
            >
              {streamModeOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <div className="browser-viewport-control" role="group" aria-label={`Browser viewport ${pane.title}`}>
            {viewportOptions.map(({ id, label, title, Icon }) => (
              <button
                key={id}
                type="button"
                className={viewport === id ? "selected" : ""}
                title={title}
                aria-label={`${label} view ${pane.title}`}
                aria-pressed={viewport === id}
                onClick={() => void setViewport(id)}
                disabled={!canUseSession || pending}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`browser-control-toggle${handoff ? " selected" : ""}`}
            title={handoff ? "Release browser control" : "Join browser session"}
            aria-label={`${handoff ? "Release browser control" : "Join browser session"} ${pane.title}`}
            aria-pressed={handoff}
            onClick={() => void (handoff ? releaseControl() : joinSession())}
            disabled={!session || pending}
          >
            {pending ? <Loader2 aria-hidden="true" /> : <UserCheck aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={`browser-focus-toggle${focusMode ? " selected" : ""}`}
            title={focusMode ? "Exit browser focus mode" : "Expand browser view"}
            aria-label={`${focusMode ? "Exit browser focus mode" : "Expand browser view"} ${pane.title}`}
            aria-pressed={focusMode}
            onClick={() => void toggleFocusMode()}
            disabled={!session}
          >
            {focusMode ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button>
          <div ref={browserToolbarRef} className="browser-pane-actions" aria-label={`Browser toolbar actions ${pane.title}`}>
            <div className="pane-actions-overflow browser-toolbar-overflow">
            <button
              type="button"
              title={`More browser actions ${pane.title}`}
              aria-label={`More browser actions ${pane.title}`}
              aria-expanded={browserToolbar.isOverflowOpen}
              onClick={() => {
                setBookmarksOpen(false);
                if (!activeRecordingJob) setRecordingControlsOpen(false);
                setTextInputOpen(false);
                browserToolbar.setActionMenu(null);
                browserToolbar.setIsOverflowOpen((current) => !current);
              }}
              {...browserToolbar.overflowDropProps}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
            {browserToolbar.isOverflowOpen ? (
              <div className="icon-overflow-menu browser-tools-menu" role="menu" aria-label={`Browser actions ${pane.title}`}>
                {browserToolbar.visibleActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      aria-label={action.ariaLabel}
                      aria-expanded={action.ariaExpanded}
                      aria-pressed={action.ariaPressed}
                      disabled={action.disabled}
                      onClick={() => {
                        browserToolbar.setIsOverflowOpen(false);
                        if (action.id !== "bookmarks") setBookmarksOpen(false);
                        if (action.id !== "record" && !activeRecordingJob) setRecordingControlsOpen(false);
                        if (action.id !== "type-text") setTextInputOpen(false);
                        action.onClick();
                      }}
                      onContextMenu={(event) => {
                        if (action.hideable === false) return;
                        event.preventDefault();
                        browserToolbar.closeMenus();
                        browserToolbar.setActionMenu({
                          actionId: action.id,
                          actionLabel: action.ariaLabel,
                          x: event.clientX,
                          y: event.clientY
                        });
                      }}
                      {...browserToolbar.getDragHandleProps(action)}
                    >
                      <Icon aria-hidden="true" />
                      <span>{action.label}</span>
                    </button>
                  );
                })}
                {browserToolbar.hiddenActions.length ? (
                  <>
                    <span className="browser-tools-menu-label" role="presentation">Hidden tools</span>
                    {browserToolbar.hiddenActions.map((action) => {
                      const Icon = action.icon;
                      return (
                        <button
                          key={action.id}
                          type="button"
                          role="menuitem"
                          className="browser-tool-hidden"
                          aria-label={action.ariaLabel}
                          disabled={action.disabled}
                          onClick={() => {
                            browserToolbar.setIsOverflowOpen(false);
                            action.onClick();
                          }}
                        >
                          <Icon aria-hidden="true" />
                          <span>{action.label}</span>
                        </button>
                      );
                    })}
                    <button type="button" role="menuitem" onClick={browserToolbar.restoreHiddenActions}>
                      <span>Show all icons</span>
                    </button>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          {bookmarksOpen ? (
            <div className="browser-bookmark-popover toolbar-floating-menu" role="menu" aria-label={`Saved browser bookmarks ${pane.title}`}>
              <button
                type="button"
                className="browser-bookmark-command"
                title="Save current browser page"
                aria-label={`Save current browser page ${pane.title}`}
                onClick={() => void saveBookmark()}
                disabled={!session || bookmarksPending}
                role="menuitem"
              >
                <BookmarkPlus aria-hidden="true" />
                <span>Save page</span>
              </button>
              <button
                type="button"
                className="browser-bookmark-command"
                title="Import Chrome bookmarks JSON"
                aria-label={`Import browser bookmarks ${pane.title}`}
                onClick={() => bookmarkImportRef.current?.click()}
                disabled={!session || bookmarksPending}
                role="menuitem"
              >
                <Upload aria-hidden="true" />
                <span>Import JSON</span>
              </button>
              <a
                className="browser-bookmark-command"
                href={api.browserBookmarksExportUrl(pane.id)}
                download
                role="menuitem"
                aria-label={`Export browser bookmarks ${pane.title}`}
                title="Export managed bookmarks JSON"
              >
                <Download aria-hidden="true" />
                <span>Export JSON</span>
              </a>
              <input
                ref={bookmarkImportRef}
                className="sr-only"
                type="file"
                name={`browser-bookmarks-${pane.id}`}
                accept="application/json,.json"
                aria-label={`Browser bookmark import file ${pane.title}`}
                onChange={(event) => void importBookmarks(event)}
              />
              <div className="browser-bookmark-list" role="none">
                {bookmarksPending ? <span role="status">Loading...</span> : null}
                {!bookmarksPending && bookmarkNotice ? <span role="status">{bookmarkNotice}</span> : null}
                {!bookmarksPending && bookmarks.length === 0 ? <span role="status">No bookmarks</span> : null}
                {bookmarks.map((bookmark) => (
                  <button key={bookmark.id} type="button" role="menuitem" aria-label={`Open bookmark ${bookmark.title}`} onClick={() => void openBookmark(bookmark)} disabled={bookmarksPending}>
                    <Bookmark aria-hidden="true" />
                    <span>{bookmark.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {textInputOpen ? (
            <form className="browser-text-popover toolbar-floating-menu" onSubmit={sendText} aria-label={`Browser text controls ${pane.title}`}>
              <input
                ref={handoffInputRef}
                value={textInput}
                onChange={(event) => setTextInput(event.target.value)}
                aria-label={`Browser text input ${pane.title}`}
                placeholder="Type into page"
                disabled={!handoff || !session}
              />
              <button
                type="submit"
                title="Type into browser"
                aria-label={`Type into browser ${pane.title}`}
                disabled={!handoff || !session || !textInput}
              >
                <Send aria-hidden="true" />
              </button>
            </form>
          ) : null}
          {recordingControlsOpen ? (
            <div
              className="browser-recording-popover toolbar-floating-menu"
              role="dialog"
              aria-label={`Browser recording controls ${pane.title}`}
            >
              <div className="browser-recording-heading">
                <strong>Record browser</strong>
                <button
                  type="button"
                  aria-label={`Close browser recording controls ${pane.title}`}
                  title={activeRecordingJob ? "Stop or cancel the active recording first" : "Close recording controls"}
                  disabled={Boolean(activeRecordingJob)}
                  onClick={() => setRecordingControlsOpen(false)}
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <div className="browser-recording-durations" aria-label="Recording duration">
                {recordingDurationOptions.map((option) => (
                  <button
                    key={option.milliseconds}
                    type="button"
                    aria-label={`${option.label} recording duration`}
                    aria-pressed={recordingDurationMs === option.milliseconds}
                    disabled={Boolean(activeRecordingJob) || recordingActionPending}
                    onClick={() => setRecordingDurationMs(option.milliseconds)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {activeRecordingJob ? (
                <div className="browser-recording-progress">
                  <div>
                    <span>{activeRecordingJob.status === "QUEUED" ? "Queued" : "Recording"}</span>
                    <span>{activeRecordingJob.progressPercent}%</span>
                  </div>
                  <progress
                    aria-label="Browser recording progress"
                    aria-valuenow={Math.min(100, Math.max(0, activeRecordingJob.progressPercent))}
                    max={100}
                    value={Math.min(100, Math.max(0, activeRecordingJob.progressPercent))}
                  />
                </div>
              ) : null}
              <div className="browser-recording-actions">
                {activeRecordingJob ? (
                  <>
                    <button
                      type="button"
                      className="browser-recording-stop"
                      aria-label={`Stop and save browser recording ${pane.title}`}
                      disabled={recordingActionPending}
                      onClick={() => void stopRecording()}
                    >
                      <Square aria-hidden="true" />
                      <span>Stop & save</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Cancel browser recording ${pane.title}`}
                      disabled={recordingActionPending}
                      onClick={() => void cancelRecording()}
                    >
                      <Trash2 aria-hidden="true" />
                      <span>Discard</span>
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="browser-recording-start"
                    aria-label={`Start browser recording ${pane.title}`}
                    disabled={recordingActionPending || pending}
                    onClick={() => void capture("RECORDING", recordingDurationMs)}
                  >
                    {recordingActionPending ? <Loader2 aria-hidden="true" /> : <Play aria-hidden="true" />}
                    <span>Start recording</span>
                  </button>
                )}
              </div>
            </div>
          ) : null}
          {browserToolbar.actionMenu ? (
            <div
              className="icon-context-menu"
              role="menu"
              aria-label={`Action menu ${browserToolbar.actionMenu.actionLabel}`}
              style={{ left: `${browserToolbar.actionMenu.x}px`, top: `${browserToolbar.actionMenu.y}px` }}
            >
              <button type="button" role="menuitem" onClick={() => browserToolbar.hideAction(browserToolbar.actionMenu!.actionId)}>
                Hide
              </button>
            </div>
          ) : null}
        </div>
      </div>
      </div>

      <div className={`browser-workspace${debugOpen ? " with-debugger" : ""}`}>
        <div className="browser-frame-shell">
          <BrowserCanvas
            ref={canvasRef}
            ariaLabel={`${pane.title} browser frame`}
            viewportSize={viewportSizes[viewport]}
            interactive={Boolean(session)}
            source={activeFrame?.screenshotDataUrl}
            capturedAt={activeFrame?.capturedAt}
            onInput={(input) => void sendCanvasInput(input)}
          />
          {!activeFrame?.screenshotDataUrl ? (
            <div className="browser-frame-empty" role="status">
              {pending ? <Loader2 aria-hidden="true" /> : <MousePointer2 aria-hidden="true" />}
            </div>
          ) : null}
          {selectedFrameIndex !== null ? <span className="browser-frame-paused">Frame {selectedFrameIndex + 1} / {canvasHistoryLength}</span> : null}
        </div>

        {debugOpen ? (
          <aside className="browser-debug-drawer" aria-label={`Browser debugger ${pane.title}`}>
            <div className="browser-debug-tabs" role="tablist" aria-label="Browser debug views">
              {(["console", "network", "timeline", "artifacts"] as BrowserDebugTab[]).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={debugTab === tab}
                  onClick={() => void selectDebugTab(tab)}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
              <button type="button" className="browser-debug-close" aria-label="Close browser debugger" title="Close debugger" onClick={() => setDebugOpen(false)}>
                <X aria-hidden="true" />
              </button>
            </div>
            <div className="browser-debug-body">
              {diagnosticsPending ? <span role="status">Loading diagnostics...</span> : null}
              {!diagnosticsPending && debugTab === "console" ? (
                consoleEvents.length ? consoleEvents.map((entry) => (
                  <div key={entry.eventId} className={`browser-debug-entry ${entry.level.toLowerCase()}`}>
                    <span>{entry.level}</span><p>{entry.message}</p><time>{new Date(entry.occurredAt).toLocaleTimeString()}</time>
                  </div>
                )) : <span>No console events</span>
              ) : null}
              {!diagnosticsPending && debugTab === "network" ? (
                networkEvents.length ? networkEvents.map((entry) => (
                  <div key={entry.eventId} className="browser-debug-entry network">
                    <span>{metadataText(entry.metadata, "method")}</span><strong>{metadataText(entry.metadata, "status")}</strong><p title={metadataText(entry.metadata, "url")}>{metadataText(entry.metadata, "url", entry.message)}</p>
                  </div>
                )) : <span>No network events</span>
              ) : null}
              {!diagnosticsPending && debugTab === "timeline" ? (
                <>
                  <div className="browser-frame-controls">
                    <button
                      type="button"
                      aria-label="Previous browser frame"
                      title="Previous frame"
                      disabled={canvasHistoryLength === 0 || selectedFrameIndex === 0}
                      onClick={() => setSelectedFrameIndex((current) => {
                        const next = current === null ? Math.max(0, canvasHistoryLength - 2) : Math.max(0, current - 1);
                        canvasRef.current?.showHistory(next);
                        return next;
                      })}
                    >
                      <ChevronLeft aria-hidden="true" />
                    </button>
                    <input
                      type="range"
                      min="0"
                      max={Math.max(0, canvasHistoryLength - 1)}
                      value={selectedFrameIndex ?? Math.max(0, canvasHistoryLength - 1)}
                      aria-label="Browser frame timeline"
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setSelectedFrameIndex(next);
                        canvasRef.current?.showHistory(next);
                      }}
                      disabled={canvasHistoryLength < 2}
                    />
                    <button
                      type="button"
                      aria-label="Next browser frame"
                      title="Next frame"
                      disabled={selectedFrameIndex === null || selectedFrameIndex >= canvasHistoryLength - 1}
                      onClick={() => setSelectedFrameIndex((current) => {
                        const next = current === null || current >= canvasHistoryLength - 1 ? null : current + 1;
                        canvasRef.current?.showHistory(next);
                        return next;
                      })}
                    >
                      <ChevronRight aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => {
                      setSelectedFrameIndex(null);
                      canvasRef.current?.showHistory(null);
                    }} disabled={selectedFrameIndex === null}>Live</button>
                  </div>
                  {timelineEvents.length ? timelineEvents.map((entry) => (
                    <div key={entry.eventId} className="browser-debug-entry timeline">
                      <span>{entry.type}</span><p>{entry.message}</p><strong>{entry.frameIndex === null ? "" : `F${entry.frameIndex + 1}`}</strong><time>{new Date(entry.occurredAt).toLocaleTimeString()}</time>
                    </div>
                  )) : <span>No timeline events</span>}
                </>
              ) : null}
              {debugTab === "artifacts" ? (
                <>
                  {captureJobs.map((job) => (
                    <div key={job.jobId} className="browser-debug-entry artifact-job">
                      <span>{job.options.kind}</span><p>{job.statusReason ?? `${job.status} / ${job.progressPercent}%`}</p>
                      <span>{job.artifactIds.length} file{job.artifactIds.length === 1 ? "" : "s"}</span>
                    </div>
                  ))}
                  {persistedRecordings.length > 1 ? (
                    <div className="browser-recording-selector" aria-label="Persisted browser recordings">
                      {persistedRecordings.map((recordingItem) => (
                        <button
                          key={recordingItem.jobId}
                          type="button"
                          aria-pressed={selectedPersistedRecording?.jobId === recordingItem.jobId}
                          onClick={() => setSelectedRecordingJobId(recordingItem.jobId)}
                        >
                          {recordingItem.jobId}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {selectedPersistedRecording?.manifestArtifact && !recordingManifest && recordingManifestFailedId !== selectedPersistedRecording.manifestArtifact.id ? (
                    <span role="status">
                      {recordingManifestPendingId === selectedPersistedRecording.manifestArtifact.id
                        ? "Loading recording timeline..."
                        : "Recording timeline unavailable"}
                    </span>
                  ) : null}
                  {selectedPersistedRecording && (
                    !selectedPersistedRecording.manifestArtifact ||
                    recordingManifest ||
                    recordingManifestFailedId === selectedPersistedRecording.manifestArtifact.id
                  ) ? (
                    <section className="browser-persisted-recording" aria-label={`Recording ${selectedPersistedRecording.jobId}`}>
                      <video
                        key={selectedPersistedRecording.jobId}
                        ref={persistedRecordingVideoRef}
                        src={api.artifactFileUrl(selectedPersistedRecording.videoArtifact.id)}
                        controls
                        playsInline
                        preload="metadata"
                        aria-label={`Persisted browser recording ${selectedPersistedRecording.jobId}`}
                        onTimeUpdate={(event) => {
                          if (persistedTimeline?.frames.length) {
                            const currentMs = event.currentTarget.currentTime * 1000;
                            let nearest = 0;
                            let distance = Math.abs(persistedTimeline.frames[0]!.elapsedMs - currentMs);
                            for (let index = 1; index < persistedTimeline.frames.length; index += 1) {
                              const nextDistance = Math.abs(persistedTimeline.frames[index]!.elapsedMs - currentMs);
                              if (nextDistance < distance) {
                                nearest = index;
                                distance = nextDistance;
                              }
                            }
                            setPersistedRecordingFrame(nearest);
                          } else if (recordingManifest) {
                            setPersistedRecordingFrame(Math.min(
                              Math.max(0, recordingManifest.frameCount - 1),
                              Math.max(0, Math.round(event.currentTarget.currentTime * recordingManifest.fps))
                            ));
                          }
                        }}
                      />
                      <div className="browser-persisted-recording-controls">
                        <button
                          type="button"
                          aria-label="Previous persisted recording frame"
                          title="Previous frame"
                          disabled={persistedFrameCount <= 0 || persistedRecordingFrame <= 0}
                          onClick={() => stepPersistedRecording(-1)}
                        >
                          <ChevronLeft aria-hidden="true" />
                        </button>
                        <span>
                          Frame {persistedFrameCount > 0 ? Math.min(persistedFrameCount, persistedRecordingFrame + 1) : "-"}
                          {persistedFrameCount > 0 ? ` / ${persistedFrameCount}` : ""}
                        </span>
                        <button
                          type="button"
                          aria-label="Next persisted recording frame"
                          title="Next frame"
                          disabled={persistedFrameCount <= 0 || persistedRecordingFrame >= persistedFrameCount - 1}
                          onClick={() => stepPersistedRecording(1)}
                        >
                          <ChevronRight aria-hidden="true" />
                        </button>
                      </div>
                      <div className="browser-persisted-recording-timeline">
                        <input
                          type="range"
                          min="0"
                          max={Math.max(0, persistedFrameCount - 1)}
                          value={Math.min(Math.max(0, persistedFrameCount - 1), persistedRecordingFrame)}
                          aria-label="Persisted recording timeline"
                          disabled={persistedFrameCount < 2}
                          onChange={(event) => seekPersistedRecordingFrame(Number(event.target.value))}
                        />
                        <small>
                          {recordingTimelinePending
                            ? "Loading segments..."
                            : persistedSegments.length > 0
                              ? `${persistedSegments.filter((segment) => segment.status === "FINALIZED").length}/${persistedSegments.length} segments ready`
                              : "Segment timeline unavailable"}
                        </small>
                      </div>
                    </section>
                  ) : null}
                  {artifactsPending ? <span role="status">Loading browser artifacts...</span> : null}
                  {!artifactsPending && artifacts.map((artifact) => (
                    <div key={artifact.id} className="browser-debug-entry artifact">
                      <span>{artifact.kind}</span>
                      <p>
                        <a href={api.artifactFileUrl(artifact.id)} target="_blank" rel="noreferrer" title="Open browser artifact">
                          {typeof artifact.metadata.artifactFile === "string" ? artifact.metadata.artifactFile : artifact.id}
                        </a>
                        <small>{artifact.pinnedAt ? "Pinned" : artifact.expiresAt ? `Expires ${new Date(artifact.expiresAt).toLocaleString()}` : "No expiry"}</small>
                      </p>
                      <button
                        type="button"
                        aria-label={`${artifact.pinnedAt ? "Unpin" : "Pin"} browser artifact ${artifact.id}`}
                        aria-pressed={Boolean(artifact.pinnedAt)}
                        title={artifact.pinnedAt ? "Unpin artifact" : "Pin artifact"}
                        onClick={() => void toggleArtifactPin(artifact)}
                      >
                        {artifact.pinnedAt ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                      </button>
                    </div>
                  ))}
                  {!artifactsPending && captureJobs.length === 0 && artifacts.length === 0 ? <span>No browser artifacts</span> : null}
                </>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>

      {captureNotice ? <div className="browser-pane-notice" role="status">{captureNotice}</div> : null}
      {error ? <div className="browser-pane-error" role="alert">{error}</div> : null}
    </section>
  );
}
