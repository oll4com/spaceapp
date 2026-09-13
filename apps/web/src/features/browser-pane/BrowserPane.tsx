import { useGoogleAccountSignIn } from "./useGoogleAccountSignIn.js";
import { useBrowserAudio } from "./useBrowserAudio.js";
import { resolveBrowserAddress } from "./browser-address.js";
import type { YouTubeAccounts as GoogleAccounts } from "./youtube-accounts.js";
import {
  Bookmark,
  BookmarkPlus,
  Bug,
  Camera,
  Check,
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
  RectangleHorizontal,
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
  Users,
  Video,
  X
} from "../ui-theme/app-icons.js";
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
import { browserGateway, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { useDismissibleToolbarLayer, usePersistentIconToolbar, type IconToolbarAction } from "../../icon-toolbar.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import {
  migrateModernToolbarPreference,
  modernPaneToolbarStorageKeys,
  type UiTheme
} from "../../ui-theme.js";
import { BrowserCanvas, type BrowserCanvasHandle, type BrowserCanvasInput } from "./BrowserCanvas.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import {
  BROWSER_PANE_ACTION_EVENT,
  parseBrowserPaneActionDetail,
  registerBrowserPaneEventTarget
} from "./events.js";
import { BrowserLiveStatus } from "./BrowserLiveStatus.js";
import { loadSharedBrowserStatus } from "./browser-status.js";

export {
  BROWSER_PANE_ACTION_EVENT,
  parseBrowserPaneActionDetail,
  type BrowserPaneAction,
  type BrowserPaneActionDetail
} from "./events.js";

interface BrowserPaneProps {
  pane: Pane;
  agentNumber: number;
  observerOnly?: boolean;
  uiTheme?: UiTheme;
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

type BrowserDebugTab = "console" | "network" | "timeline" | "artifacts" | "agents";
type BrowserSessionV2 = PaneBrowserSessionResponse["session"];

const streamModeOptions: Array<{ id: BrowserStreamMode; label: string }> = [
  { id: "AUTO", label: "Auto" },
  { id: "SILENT", label: "Silent" },
  { id: "PREVIEW", label: "Preview" },
  { id: "INTERACTIVE", label: "Interactive" },
  { id: "REALTIME", label: "Live" }
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
  { id: "mobile", label: "Mobile", title: "Mobile view", Icon: Smartphone },
  { id: "wide", label: "Wide", title: "Widescreen view", Icon: RectangleHorizontal }
];

const viewportSizes: Record<BrowserSessionViewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  mobile: { width: 390, height: 844 },
  wide: { width: 1280, height: 720 }
};

const browserInputAckTimeoutMs = 2_000;
const browserStreamReconnectMessage = "Browser frame stream disconnected; reconnecting.";

interface PendingBrowserInputAck {
  motion: boolean;
  sentAt: number;
  timeoutId: number;
}

function displayUrl(response: PaneBrowserSessionResponse | null): string {
  const value = response?.session.currentUrl ?? response?.session.targetUrl ?? "";
  return value === "about:blank" ? "" : value;
}

function isBrowserFrameMessage(value: unknown): value is BrowserFrameMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

function scrollPaneIntoView(element: HTMLElement | null) {
  if (typeof element?.scrollIntoView !== "function") return;
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function BrowserPane({ pane, agentNumber, observerOnly = false, uiTheme = "classic" }: BrowserPaneProps) {
  const [status, setStatus] = useState<BrowserStatusPayload | null>(null);
  const [response, setResponse] = useState<PaneBrowserSessionResponse | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [url, setUrl] = useState("");
  const [handoff, setHandoff] = useState(false);
  const [googleAccounts, setGoogleAccounts] = useState<GoogleAccounts | null>(null);
  const [googleAccountMenuOpen, setGoogleAccountMenuOpen] = useState(false);
  const googleAccountPickerRef = useRef<HTMLDivElement | null>(null);
  const googleAccountButtonRef = useRef<HTMLButtonElement | null>(null);
  const [googleSignInTarget, setGoogleSignInTarget] = useState<string | null>(null);
  const [controlLease, setControlLease] = useState<BrowserControlLeasePayload | null>(null);
  const [streamMode, setStreamMode] = useState<BrowserStreamMode>("AUTO");
  const [blankTabRequested, setBlankTabRequested] = useState(false);
  const [pages, setPages] = useState<BrowserPageSummaryPayload[]>([]);
  const emptyBrowser = !blankTabRequested && pages.length === 1 && pages[0]?.url === "about:blank";
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const pageListRef = useRef<BrowserPageListPayload | null>(null);
  const pageSessionIdRef = useRef<string | null>(null);
  const pageRequestRef = useRef(0);
  const pageMutationRef = useRef(false);
  const [canvasHistoryLength, setCanvasHistoryLength] = useState(0);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState<number | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugTab, setDebugTab] = useState<BrowserDebugTab>("console");
  const [diagnostics, setDiagnostics] = useState<BrowserDiagnosticsPayload>(emptyDiagnostics);
  const [diagnosticsPending, setDiagnosticsPending] = useState(false);
  const [diagnosticsLive, setDiagnosticsLive] = useState(true);
  const [diagnosticsFilter, setDiagnosticsFilter] = useState("");
  const diagnosticsLoadingRef = useRef(false);
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
  // Start compact until the pane has been measured so its address stays usable
  // during the first paint in narrow rooms and after a page reload.
  const [toolbarWidth, setToolbarWidth] = useState(() => typeof ResizeObserver === "undefined" ? 1000 : 0);
  const [fitPane, setFitPane] = useState(false);
  const [streamDimensions, setStreamDimensions] = useState<{ width: number; height: number } | null>(null);
  const frameShellRef = useRef<HTMLDivElement | null>(null);
  const resizeBusyRef = useRef(false);
  const streamedViewportRef = useRef<{ width: number; height: number } | undefined>(undefined);
  const [textInput, setTextInput] = useState("");
  const [textInputOpen, setTextInputOpen] = useState(false);
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>([]);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarksLoaded, setBookmarksLoaded] = useState(false);
  const [bookmarksPending, setBookmarksPending] = useState(false);
  const [bookmarkNotice, setBookmarkNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAutoDismiss(error, setError);
  useAutoDismiss(captureNotice, setCaptureNotice);
  const canvasRef = useRef<BrowserCanvasHandle | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
  const urlDraftRef = useRef<string | null>(null);
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

  useEffect(() => {
    const paneElement = paneRef.current;
    if (!paneElement || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const bounds = paneElement.getBoundingClientRect();
      const toolbarBottom = paneElement.querySelector(".browser-pane-toolbar")?.getBoundingClientRect().bottom ?? bounds.top + 74;
      setToolbarWidth(Math.round(bounds.width));
      paneElement.style.setProperty("--browser-pane-width", `${bounds.width}px`);
      paneElement.style.setProperty("--browser-menu-height", `${Math.max(64, bounds.bottom - toolbarBottom - 10)}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(paneElement);
    const toolbarElement = paneElement.querySelector(".browser-pane-toolbar");
    if (toolbarElement) observer.observe(toolbarElement);
    measure();
    return () => observer.disconnect();
  }, []);
  const compactToolbar = toolbarWidth < 1000;
  const session = (response?.session as BrowserSessionV2 | undefined) ?? null;
  const { audioState, resumeAudio } = useBrowserAudio(pane.id, session?.sessionId, !observerOnly && session?.status !== "CLOSED");
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
    element.dataset.browserInputPeakPending = String(Math.max(Number(element.dataset.browserInputPeakPending ?? 0), pendingBrowserInputAcksRef.current.size));
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
      if (pendingAck.motion) flushCoalescedBrowserInput();
    }, browserInputAckTimeoutMs);
    pendingBrowserInputAcksRef.current.set(requestId, { sentAt, timeoutId, motion: (input.type === "POINTER" && (input.eventType === "mouseMoved" || input.eventType === "mouseWheel")) || (input.type === "TOUCH" && input.eventType === "touchMove") });
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
      (input.type === "POINTER" && (input.eventType === "mouseMoved" || input.eventType === "mouseWheel")) ||
      (input.type === "TOUCH" && input.eventType === "touchMove");
    if (!coalescible) {
      flushCoalescedBrowserInput();
      return sendBrowserInputNow(input);
    }
    const previous = coalescedBrowserInputRef.current;
    if (previous) {
      const sameKind = previous.type === input.type && "eventType" in previous && "eventType" in input && previous.eventType === input.eventType && previous.leaseId === input.leaseId;
      if (sameKind && previous.type === "POINTER" && input.type === "POINTER" && input.eventType === "mouseWheel" && previous.modifiers === input.modifiers) {
        const deltaX = (previous.deltaX ?? 0) + (input.deltaX ?? 0);
        const deltaY = (previous.deltaY ?? 0) + (input.deltaY ?? 0);
        // Preserve distance, modifiers and ordering. Split only at the wire
        // contract's limit; never replace wheel deltas with the last event.
        if (Math.abs(deltaX) <= 10000 && Math.abs(deltaY) <= 10000) input = { ...input, deltaX, deltaY };
        else flushCoalescedBrowserInput();
      } else if (!sameKind || (previous.type === "POINTER" && input.type === "POINTER" && previous.modifiers !== input.modifiers)) flushCoalescedBrowserInput();
    }
    coalescedBrowserInputRef.current = input;
    if (coalescedBrowserInputFrameRef.current === null) {
      coalescedBrowserInputFrameRef.current = window.requestAnimationFrame(() => {
        coalescedBrowserInputFrameRef.current = null;
        const pendingInput = coalescedBrowserInputRef.current;
        coalescedBrowserInputRef.current = null;
        if (pendingInput) {
          if ([...pendingBrowserInputAcksRef.current.values()].some((ack) => ack.motion)) coalescedBrowserInputRef.current = pendingInput;
          else sendBrowserInputNow(pendingInput);
        }
      });
    }
    return true;
  }

  function syntheticPage(nextSession: BrowserSessionV2): BrowserPageSummaryPayload[] {
    if (nextSession.status === "CLOSED") return [];
    if (nextSession.pages !== undefined) return nextSession.pages;
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
    const nextSession = next.session as BrowserSessionV2;
    if (pageSessionIdRef.current !== nextSession.sessionId || nextSession.status === "CLOSED") {
      pageSessionIdRef.current = nextSession.sessionId;
      pageListRef.current = null;
      pageRequestRef.current += 1;
    }
    // Session snapshots can predate a tab mutation or a Chrome restore. Once
    // available, only the page-list endpoint owns the tab strip's identities.
    const knownPages = pageListRef.current;
    setResponse(knownPages ? { ...next, session: { ...nextSession, pages: knownPages.pages, activePageId: knownPages.activePageId } } : next);
    if (nextSession.status === "CLOSED") setFrame(null);
    else appendFrame(next.frame);
    if (urlDraftRef.current === null) setUrl(nextSession.status === "CLOSED" ? "" : displayUrl(next));
    setStreamMode(nextSession.streamMode ?? "AUTO");
    const nextPages = knownPages?.pages ?? syntheticPage(nextSession);
    setPages(nextPages);
    setActivePageId(knownPages ? knownPages.activePageId : nextSession.activePageId ?? nextPages.find((page) => page.isActive)?.pageId ?? nextPages[0]?.pageId ?? null);
    if (nextSession.status !== "CLOSED") void loadPages();
  }

  async function loadPages() {
    const request = ++pageRequestRef.current;
    const sessionId = pageSessionIdRef.current;
    try {
      const next = await api.browserPages(pane.id);
      if (request !== pageRequestRef.current || sessionId !== pageSessionIdRef.current || next.sessionId !== sessionId) return null;
      applyPagePayload(next);
      return next;
    } catch {
      // The legacy browser host exposes one implicit page through the session response.
      return null;
    }
  }

  useEffect(() => {
    if (!session || session.status === "CLOSED") return;
    // Other operators and agents share these tabs with the current pane.
    const timer = window.setInterval(() => {
      if (!pageMutationRef.current && document.visibilityState !== "hidden") void loadPages();
    }, 5000);
    return () => { window.clearInterval(timer); pageRequestRef.current += 1; };
  }, [pane.id, session?.sessionId, session?.status]);

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

  useEffect(() => {
    if (observerOnly || pane.mode !== "BROWSER" || typeof api.browserAccounts !== "function") return;
    let disposed = false;
    api.browserAccounts(pane.id).then((accounts) => { if (!disposed) setGoogleAccounts(accounts); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [pane.id, pane.mode, observerOnly]);

  async function selectGoogleAccount(profileId: string | null) {
    if (pending || observerOnly) return;
    setGoogleAccountMenuOpen(false);
    setPending(true);
    setError(null);
    try {
      const selected = await api.selectBrowserAccount(pane.id, profileId);
      controlLeaseRef.current = null;
      legacyControlRef.current = false;
      setControlLease(null);
      setHandoff(false);
      pageSessionIdRef.current = null;
      pageListRef.current = null;
      pageRequestRef.current += 1;
      setResponse(null);
      setFrame(null);
      setPages([]);
      setActivePageId(null);
      urlDraftRef.current = null;
      setUrl(selected.targetUrl);
      setGoogleAccounts((current) => current ? { ...current, selectedProfileId: selected.selectedProfileId } : current);
      setGoogleSignInTarget(profileId ? selected.targetUrl : null);
      applyResponse(await api.startBrowserSession(pane.id, { viewport, targetUrl: selected.targetUrl, ownerAgentId: `agent:${agentNumber}` }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Google account could not be opened.");
    } finally { setPending(false); }
  }

  useGoogleAccountSignIn({
    paneId: pane.id, targetUrl: googleSignInTarget, session, enabled: !observerOnly && !pending,
    acquireControl: acquireControlForInput, onFrame: appendFrame, onError: setError
  });

  async function loadOrStart(showPending = true) {
    if (showPending) setPending(true);
    setError(null);
    try {
      const nextStatus = await loadSharedBrowserStatus();
      setStatus(nextStatus);
      const homeUrl = "about:blank";
      if (!nextStatus.enabled) {
        setResponse(null);
        setFrame(null);
        return;
      }
      try {
        let nextResponse = await api.browserSession(pane.id);
        if (!observerOnly && (nextResponse.session.status === "CLOSED" || nextResponse.session.status === "ERROR")) {
          nextResponse = await api.startBrowserSession(pane.id, {
            viewport: defaultViewport, targetUrl: homeUrl, ownerAgentId: `agent:${agentNumber}`
          });
        }
        applyResponse(nextResponse);
        recordLifecycleDebugEvent({
          type: "session_sync",
          scope: "BrowserPane",
          detail: `status=${nextResponse.session.status} viewport=${nextResponse.session.viewport}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
      } catch {
        if (observerOnly) {
          setResponse(null);
          setFrame(null);
          recordLifecycleDebugEvent({
            type: "session_sync",
            scope: "BrowserPane",
            detail: "observer session unavailable",
            paneId: pane.id,
            paneMode: pane.mode
          });
          return;
        }
        const nextResponse = await api.startBrowserSession(pane.id, {
          viewport: defaultViewport,
          targetUrl: homeUrl,
          ownerAgentId: `agent:${agentNumber}`
        });
        applyResponse(nextResponse);
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
    if (!fallbackTicket || !sessionId || session?.status === "CLOSED" || streamMode === "SILENT") {
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
      let ticket = observerOnly ? fallbackTicket : null;
      try {
        if (!ticket) ticket = (await api.browserStreamTicket(pane.id)).websocket;
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
          const acknowledge = () => {
            if (!disposed && socket.readyState === WebSocket.OPEN && new URL(socketUrl, window.location.href).searchParams.get("frameAck") === "1") {
              socket.send(JSON.stringify({ type: "frameAck" }));
            }
          };
          if (canvasRef.current) canvasRef.current.present(event.data, new Date().toISOString(), streamedViewportRef.current, acknowledge);
          else acknowledge();
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
            if (message.type === "viewport") {
              streamedViewportRef.current = message.dimensions;
              setStreamDimensions((previous) => previous?.width === message.dimensions.width && previous.height === message.dimensions.height ? previous : message.dimensions);
              return;
            }
            if (message.type === "inputAck") {
              const pendingAck = pendingBrowserInputAcksRef.current.get(message.requestId);
              if (pendingAck) {
                window.clearTimeout(pendingAck.timeoutId);
                pendingBrowserInputAcksRef.current.delete(message.requestId);
                const roundTripMs = Math.max(0, Math.round(performance.now() - pendingAck.sentAt));
                if (paneRef.current) paneRef.current.dataset.browserInputRttMs = String(roundTripMs);
                if (pendingAck.motion) flushCoalescedBrowserInput();
                if (paneRef.current) paneRef.current.dataset.browserInputRttAt = String(performance.now());
                updateBrowserInputTelemetry(message.ok ? "ok" : "failed");
              }
              if (!message.ok) setError(message.error.message);
              return;
            }
            if (message.type !== "error") return;
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
  }, [pane.id, response?.websocket?.token, session?.sessionId, session?.status, streamMode]);

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
    if (!session || session.status === "CLOSED" || streamMode === "SILENT") return;
    const intervalMs = streamMode === "PREVIEW" || streamMode === "AUTO" ? 5000 : streamMode === "INTERACTIVE" ? 1500 : 5000;
    const interval = window.setInterval(() => {
      if (browserStreamSocketRef.current?.readyState === WebSocket.OPEN) return;
      api.browserFrame(pane.id, session.sessionId).then(appendFrame).catch(() => undefined);
    }, intervalMs);
    return () => window.clearInterval(interval);
  }, [pane.id, session?.sessionId, session?.status, streamMode]);

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
      const submittedAddress = url.trim();
      const targetUrl = resolveBrowserAddress(submittedAddress);
      let next = !session || session.status === "CLOSED"
        ? await api.startBrowserSession(pane.id, { viewport, targetUrl, ownerAgentId: `agent:${agentNumber}` })
        : await api.navigateBrowser(pane.id, targetUrl);
      // Restoring an older session may select its previous page first.
      if (next.session.targetUrl !== targetUrl && next.session.currentUrl !== targetUrl) next = await api.navigateBrowser(pane.id, targetUrl);
      if (urlDraftRef.current?.trim() === submittedAddress) urlDraftRef.current = null;
      applyResponse(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser navigation failed");
    } finally {
      setPending(false);
    }
  }

  async function setViewport(nextViewport: BrowserSessionViewport) {
    if (pending) return;
    setFitPane(false);
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

  useEffect(() => {
    const surface = frameShellRef.current;
    if (!fitPane || !handoff || !session || session.status === "CLOSED" || !surface || typeof ResizeObserver === "undefined") return;
    let disposed = false;
    let timer: number;
    let lastSize = "";
    const resize = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      if (resizeBusyRef.current) { timer = window.setTimeout(() => void resize(), 250); return; }
      const canvas = surface.querySelector("canvas");
      const bounds = canvas?.getBoundingClientRect();
      if (!bounds || bounds.width < 50 || bounds.height < 50) return;
      const scale = Math.min(1, 2560 / bounds.width, 1600 / bounds.height);
      const dimensions = { width: Math.max(240, Math.round(bounds.width * scale)), height: Math.max(180, Math.round(bounds.height * scale)) };
      const key = `${dimensions.width}:${dimensions.height}`;
      if (key === lastSize) return;
      resizeBusyRef.current = true;
      try {
        const next = await api.setBrowserViewport(pane.id, "desktop", dimensions);
        if (!disposed) {
          lastSize = key;
          // Preserve the existing stream ticket and socket during a resize.
          setResponse((previous) => previous?.session.sessionId === next.session.sessionId
            ? { ...previous, session: next.session, viewportDimensions: next.viewportDimensions }
            : previous);
        }
      } catch (error) {
        if (!disposed) { setFitPane(false); setError(error instanceof Error ? error.message : "Browser resize failed"); }
      } finally { resizeBusyRef.current = false; }
    };
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void resize(), 250); };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    schedule();
    return () => { disposed = true; window.clearTimeout(timer); observer.disconnect(); };
  }, [fitPane, handoff, pane.id, session?.sessionId, session?.status]);

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
    if (next.sessionId !== pageSessionIdRef.current) return;
    pageRequestRef.current += 1;
    pageListRef.current = next;
    setPages(next.pages);
    setActivePageId(next.activePageId);
    const active = next.pages.find((page) => page.pageId === next.activePageId);
    if (!next.pages.length) {
      setFrame(null);
      setSelectedFrameIndex(null);
      controlLeaseRef.current = null;
      if (urlDraftRef.current === null) setUrl("");
    }
    setResponse((previous) => previous?.session.sessionId === next.sessionId ? {
      ...previous,
      ...(!next.pages.length ? { frame: null, websocket: null } : {}),
      session: { ...previous.session, pages: next.pages, activePageId: next.activePageId,
        ...(!next.pages.length ? { status: "CLOSED", isActive: false, currentUrl: null, targetUrl: "about:blank", title: null } : {}),
        ...(active ? { currentUrl: active.url, title: active.title } : {}) }
    } : previous);
    if (active?.url && urlDraftRef.current === null) setUrl(active.url === "about:blank" ? "" : active.url);
  }

  async function activatePage(pageId: string) {
    if (!session || session.status === "CLOSED" || observerOnly || pending || pageMutationRef.current || pageId === activePageId || pageId.startsWith("legacy:")) return;
    pageMutationRef.current = true;
    pageRequestRef.current += 1;
    setPending(true);
    setError(null);
    try {
      applyPagePayload(await api.activateBrowserPage(pane.id, pageId));
    } catch (err) {
      const refreshed = await loadPages();
      if (!refreshed || refreshed.pages.some((page) => page.pageId === pageId)) {
        setError(err instanceof Error ? err.message : "Browser tab failed to activate");
      }
    } finally {
      pageMutationRef.current = false;
      setPending(false);
    }
  }

  async function createPage() {
    if (observerOnly || pending || pageMutationRef.current || !status?.enabled) return;
    setBlankTabRequested(true);
    if (emptyBrowser && session && session.status !== "CLOSED") return;
    pageMutationRef.current = true;
    pageRequestRef.current += 1;
    setPending(true);
    setError(null);
    try {
      if (!session || session.status === "CLOSED") {
        urlDraftRef.current = null;
        applyResponse(await api.startBrowserSession(pane.id, { viewport, targetUrl: "about:blank", streamMode, ownerAgentId: `agent:${agentNumber}` }));
      } else applyPagePayload(await api.createBrowserPage(pane.id, { activate: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Browser tab failed to open");
    } finally {
      pageMutationRef.current = false;
      setPending(false);
    }
  }

  async function closePage(pageId: string) {
    if (!session || session.status === "CLOSED" || observerOnly || pending || pageMutationRef.current || pageId.startsWith("legacy:")) return;
    pageMutationRef.current = true;
    pageRequestRef.current += 1;
    setPending(true);
    setError(null);
    try {
      applyPagePayload(await api.closeBrowserPage(pane.id, pageId));
    } catch (err) {
      const refreshed = await loadPages();
      if (!refreshed || refreshed.pages.some((page) => page.pageId === pageId)) {
        setError(err instanceof Error ? err.message : "Browser tab failed to close");
      }
    } finally {
      pageMutationRef.current = false;
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
    if (!session || diagnosticsLoadingRef.current) return;
    diagnosticsLoadingRef.current = true;
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
      diagnosticsLoadingRef.current = false;
      setDiagnosticsPending(false);
    }
  }

  useEffect(() => {
    if (!debugOpen || !diagnosticsLive || !session || session.status === "CLOSED" || !["console", "network"].includes(debugTab)) return;
    let cancelled = false;
    let timer: number;
    const refresh = async () => {
      if (cancelled) return;
      if (document.visibilityState !== "hidden") await loadDiagnostics();
      if (!cancelled) timer = window.setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
    // Reads only this pane; a ref prevents overlapping manual/live requests.
  }, [debugOpen, diagnosticsLive, debugTab, pane.id, session?.sessionId, session?.status]);

  useEffect(() => {
    if (!debugOpen || debugTab !== "timeline") {
      setSelectedFrameIndex(null);
      canvasRef.current?.showHistory(null);
    }
  }, [debugOpen, debugTab]);

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
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const submittedAddress = url.trim();
      const targetUrl = submittedAddress ? resolveBrowserAddress(submittedAddress) : "about:blank";
      let next = await api.startBrowserSession(pane.id, { viewport, targetUrl, ownerAgentId: `agent:${agentNumber}` });
      if (next.session.targetUrl !== targetUrl && next.session.currentUrl !== targetUrl) next = await api.navigateBrowser(pane.id, targetUrl);
      if (urlDraftRef.current?.trim() === submittedAddress) urlDraftRef.current = null;
      applyResponse(next);
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
    if (!session || session.status === "CLOSED" || observerOnly) return null;
    const currentLease = controlLeaseRef.current;
    if (currentLease?.status === "ACTIVE" && currentLease.sessionId === session.sessionId && Date.parse(currentLease.expiresAt) > Date.now() + 1000) return currentLease;
    controlLeaseRef.current = null;
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
      pageSessionIdRef.current = null;
      pageListRef.current = null;
      pageRequestRef.current += 1;
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
    if (input.type === "KEY" && (input.eventType === "keyDown" || input.eventType === "char") && input.text) {
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
  const [browserToolbarStorageKeys] = useState(() => {
    const storageKeys = uiTheme !== "classic"
      ? modernPaneToolbarStorageKeys(pane.mode)
      : {
          hidden: BROWSER_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY,
          order: BROWSER_TOOLBAR_ACTION_ORDER_STORAGE_KEY
        };
    if (uiTheme !== "classic") {
      migrateModernToolbarPreference(
        getSpaceRuntime().platform.localStorage,
        BROWSER_TOOLBAR_HIDDEN_ACTIONS_STORAGE_KEY,
        storageKeys.hidden
      );
      migrateModernToolbarPreference(
        getSpaceRuntime().platform.localStorage,
        BROWSER_TOOLBAR_ACTION_ORDER_STORAGE_KEY,
        storageKeys.order
      );
    }
    return storageKeys;
  });
  const browserToolbar = usePersistentIconToolbar({
    actions: browserToolbarActions,
    hiddenStorageKey: browserToolbarStorageKeys.hidden,
    orderStorageKey: browserToolbarStorageKeys.order,
    preserveUnknownActionIds: uiTheme !== "classic"
  });
  useDismissibleToolbarLayer({
    containerRef: googleAccountPickerRef,
    active: googleAccountMenuOpen,
    onDismiss: () => setGoogleAccountMenuOpen(false)
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
  const filteredEvents = diagnostics.events.filter((entry) =>
    !diagnosticsFilter || `${entry.level} ${entry.message} ${JSON.stringify(entry.metadata)}`.toLowerCase().includes(diagnosticsFilter.toLowerCase())
  );
  const consoleEvents = filteredEvents.filter((entry) => entry.type === "CONSOLE" || entry.type === "ERROR");
  const networkEvents = filteredEvents.filter((entry) => entry.type === "NETWORK");

  return (
    <section
      ref={paneRef}
      className={`browser-pane${focusMode ? " browser-pane-focus" : ""}${debugOpen ? " debugger-open" : ""}`}
      aria-label={`${pane.title} browser session`}
      data-browser-agent={agentNumber}
      data-browser-audio-state={audioState}
      data-browser-session-status={session?.status ?? "NONE"}
    >
      {pane.title === "DeepSeek Harness" ? (
      <div className="browser-pane-legacy-harness-notice" role="note" data-legacy-harness="true">
          <span>Legacy Harness (Browser) — Convert to Harness</span>
        </div>
      ) : null}
      <div className="browser-tab-strip" role="tablist" aria-label={`Browser tabs ${pane.title}`}>
        <div className="browser-tab-scroll">
          {(emptyBrowser ? [] : pages).map((page) => {
            const selected = activePageId ? page.pageId === activePageId : page.isActive;
            return (
              <div key={page.pageId} data-browser-page-id={page.pageId} className={`browser-tab${selected ? " selected" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-label={page.title ?? page.url ?? "Browser tab"}
                  title={page.url ?? page.title ?? "Browser tab"}
                  disabled={observerOnly || pending || session?.status === "CLOSED" || page.pageId.startsWith("legacy:")}
                  onClick={() => void activatePage(page.pageId)}
                >
                  <Globe2 aria-hidden="true" />
                  <span>{page.title ?? page.url ?? "New tab"}</span>
                </button>
                {!page.pageId.startsWith("legacy:") ? (
                  <button
                    type="button"
                    className="browser-tab-close"
                    aria-label={`Close browser tab ${page.title ?? page.url ?? "tab"}`}
                    title="Close tab"
                    disabled={observerOnly || pending || session?.status === "CLOSED"}
                    onClick={() => void closePage(page.pageId)}
                  >
                    <X aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        <button type="button" className="browser-new-tab" aria-label={`New browser tab ${pane.title}`} title="New tab" onClick={() => void createPage()} disabled={observerOnly || !status?.enabled || pending}>
          <Plus aria-hidden="true" />
        </button>
      </div>
      <div className={`browser-pane-toolbar${compactToolbar ? " browser-toolbar-compact" : ""}`} data-toolbar-width={toolbarWidth}>
      {googleAccounts?.profiles.length ? <div ref={googleAccountPickerRef} className="browser-account-picker"
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setGoogleAccountMenuOpen(false); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setGoogleAccountMenuOpen(false); googleAccountButtonRef.current?.focus(); } }}>
        <button ref={googleAccountButtonRef} type="button" className={`browser-account-trigger${googleAccounts.selectedProfileId ? " selected" : ""}`}
          aria-label={`Google account for ${pane.title}`} aria-haspopup="menu" aria-expanded={googleAccountMenuOpen}
          title={`Google account: ${googleAccounts.profiles.find((profile) => profile.profileId === googleAccounts.selectedProfileId)?.displayName ?? "Saved pane account"}`}
          disabled={pending || observerOnly} onClick={() => { browserToolbar.closeMenus(); setGoogleAccountMenuOpen((value) => !value); }}><Users aria-hidden="true" /></button>
        {googleAccountMenuOpen ? <div className="browser-account-menu" role="menu" aria-label={`Google accounts for ${pane.title}`}>
          <strong>Google account</strong>
          {[{ profileId: null, displayName: "Saved pane account" }, ...googleAccounts.profiles].map((profile) => <button key={profile.profileId ?? "pane-account"}
            type="button" role="menuitemradio" data-profile-id={profile.profileId ?? ""} aria-checked={googleAccounts.selectedProfileId === profile.profileId}
            onClick={() => void selectGoogleAccount(profile.profileId)}>
            <span>{profile.displayName}</span>{googleAccounts.selectedProfileId === profile.profileId ? <Check aria-hidden="true" /> : null}
          </button>)}
          {googleAccounts.selectedProfileId ? <button type="button" role="menuitem" onClick={() => void selectGoogleAccount(googleAccounts.selectedProfileId)}>Sign in to selected account</button> : null}
          <small>Sign in once. Chrome remembers this account in this pane.</small>
        </div> : null}
      </div> : null}
        <form onSubmit={navigate} className="browser-url-form">
          <Globe2 aria-hidden="true" />
          <input name="browser-url" value={url} onChange={(event) => { urlDraftRef.current = event.target.value; setUrl(event.target.value); }} aria-label={`Browser URL ${pane.title}`} placeholder="Search or enter address" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={observerOnly} />
          <button type="submit" title="Navigate browser" aria-label={`Navigate browser ${pane.title}`} disabled={observerOnly || pending || !url.trim()}>
            <Send aria-hidden="true" />
          </button>
        </form>
        <div className="browser-compact-controls">
          {!compactToolbar ? <>
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
          <button type="button" className={`browser-devtools-toggle${debugOpen ? " selected" : ""}`}
            aria-label={`DevTools ${pane.title}`} title="DevTools: console, network and agent tools"
            aria-expanded={debugOpen} onClick={() => void toggleDebug()} disabled={!session}>
            <Bug aria-hidden="true" /><span>DevTools</span>
          </button>
          <button type="button" className="browser-fit-toggle" aria-label={`Fit browser to pane ${pane.title}`}
            title="Resize the web page to fill this pane" aria-pressed={fitPane}
            disabled={!canUseSession || pending}
            onClick={() => {
              if (fitPane) { setFitPane(false); return; }
              void acquireControlForInput().then(() => setFitPane(true)).catch((error) => setError(error instanceof Error ? error.message : "Browser control unavailable"));
            }}><Maximize2 aria-hidden="true" /><span>Fit pane</span></button>
          {!compactToolbar ? <div className="browser-viewport-control" role="group" aria-label={`Browser viewport ${pane.title}`}>
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
          </div> : null}
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
          {!compactToolbar ? <button
            type="button"
            className={`browser-focus-toggle${focusMode ? " selected" : ""}`}
            title={focusMode ? "Exit browser focus mode" : "Expand browser view"}
            aria-label={`${focusMode ? "Exit browser focus mode" : "Expand browser view"} ${pane.title}`}
            aria-pressed={focusMode}
            onClick={() => void toggleFocusMode()}
            disabled={!session}
          >
            {focusMode ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
          </button> : null}
          </> : null}
          <div ref={browserToolbarRef} className="browser-pane-actions" aria-label={`Browser toolbar actions ${pane.title}`}>
            <div className="pane-actions-overflow browser-toolbar-overflow">
            <button
              type="button"
              title={`More browser actions ${pane.title}`}
              aria-label={`More browser actions ${pane.title}`}
              aria-expanded={browserToolbar.isOverflowOpen}
              onClick={() => {
                setGoogleAccountMenuOpen(false);
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
                {compactToolbar ? <>
                  <label className="browser-menu-stream">Stream mode
                    <select name="browser-stream-mode" value={streamMode} aria-label={`Stream mode ${pane.title}`} disabled={!session || pending}
                      onChange={(event) => void setStream(event.target.value as BrowserStreamMode)}>
                      {streamModeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                  </label>
                  <button type="button" role="menuitem" aria-label={`DevTools ${pane.title}`} aria-expanded={debugOpen} disabled={!session}
                    onClick={() => { browserToolbar.closeMenus(); void toggleDebug(); }}><Bug aria-hidden="true" /><span>DevTools</span></button>
                  <button type="button" role="menuitem" aria-label={`Fit browser to pane ${pane.title}`} aria-pressed={fitPane} disabled={!canUseSession || pending}
                    onClick={() => { browserToolbar.closeMenus(); if (fitPane) { setFitPane(false); return; } void acquireControlForInput().then(() => setFitPane(true)).catch((error) => setError(error instanceof Error ? error.message : "Browser control unavailable")); }}><Maximize2 aria-hidden="true" /><span>Fit pane</span></button>
                  <button type="button" role="menuitem" aria-label={`${handoff ? "Release browser control" : "Join browser session"} ${pane.title}`} aria-pressed={handoff} disabled={!session || pending}
                    onClick={() => { browserToolbar.closeMenus(); void (handoff ? releaseControl() : joinSession()); }}><UserCheck aria-hidden="true" /><span>{handoff ? "Release browser control" : "Join browser session"}</span></button>
                  <span className="browser-tools-menu-label" role="presentation">Viewport</span>
                  {viewportOptions.map(({ id, label, Icon }) => <button key={id} type="button" role="menuitem" aria-label={`${label} view ${pane.title}`} aria-pressed={viewport === id && !fitPane} disabled={!canUseSession || pending}
                    onClick={() => { browserToolbar.closeMenus(); void setViewport(id); }}><Icon aria-hidden="true" /><span>{label} view</span></button>)}
                  <button type="button" role="menuitem" aria-label={`${focusMode ? "Exit browser focus mode" : "Expand browser view"} ${pane.title}`} disabled={!session}
                    onClick={() => { browserToolbar.closeMenus(); toggleFocusMode(); }}><Maximize2 aria-hidden="true" /><span>{focusMode ? "Exit focus mode" : "Expand browser view"}</span></button>
                </> : null}
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
      <BrowserLiveStatus compact paneRef={paneRef} sessionId={session?.status === "CLOSED" ? null : session?.sessionId ?? null} paused={selectedFrameIndex !== null} handoff={handoff} />
      </div>

      <div className={`browser-workspace${debugOpen ? " with-debugger" : ""}`}>
        <div ref={frameShellRef} className="browser-frame-shell">
          <BrowserCanvas
            key={session?.status === "CLOSED" ? "empty" : session?.sessionId ?? "empty"}
            ref={canvasRef}
            historyLimit={debugOpen && debugTab === "timeline" ? 48 : 1}
            onPresented={() => {
              if (paneRef.current) paneRef.current.dataset.browserPresentedFrames = String(Number(paneRef.current.dataset.browserPresentedFrames ?? 0) + 1);
            }}
            ariaLabel={`${pane.title} browser frame`}
            viewportSize={streamDimensions ?? response?.viewportDimensions ?? viewportSizes[viewport]}
            interactive={!observerOnly && Boolean(session && session.status !== "CLOSED") && !pending}
            source={emptyBrowser ? undefined : activeFrame?.screenshotDataUrl}
            capturedAt={activeFrame?.capturedAt}
            onInput={(input) => void sendCanvasInput(input)}
          />
          {emptyBrowser || !activeFrame?.screenshotDataUrl ? (
            <div className="browser-frame-empty" role="status">
              {pending ? <Loader2 aria-hidden="true" /> : emptyBrowser || session?.status === "CLOSED" ? <span>No open tabs. Use + to open a new tab.</span> : <MousePointer2 aria-hidden="true" />}
            </div>
          ) : null}
          {selectedFrameIndex !== null ? <span className="browser-frame-paused">Frame {selectedFrameIndex + 1} / {canvasHistoryLength}</span> : null}
        </div>

        {debugOpen ? (
          <aside className="browser-debug-drawer" aria-label={`Browser debugger ${pane.title}`}>
            <div className="browser-debug-tabs" role="tablist" aria-label="Browser debug views">
              {(["console", "network", "timeline", "artifacts", "agents"] as BrowserDebugTab[]).map((tab) => (
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
              {["console", "network"].includes(debugTab) ? (
                <div className="browser-devtools-controls">
                  <input aria-label="Filter browser diagnostics" placeholder="Filter events" value={diagnosticsFilter} onChange={(event) => setDiagnosticsFilter(event.target.value)} />
                  <button type="button" aria-pressed={diagnosticsLive} onClick={() => setDiagnosticsLive((value) => !value)}>Live</button>
                  <button type="button" aria-label="Refresh browser diagnostics" disabled={diagnosticsPending} onClick={() => void loadDiagnostics()}><RefreshCw aria-hidden="true" /></button>
                </div>
              ) : null}
              {diagnosticsPending && !diagnostics.events.length ? <span role="status">Loading diagnostics...</span> : null}
              {debugTab === "agents" ? (
                <div className="browser-agent-tools">
                  <strong>One browser, shared with your agents</strong>
                  <p>Agents in this room can inspect and operate this session. Take control to type or sign in; release control when the agent can continue.</p>
                  <dl><dt>Pane</dt><dd>{pane.id}</dd><dt>Session</dt><dd>{session?.sessionId ?? "No session"}</dd></dl>
                  <p><code>browser_context</code> discovers this room's browsers.</p>
                  <p><code>browser_devtools</code> reads console errors and network events, including while you hold control.</p>
                  <p><code>browser_tabs</code>, <code>browser_extract_text</code> and <code>browser_screenshot</code> inspect the page.</p>
                  <p><code>browser_click</code>, <code>browser_type</code>, <code>browser_scroll</code> and <code>browser_navigate</code> operate the same session.</p>
                  <p><code>browser_request_handoff</code> asks you to complete login, CAPTCHA or MFA inside this browser.</p>
                </div>
              ) : null}
              {debugTab === "console" ? (
                consoleEvents.length ? consoleEvents.map((entry) => (
                  <div key={entry.eventId} className={`browser-debug-entry ${entry.level.toLowerCase()}`}>
                    <span>{entry.level}</span><p>{Array.isArray(entry.metadata.values)
                      ? entry.metadata.values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")
                      : entry.message}</p><time>{new Date(entry.occurredAt).toLocaleTimeString()}</time>
                  </div>
                )) : <span>No console events</span>
              ) : null}
              {debugTab === "network" ? (
                networkEvents.length ? networkEvents.map((entry) => (
                  <div key={entry.eventId} className="browser-debug-entry network">
                    <span>{metadataText(entry.metadata, "method")}</span><strong>{metadataText(entry.metadata, "status")}</strong><p title={metadataText(entry.metadata, "url")}>{metadataText(entry.metadata, "url", entry.message)}</p>
                  </div>
                )) : <span>No network events</span>
              ) : null}
              {debugTab === "timeline" ? (
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

      {captureNotice ? (
        <div className="browser-pane-notice" role="status">
          <span>{captureNotice}</span>
          <button type="button" className="browser-pane-notice-close" aria-label="Dismiss message" onClick={() => setCaptureNotice(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {session?.status === "CLOSED" ? (
        <div className="browser-pane-notice" role="status">
          <span>Browser is stopped.</span>
          {!observerOnly ? <button type="button" onClick={() => void reconnect()} disabled={pending}>Start browser</button> : null}
        </div>
      ) : null}
      {audioState === "blocked" ? <button type="button" className="browser-pane-notice" onClick={resumeAudio}>Resume audio</button> : null}
      {error ? (
        <div className="browser-pane-error" role="alert">
          <span>{error}</span>
          <button type="button" className="browser-pane-notice-close" aria-label="Dismiss message" onClick={() => setError(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
