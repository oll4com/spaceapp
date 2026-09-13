import { useGoogleAccountSignIn } from "./useGoogleAccountSignIn.js";
import { Loader2, MousePointer2, RefreshCw, X } from "../ui-theme/app-icons.js";
import { useEffect, useRef, useState } from "react";
import {
  browserStreamWebSocketServerMessageSchema,
  type BrowserFrame,
  type BrowserSessionViewport,
  type Pane,
  type PaneBrowserSessionResponse
} from "@space/contracts";
import {
  api,
  type BrowserControlLeasePayload,
  type BrowserInputPayload,
  type BrowserStatusPayload
} from "../../api.js";
import { browserGateway } from "../../runtime/SpaceRuntime.js";
import { recordLifecycleDebugEvent } from "../../lifecycle-debug.js";
import { BrowserCanvas, type BrowserCanvasHandle, type BrowserCanvasInput } from "./BrowserCanvas.js";
import { useBrowserAudio } from "./useBrowserAudio.js";
import { loadSharedBrowserStatus } from "./browser-status.js";
import {
  BROWSER_PANE_ACTION_EVENT,
  parseBrowserPaneActionDetail,
  registerBrowserPaneEventTarget
} from "./events.js";
import type { UiTheme } from "../../ui-theme.js";

interface YouTubePaneProps {
  targetUrl?: string;
  pane: Pane;
  agentNumber: number;
  observerOnly?: boolean;
  uiTheme?: UiTheme;
}

type BrowserSessionV2 = PaneBrowserSessionResponse["session"];

const YOUTUBE_URL = "https://www.youtube.com/";
const YOUTUBE_VIEWPORT: BrowserSessionViewport = "wide";
const YOUTUBE_VIEWPORT_SIZE = { width: 1280, height: 720 };
const browserInputAckTimeoutMs = 2_000;
const browserStreamReconnectMessage = "Live stream disconnected; reconnecting.";

type YouTubeStreamState = "idle" | "connecting" | "open" | "ready" | "reconnecting" | "error" | "closed" | "silent";

interface PendingBrowserInputAck {
  sentAt: number;
  timeoutId: number;
}

function isUnavailableV2Feature(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 405 || status === 501) return true;
  }
  return error instanceof Error && error.message.toLowerCase().includes("legacy browser host");
}

type BrowserFrameMessage =
  | { type: "ready"; paneId: string; sessionId: string }
  | { type: "frame"; frame: BrowserFrame }
  | { type: "status"; status: string; statusReason?: string | null }
  | { type: "error"; code: string; message: string };

function isBrowserFrameMessage(value: unknown): value is BrowserFrameMessage {
  return typeof value === "object" && value !== null && "type" in value;
}

export function ManagedYouTubeBrowser({ pane, agentNumber, observerOnly = false, targetUrl = YOUTUBE_URL }: YouTubePaneProps) {
  const [status, setStatus] = useState<BrowserStatusPayload | null>(null);
  const [response, setResponse] = useState<PaneBrowserSessionResponse | null>(null);
  const [receivedLiveFrame, setReceivedLiveFrame] = useState(false);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [controlLease, setControlLease] = useState<BrowserControlLeasePayload | null>(null);
  const [streamState, setStreamState] = useState<YouTubeStreamState>("idle");
  const [streamFps, setStreamFps] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transportPaused, setTransportPaused] = useState(false);
  const frameShellRef = useRef<HTMLDivElement | null>(null);
  const streamedViewportRef = useRef<{ width: number; height: number } | undefined>(undefined);
  const [streamDimensions, setStreamDimensions] = useState<{ width: number; height: number } | null>(null);
  const canvasRef = useRef<BrowserCanvasHandle | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);
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
  const transportPausedRef = useRef(false);
  const startingRef = useRef(false);
  const retryTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const retryCountRef = useRef(0);
  const reloadRef = useRef<() => void>(() => undefined);

  const session = (response?.session as BrowserSessionV2 | undefined) ?? null;
  const activeFrame = frame ?? response?.frame ?? null;
  const { audioState, resumeAudio } = useBrowserAudio(pane.id, session?.sessionId, !observerOnly);

  function appendFrame(nextFrame: BrowserFrame | null) {
    if (!nextFrame) return;
    setFrame(nextFrame);
  }

  function updateBrowserStreamTelemetry(state: YouTubeStreamState, input: { fps?: number } = {}) {
    const element = paneRef.current;
    if (!element) return;
    element.dataset.browserStreamState = state;
    if (input.fps !== undefined) element.dataset.browserStreamFps = String(input.fps);
    element.dataset.browserStreamMode = "REALTIME";
    setStreamState(state);
    if (input.fps !== undefined) setStreamFps(input.fps);
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

  function applyResponse(next: PaneBrowserSessionResponse) {
    retryCountRef.current = 0;
    setResponse(next);
    appendFrame(next.frame);
  }

  async function loadOrStart() {
    if (startingRef.current) return;
    startingRef.current = true;
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    setPending(true);
    setError(null);
    try {
      const nextStatus = await loadSharedBrowserStatus();
      setStatus(nextStatus);
      if (!nextStatus.enabled) {
        setResponse(null);
        setFrame(null);
        updateBrowserStreamTelemetry("closed");
        return;
      }
      try {
        if (observerOnly) {
          const nextResponse = await api.browserSession(pane.id);
          applyResponse(nextResponse);
          recordLifecycleDebugEvent({
            type: "session_sync",
            scope: "YouTubePane",
            detail: `observer status=${nextResponse.session.status} viewport=${nextResponse.session.viewport}`,
            paneId: pane.id,
            paneMode: pane.mode
          });
          return;
        }
        const nextResponse = await api.startBrowserSession(pane.id, {
          viewport: YOUTUBE_VIEWPORT,
          targetUrl,
          ownerAgentId: `agent:${agentNumber}`,
          streamMode: "REALTIME",
          includeInitialFrame: false
        });
        applyResponse(nextResponse);
        recordLifecycleDebugEvent({
          type: "session_sync",
          scope: "YouTubePane",
          detail: `started viewport=${nextResponse.session.viewport} status=${nextResponse.session.status} mode=${nextResponse.session.streamMode}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
      } catch (err) {
        if (observerOnly) {
          setResponse(null);
          setFrame(null);
          recordLifecycleDebugEvent({
            type: "session_sync",
            scope: "YouTubePane",
            detail: "observer session unavailable",
            paneId: pane.id,
            paneMode: pane.mode
          });
          return;
        }
        setError(err instanceof Error ? err.message : "YouTube session failed to load");
        updateBrowserStreamTelemetry("error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "YouTube session failed to load");
      updateBrowserStreamTelemetry("error");
    } finally {
      startingRef.current = false;
      setPending(false);
    }
  }

  useGoogleAccountSignIn({
    paneId: pane.id, targetUrl, session, enabled: !observerOnly && !pending,
    acquireControl: acquireControlForInput, onFrame: appendFrame, onError: setError
  });

  useEffect(() => {
    mountedRef.current = true;
    void loadOrStart();
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    if (!error || response || observerOnly || !mountedRef.current) return;
    const retryable = /UPSTREAM_UNAVAILABLE|BROWSER_HOST_UNAVAILABLE|network|fetch|502|503/i.test(error);
    if (!retryable) return;
    retryCountRef.current += 1;
    retryTimerRef.current = window.setTimeout(() => void loadOrStart(), Math.min(15000, 1000 * 2 ** Math.min(retryCountRef.current, 4)));
    return () => { if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error, response, observerOnly]);

  useEffect(() => {
    const surface = frameShellRef.current;
    if (observerOnly || !session || !surface || typeof ResizeObserver === "undefined") return;
    let disposed = false;
    let busy = false;
    let timer: number;
    let lastSize = "";
    const resize = async () => {
      if (disposed || document.hidden) return;
      if (busy) { timer = window.setTimeout(() => void resize(), 250); return; }
      const bounds = surface.getBoundingClientRect();
      if (bounds.width < 50 || bounds.height < 50) return;
      const scale = Math.min(1, 2560 / bounds.width, 1600 / bounds.height);
      const dimensions = { width: Math.max(240, Math.round(bounds.width * scale)), height: Math.max(180, Math.round(bounds.height * scale)) };
      const key = `${dimensions.width}:${dimensions.height}`;
      if (key === lastSize) return;
      busy = true;
      try {
        const next = await api.setBrowserViewport(pane.id, "desktop", dimensions);
        if (!disposed) {
          lastSize = key;
          setResponse((current) => current?.session.sessionId === next.session.sessionId
            ? { ...current, session: next.session, viewportDimensions: next.viewportDimensions } : current);
        }
      } catch {
        // Older browser hosts retain their supported fixed viewport.
      } finally { busy = false; }
    };
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void resize(), 250); };
    const observer = new ResizeObserver(schedule);
    observer.observe(surface);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => { disposed = true; window.clearTimeout(timer); observer.disconnect(); document.removeEventListener("visibilitychange", schedule); };
  }, [pane.id, observerOnly, session?.sessionId]);

  useEffect(() => {
    const unregister = registerBrowserPaneEventTarget(pane.id);
    const handleBrowserPaneAction = (event: Event) => {
      const detail = parseBrowserPaneActionDetail((event as CustomEvent<unknown>).detail);
      if (!detail || detail.paneId !== pane.id) return;
      if (detail.action === "reload") reloadRef.current();
    };
    window.addEventListener(BROWSER_PANE_ACTION_EVENT, handleBrowserPaneAction);
    return () => {
      window.removeEventListener(BROWSER_PANE_ACTION_EVENT, handleBrowserPaneAction);
      unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  useEffect(() => {
    const updatePaused = () => {
      const paused = pane.isMinimized || document.hidden;
      transportPausedRef.current = paused;
      setTransportPaused(paused);
    };
    updatePaused();
    document.addEventListener("visibilitychange", updatePaused);
    return () => document.removeEventListener("visibilitychange", updatePaused);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, pane.isMinimized]);

  useEffect(() => {
    recordLifecycleDebugEvent({
      type: "component_mounted",
      scope: "YouTubePane",
      detail: `pane=${pane.title}`,
      paneId: pane.id,
      paneMode: pane.mode
    });
    return () => {
      recordLifecycleDebugEvent({
        type: "component_unmounted",
        scope: "YouTubePane",
        detail: `pane=${pane.title}`,
        paneId: pane.id,
        paneMode: pane.mode
      });
    };
  }, [pane.id, pane.mode, pane.title]);

  useEffect(() => {
    const fallbackTicket = response?.websocket ?? null;
    const sessionId = session?.sessionId ?? null;
    if (!fallbackTicket || !sessionId) {
      updateBrowserStreamTelemetry("idle");
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
      if (disposed || reconnectTimer !== null || transportPausedRef.current) return;
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
      if (disposed || transportPausedRef.current) return;
      const isInitialAttempt = connectionAttempt === 0;
      connectionAttempt += 1;
      updateBrowserStreamTelemetry("connecting");
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
        setError("Live stream returned a ticket for a different session.");
        scheduleReconnect();
        return;
      }
      const realtimeUrl = api.browserStreamWebSocketUrl?.(ticket, "REALTIME") ?? null;
      const socketUrl = realtimeUrl ?? api.browserFrameWebSocketUrl(ticket);
      if (!socketUrl) {
        scheduleReconnect();
        return;
      }
      const realtime = Boolean(realtimeUrl);
      const socket = browserGateway.connect(socketUrl);
      activeSocket = socket;
      socket.binaryType = "blob";
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
          setReceivedLiveFrame(true);
          return;
        }
        try {
          const decoded = JSON.parse(String(event.data)) as unknown;
          const realtimeMessage = browserStreamWebSocketServerMessageSchema.safeParse(decoded);
          if (realtimeMessage.success) {
            const message = realtimeMessage.data;
            if (message.type === "ready") {
              if (message.paneId !== pane.id || message.sessionId !== sessionId) {
                setError("Live stream connected to a different session.");
                socket.close(1008, "Live stream identity mismatch");
                return;
              }
              if (realtime) browserStreamSocketRef.current = socket;
              reconnectAttempt = 0;
              updateBrowserStreamTelemetry("ready", { fps: message.framesPerSecond });
              setError((current) => current === browserStreamReconnectMessage ? null : current);
              return;
            }
            if (message.type === "viewport") {
              streamedViewportRef.current = message.dimensions;
              setStreamDimensions((current) => current?.width === message.dimensions.width && current.height === message.dimensions.height ? current : message.dimensions);
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
            if (message.type !== "error") return;
            setError(message.message);
            return;
          }
          if (!isBrowserFrameMessage(decoded)) throw new Error("invalid live stream message");
          if (decoded.type === "ready") {
            if (decoded.paneId !== pane.id || decoded.sessionId !== sessionId) {
              socket.close(1008, "Live frame identity mismatch");
              return;
            }
            reconnectAttempt = 0;
            updateBrowserStreamTelemetry("ready");
          } else if (decoded.type === "frame") {
            appendFrame(decoded.frame);
          } else if (decoded.type === "error") {
            setError(decoded.message);
          }
        } catch {
          setError("Live stream returned invalid data.");
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
        if (!disposed && !transportPausedRef.current) scheduleReconnect();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, response?.websocket?.token, session?.sessionId, transportPaused]);

  useEffect(() => {
    controlLeaseRef.current = controlLease?.status === "ACTIVE" ? controlLease : null;
  }, [controlLease]);

  useEffect(() => {
    if (!session) return;
    const interval = window.setInterval(() => {
      if (transportPausedRef.current) return;
      if (browserStreamSocketRef.current?.readyState === WebSocket.OPEN) return;
      api.browserFrame(pane.id, session.sessionId).then(appendFrame).catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [pane.id, session?.sessionId]);

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

  async function acquireControlForInput(): Promise<BrowserControlLeasePayload | null> {
    if (!session) return null;
    if (controlLeaseRef.current?.status === "ACTIVE") return controlLeaseRef.current;
    if (controlAcquirePromiseRef.current) return controlAcquirePromiseRef.current;
    const acquisition = api.acquireBrowserControl(pane.id, {
      holderType: "OPERATOR",
      holderId: "space-user",
      reason: "Direct YouTube interaction",
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
      setError(err instanceof Error ? err.message : "Live control could not be acquired");
      return null;
    }).finally(() => {
      controlAcquirePromiseRef.current = null;
    });
    controlAcquirePromiseRef.current = acquisition;
    return acquisition;
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
          setError(err instanceof Error ? err.message : "Live input failed");
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

  function retry() {
    setError(null);
    void loadOrStart();
  }

  reloadRef.current = () => { void reload(); };

  async function reload() {
    if (!session) return;
    const lease = await acquireControlForInput();
    if (lease) {
      const payload: BrowserInputPayload = { type: "NAVIGATION", action: "RELOAD", leaseId: lease.leaseId };
      if (sendRealtimeBrowserInput(payload)) return;
      try {
        const result = await api.browserInput(pane.id, payload);
        appendFrame(result.frame);
        return;
      } catch (err) {
        if (!isUnavailableV2Feature(err)) {
          setError(err instanceof Error ? err.message : "YouTube reload failed");
          return;
        }
        legacyControlRef.current = true;
      }
    }
    if (!legacyControlRef.current) return;
    appendFrame((await api.browserAction(pane.id, { type: "navigate", url: YOUTUBE_URL, sessionId: session.sessionId })).frame);
  }

  return (
    <section
      ref={paneRef}
      data-browser-audio-state={audioState}
      className="youtube-pane"
      aria-label={`${pane.title} YouTube session`}
      data-browser-agent={agentNumber}
    >
      <div ref={frameShellRef} className="youtube-frame-shell">
        {audioState === "blocked" ? <button type="button" className="youtube-pane-reconnect" onClick={resumeAudio}>Resume audio</button> : null}
        <BrowserCanvas
          ref={canvasRef}
          onPresented={() => {
            if (paneRef.current) paneRef.current.dataset.browserPresentedFrames = String(Number(paneRef.current.dataset.browserPresentedFrames ?? 0) + 1);
          }}
          ariaLabel={`${pane.title} browser frame`}
          viewportSize={streamDimensions ?? response?.viewportDimensions ?? YOUTUBE_VIEWPORT_SIZE}
          interactive={Boolean(session)}
          source={activeFrame?.screenshotDataUrl}
          capturedAt={activeFrame?.capturedAt}
          historyLimit={1}
          onInput={(input) => void sendCanvasInput(input)}
        />
        {!activeFrame?.screenshotDataUrl && !receivedLiveFrame ? (
          <div className="youtube-frame-empty" role="status">
            {pending ? <Loader2 aria-hidden="true" /> : <MousePointer2 aria-hidden="true" />}
          </div>
        ) : null}
      </div>
      {error ? (
        <div className="youtube-pane-error" role="alert">
          <span>{error}</span>
          <button type="button" className="youtube-pane-reconnect" aria-label={`Reconnect live stream ${pane.title}`} onClick={() => retry()}>
            <RefreshCw aria-hidden="true" />
            Reconnect
          </button>
          <button type="button" className="youtube-pane-notice-close" aria-label="Dismiss message" onClick={() => setError(null)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  );
}
