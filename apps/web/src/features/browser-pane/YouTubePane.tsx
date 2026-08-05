import { Globe2, Loader2, Maximize2, Minimize2, MousePointer2, RefreshCw, X, Youtube } from "../ui-theme/app-icons.js";
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
import type { UiTheme } from "../../ui-theme.js";

interface YouTubePaneProps {
  pane: Pane;
  agentNumber: number;
  observerOnly?: boolean;
  uiTheme?: UiTheme;
}

type BrowserSessionV2 = PaneBrowserSessionResponse["session"];

const YOUTUBE_URL = "https://www.youtube.com/";
const YOUTUBE_VIEWPORT: BrowserSessionViewport = "tablet";
const YOUTUBE_VIEWPORT_SIZE = { width: 834, height: 1112 };
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

export function YouTubePane({ pane, agentNumber, observerOnly = false }: YouTubePaneProps) {
  const [status, setStatus] = useState<BrowserStatusPayload | null>(null);
  const [response, setResponse] = useState<PaneBrowserSessionResponse | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [controlLease, setControlLease] = useState<BrowserControlLeasePayload | null>(null);
  const [streamState, setStreamState] = useState<YouTubeStreamState>("idle");
  const [streamFps, setStreamFps] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(false);
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
  const audioSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioNextTimeRef = useRef<number | null>(null);
  const audioQueueRef = useRef<Int16Array[]>([]);

  const session = (response?.session as BrowserSessionV2 | undefined) ?? null;
  const activeFrame = frame ?? response?.frame ?? null;
  const canUseSession = Boolean(session && status?.enabled);
  const live = streamState === "ready" || streamState === "open";

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
    setResponse(next);
    appendFrame(next.frame);
  }

  async function ensureRealtimeStream(nextResponse: PaneBrowserSessionResponse) {
    const nextSession = nextResponse.session as BrowserSessionV2;
    if (nextSession.streamMode !== "REALTIME") {
      void api.updateBrowserSession(pane.id, { streamMode: "REALTIME" }).then(applyResponse).catch(() => undefined);
    }
  }

  async function loadOrStart() {
    setPending(true);
    setError(null);
    try {
      const nextStatus = await api.browserStatus();
      setStatus(nextStatus);
      if (!nextStatus.enabled) {
        setResponse(null);
        setFrame(null);
        updateBrowserStreamTelemetry("closed");
        return;
      }
      try {
        const nextResponse = await api.browserSession(pane.id);
        applyResponse(nextResponse);
        void ensureRealtimeStream(nextResponse);
        recordLifecycleDebugEvent({
          type: "session_sync",
          scope: "YouTubePane",
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
            scope: "YouTubePane",
            detail: "observer session unavailable",
            paneId: pane.id,
            paneMode: pane.mode
          });
          return;
        }
        const nextResponse = await api.startBrowserSession(pane.id, {
          viewport: YOUTUBE_VIEWPORT,
          targetUrl: YOUTUBE_URL,
          ownerAgentId: `agent:${agentNumber}`
        });
        applyResponse(nextResponse);
        void ensureRealtimeStream(nextResponse);
        recordLifecycleDebugEvent({
          type: "session_sync",
          scope: "YouTubePane",
          detail: `started viewport=${nextResponse.session.viewport} status=${nextResponse.session.status}`,
          paneId: pane.id,
          paneMode: pane.mode
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "YouTube session failed to load");
      updateBrowserStreamTelemetry("error");
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    void loadOrStart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, response?.websocket?.token, session?.sessionId]);

  useEffect(() => {
    controlLeaseRef.current = controlLease?.status === "ACTIVE" ? controlLease : null;
  }, [controlLease]);

  useEffect(() => {
    if (!session) return;
    const interval = window.setInterval(() => {
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

  function stopAudioStream() {
    const socket = audioSocketRef.current;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
      audioSocketRef.current = null;
    }
    audioQueueRef.current = [];
    audioNextTimeRef.current = null;
    const audioContext = audioContextRef.current;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
    audioContextRef.current = null;
  }

  function scheduleAudioChunk(int16: Int16Array, sampleRate: number, channels: number) {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;
    const chunkFrames = Math.round(sampleRate * 0.04);
    const framesPerChunk = Math.max(1, Math.floor(chunkFrames / channels));
    const totalFrames = Math.floor(int16.length / channels);
    for (let offset = 0; offset < totalFrames; offset += framesPerChunk) {
      const frameCount = Math.min(framesPerChunk, totalFrames - offset);
      const buffer = audioContext.createBuffer(channels, frameCount, sampleRate);
      for (let channel = 0; channel < channels; channel += 1) {
        const output = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i += 1) {
          output[i] = (int16[(offset + i) * channels + channel] ?? 0) / 32768;
        }
      }
      let startTime = audioNextTimeRef.current;
      const lookahead = 0.035;
      const now = audioContext.currentTime;
      if (startTime === null || startTime < now + lookahead) {
        startTime = now + lookahead;
      } else if (startTime > now + 0.3) {
        startTime = now + lookahead;
      }
      audioNextTimeRef.current = startTime + buffer.duration;
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.start(startTime);
    }
  }

  useEffect(() => {
    if (!session) {
      stopAudioStream();
      return;
    }
    let disposed = false;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const connectAudio = async () => {
      if (disposed) return;
      try {
        const ticket = await api.browserAudioStreamTicket(pane.id);
        if (disposed || ticket.websocket.sessionId !== session.sessionId) return;
        const socketUrl = api.browserAudioWebSocketUrl(ticket.websocket);
        if (!socketUrl) return;
        const socket = new WebSocket(socketUrl);
        socket.binaryType = "arraybuffer";
        audioSocketRef.current = socket;
        socket.addEventListener("open", () => {
          reconnectAttempt = 0;
        });
        socket.addEventListener("message", (event) => {
          if (typeof event.data === "string") {
            try {
              const decoded = JSON.parse(event.data) as unknown;
              const parsed = browserStreamWebSocketServerMessageSchema.safeParse(decoded);
              if (!parsed.success) return;
              const message = parsed.data;
              if (message.type === "audioReady") {
                if (!audioContextRef.current) {
                  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
                  audioContextRef.current = new AudioContextCtor({ sampleRate: message.sampleRate });
                  if (audioContextRef.current.state === "suspended") {
                    void audioContextRef.current.resume().catch(() => undefined);
                  }
                }
              }
            } catch {
              // Ignore malformed audio control messages.
            }
            return;
          }
          const raw = event.data;
          const int16 = new Int16Array(raw);
          if (!audioContextRef.current) {
            const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            audioContextRef.current = new AudioContextCtor({ sampleRate: 44100 });
            if (audioContextRef.current.state === "suspended") {
              void audioContextRef.current.resume().catch(() => undefined);
            }
          }
          scheduleAudioChunk(int16, 44100, 2);
        });
        socket.addEventListener("error", () => {
          if (disposed) return;
          socket.close();
        });
        socket.addEventListener("close", () => {
          if (audioSocketRef.current === socket) audioSocketRef.current = null;
          if (disposed) return;
          if (reconnectTimer !== null) return;
          const delayMs = Math.min(4_000, 500 * (2 ** Math.min(reconnectAttempt, 3)));
          reconnectAttempt += 1;
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            void connectAudio();
          }, delayMs);
        });
      } catch {
        if (disposed || reconnectTimer !== null) return;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          void connectAudio();
        }, 2_000);
      }
    };

    void connectAudio();
    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      stopAudioStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, session?.sessionId]);

  const streamLabel = live ? `Live ${streamFps !== null ? `· ${streamFps} fps` : ""}` : "Offline";
  const statusText = session?.statusReason ?? status?.statusReason ?? "YouTube session";

  return (
    <section
      ref={paneRef}
      className={`youtube-pane${focusMode ? " youtube-pane-focus" : ""}`}
      aria-label={`${pane.title} YouTube session`}
      data-browser-agent={agentNumber}
    >
      <div className="youtube-pane-header">
        <span className="youtube-pane-brand" title="YouTube">
          <Youtube aria-hidden="true" />
          <span>YouTube</span>
        </span>
        <span className="youtube-url-pill" title={YOUTUBE_URL}>
          <Globe2 aria-hidden="true" />
          <span>{YOUTUBE_URL}</span>
        </span>
        <span
          className={`youtube-live-badge ${live ? "live" : streamState === "reconnecting" || streamState === "connecting" ? "connecting" : "offline"}`}
          role="status"
          aria-label={live ? "YouTube live" : statusText}
          title={statusText}
        >
          <span className="youtube-live-dot" aria-hidden="true" />
          {live ? "LIVE" : streamState === "reconnecting" || streamState === "connecting" ? "CONNECTING" : "OFFLINE"}
        </span>
        <button
          type="button"
          className="youtube-pane-reload"
          aria-label={`Reload YouTube ${pane.title}`}
          title="Reload YouTube"
          onClick={() => void reload()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`youtube-focus-toggle${focusMode ? " selected" : ""}`}
          aria-label={focusMode ? `Exit YouTube focus mode ${pane.title}` : `Expand YouTube view ${pane.title}`}
          aria-pressed={focusMode}
          title={focusMode ? "Exit fullscreen view" : "Expand to fullscreen view"}
          onClick={() => void toggleFocusMode()}
        >
          {focusMode ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </button>
      </div>
      <div className="youtube-frame-shell">
        <BrowserCanvas
          ref={canvasRef}
          ariaLabel={`${pane.title} browser frame`}
          viewportSize={YOUTUBE_VIEWPORT_SIZE}
          interactive={Boolean(session)}
          source={activeFrame?.screenshotDataUrl}
          capturedAt={activeFrame?.capturedAt}
          onInput={(input) => void sendCanvasInput(input)}
        />
        {!activeFrame?.screenshotDataUrl ? (
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
