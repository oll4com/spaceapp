type DiagnosticValue = string | number | boolean | null | Record<string, number>;

export interface BrowserDiagnosticRecord {
  sequence: number;
  at: string;
  elapsedMs: number;
  kind: string;
  details: Record<string, DiagnosticValue>;
}

export interface BrowserDiagnosticReport {
  schemaVersion: 1;
  enabledAt: string;
  uptimeMs: number;
  environment: {
    navigationProtocol: string | null;
    visibilityState: DocumentVisibilityState;
    online: boolean;
    effectiveType: string | null;
    rttMs: number | null;
    downlinkMbps: number | null;
    saveData: boolean | null;
    usedJsHeapBytes: number | null;
  };
  connections: {
    activeFetches: number;
    maxConcurrentFetches: number;
    activeEventSources: number;
    activeWebSockets: number;
  };
  fetch: {
    total: number;
    failed: number;
    slow: number;
    byPath: Record<string, number>;
  };
  heartbeat: {
    ticks: number;
    lastDriftMs: number;
    maxDriftMs: number;
  };
  counters: Record<string, number>;
  records: BrowserDiagnosticRecord[];
}

export interface SpaceBrowserDiagnostics {
  report(): BrowserDiagnosticReport;
  clear(): void;
  stop(): void;
}

declare global {
  interface Window {
    __SPACE_DEBUG__?: SpaceBrowserDiagnostics;
  }
}

interface BrowserDiagnosticsOptions {
  maxRecords?: number;
  heartbeatIntervalMs?: number;
  fetchSummaryIntervalMs?: number;
}

type NetworkConnection = {
  effectiveType?: unknown;
  rtt?: unknown;
  downlink?: unknown;
  saveData?: unknown;
};

type PerformanceWithMemory = Performance & {
  memory?: { usedJSHeapSize?: unknown };
};

const DEBUG_QUERY_KEY = "spaceDebug";
const DEBUG_QUERY_VALUE = "1";
const DEFAULT_MAX_RECORDS = 300;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_FETCH_SUMMARY_INTERVAL_MS = 2_000;
const LONG_TASK_THRESHOLD_MS = 50;
const HEARTBEAT_STALL_THRESHOLD_MS = 250;
const SLOW_FETCH_THRESHOLD_MS = 1_000;
const MAX_FETCH_PATHS = 50;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : fallback;
}

function safePath(input: RequestInfo | URL | string): string {
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else raw = input.url;

  try {
    const pathname = new URL(raw, window.location.href).pathname;
    const segments = pathname.split("/").map((segment, index) => {
      if (index === 0 || segment.length === 0) return segment;
      if (/^\d+$/.test(segment)) return ":id";
      if (/%3a|:|^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
      if (segment.length >= 10 && /[A-Z0-9_]/.test(segment) && !/^[a-z][a-z0-9-]*$/.test(segment)) return ":id";
      return segment.slice(0, 40);
    });
    return segments.join("/").slice(0, 180) || "/";
  } catch {
    return "[unparseable]";
  }
}

function targetDetails(target: EventTarget | null): Record<string, DiagnosticValue> {
  if (!(target instanceof Element)) return { target: "non-element" };
  const htmlTarget = target instanceof HTMLElement ? target : null;
  const style = window.getComputedStyle(target);
  return {
    tag: target.tagName.toLowerCase(),
    role: target.getAttribute("role")?.slice(0, 40) ?? null,
    type: target.getAttribute("type")?.slice(0, 30) ?? null,
    disabled: htmlTarget !== null && "disabled" in htmlTarget && Boolean((htmlTarget as HTMLButtonElement).disabled),
    ariaDisabled: target.getAttribute("aria-disabled") === "true",
    pointerEvents: style.pointerEvents,
    zIndex: style.zIndex.slice(0, 20)
  };
}

function reasonDetails(reason: unknown): Record<string, DiagnosticValue> {
  if (reason instanceof Error) return { reasonType: "error", errorName: safeIdentifier(reason.name, "Error") };
  if (reason === null) return { reasonType: "null" };
  return { reasonType: typeof reason };
}

export function installBrowserDiagnostics(options: BrowserDiagnosticsOptions = {}): SpaceBrowserDiagnostics | undefined {
  if (typeof window === "undefined") return undefined;
  if (new URLSearchParams(window.location.search).get(DEBUG_QUERY_KEY) !== DEBUG_QUERY_VALUE) return undefined;
  if (window.__SPACE_DEBUG__) return window.__SPACE_DEBUG__;

  const maxRecords = boundedInteger(options.maxRecords, DEFAULT_MAX_RECORDS, 1, 1_000);
  const heartbeatIntervalMs = boundedInteger(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS, 250, 60_000);
  const fetchSummaryIntervalMs = boundedInteger(options.fetchSummaryIntervalMs, DEFAULT_FETCH_SUMMARY_INTERVAL_MS, 500, 60_000);
  const startedAt = Date.now();
  const startedAtPerformance = performance.now();
  const enabledAt = new Date(startedAt).toISOString();
  const records: BrowserDiagnosticRecord[] = [];
  const counters: Record<string, number> = {};
  const fetchByPath = new Map<string, number>();
  const fetchWindowByPath = new Map<string, number>();
  let sequence = 0;
  let stopped = false;
  let activeFetches = 0;
  let maxConcurrentFetches = 0;
  let activeEventSources = 0;
  let activeWebSockets = 0;
  let fetchTotal = 0;
  let fetchFailed = 0;
  let fetchSlow = 0;
  let fetchWindowTotal = 0;
  let fetchWindowFailed = 0;
  let fetchWindowSlow = 0;
  let fetchWindowMaxConcurrent = 0;
  let heartbeatTicks = 0;
  let lastHeartbeatDrift = 0;
  let maxHeartbeatDrift = 0;

  const record = (kind: string, details: Record<string, DiagnosticValue> = {}, showInConsole = false) => {
    if (stopped) return;
    const entry: BrowserDiagnosticRecord = {
      sequence: ++sequence,
      at: new Date().toISOString(),
      elapsedMs: roundMs(performance.now() - startedAtPerformance),
      kind,
      details
    };
    records.push(entry);
    if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
    counters[kind] = (counters[kind] ?? 0) + 1;
    if (showInConsole) console.info(`[space-debug] ${kind}`, entry);
  };

  const incrementPath = (map: Map<string, number>, path: string) => {
    const key = map.has(path) || map.size < MAX_FETCH_PATHS ? path : "[other]";
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const originalFetch = window.fetch;
  const debugFetch: typeof window.fetch | undefined = typeof originalFetch === "function"
    ? async (input, init) => {
        const requestStarted = performance.now();
        const path = safePath(input);
        const method = safeIdentifier(init?.method ?? (input instanceof Request ? input.method : "GET"), "UNKNOWN").toUpperCase();
        activeFetches += 1;
        fetchTotal += 1;
        fetchWindowTotal += 1;
        maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches);
        fetchWindowMaxConcurrent = Math.max(fetchWindowMaxConcurrent, activeFetches);
        incrementPath(fetchByPath, path);
        incrementPath(fetchWindowByPath, path);
        if (activeFetches === 7 || activeFetches === 12) {
          record("fetch:pressure", { active: activeFetches, method, path }, true);
        }
        try {
          const response = await originalFetch.call(window, input, init);
          const durationMs = performance.now() - requestStarted;
          if (!response.ok) {
            fetchFailed += 1;
            fetchWindowFailed += 1;
            record("fetch:http-error", { method, path, status: response.status, durationMs: roundMs(durationMs) }, true);
          }
          if (durationMs >= SLOW_FETCH_THRESHOLD_MS) {
            fetchSlow += 1;
            fetchWindowSlow += 1;
            record("fetch:slow", { method, path, status: response.status, durationMs: roundMs(durationMs) }, true);
          }
          return response;
        } catch (error) {
          fetchFailed += 1;
          fetchWindowFailed += 1;
          record("fetch:rejected", {
            method,
            path,
            durationMs: roundMs(performance.now() - requestStarted),
            errorName: error instanceof Error ? safeIdentifier(error.name, "Error") : typeof error
          }, true);
          throw error;
        } finally {
          activeFetches = Math.max(0, activeFetches - 1);
        }
      }
    : undefined;
  if (debugFetch) window.fetch = debugFetch;

  const originalEventSource = window.EventSource;
  let DebugEventSource: typeof EventSource | undefined;
  if (typeof originalEventSource === "function") {
    DebugEventSource = class extends originalEventSource {
      readonly #debugPath: string;
      #debugClosed = false;

      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict);
        this.#debugPath = safePath(url);
        activeEventSources += 1;
        record("event-source:construct", { path: this.#debugPath, active: activeEventSources }, true);
        this.addEventListener("open", () => record("event-source:open", { path: this.#debugPath, active: activeEventSources }, true));
        this.addEventListener("error", () => record("event-source:error", { path: this.#debugPath, readyState: this.readyState, active: activeEventSources }, true));
      }

      override close() {
        if (!this.#debugClosed) {
          this.#debugClosed = true;
          activeEventSources = Math.max(0, activeEventSources - 1);
          record("event-source:close", { path: this.#debugPath, active: activeEventSources }, true);
        }
        super.close();
      }
    };
    window.EventSource = DebugEventSource;
  }

  const originalWebSocket = window.WebSocket;
  let DebugWebSocket: typeof WebSocket | undefined;
  if (typeof originalWebSocket === "function") {
    DebugWebSocket = class extends originalWebSocket {
      readonly #debugPath: string;
      #debugClosed = false;

      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        this.#debugPath = safePath(url);
        activeWebSockets += 1;
        record("websocket:construct", { path: this.#debugPath, active: activeWebSockets }, true);
        this.addEventListener("open", () => record("websocket:open", { path: this.#debugPath, active: activeWebSockets }, true));
        this.addEventListener("error", () => record("websocket:error", { path: this.#debugPath, active: activeWebSockets }, true));
        this.addEventListener("close", (event) => {
          if (!this.#debugClosed) {
            this.#debugClosed = true;
            activeWebSockets = Math.max(0, activeWebSockets - 1);
          }
          record("websocket:close", { path: this.#debugPath, code: event.code, clean: event.wasClean, active: activeWebSockets }, true);
        });
      }

      override close(code?: number, reason?: string) {
        record("websocket:close-request", { path: this.#debugPath, code: code ?? null, active: activeWebSockets }, true);
        super.close(code, reason);
      }
    };
    window.WebSocket = DebugWebSocket;
  }

  const onPointerDown = (event: PointerEvent) => {
    record("pointerdown:capture", {
      ...targetDetails(event.target),
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      trusted: event.isTrusted
    }, true);
  };
  const onClick = (event: MouseEvent) => {
    const clickStarted = performance.now();
    const details = targetDetails(event.target);
    record("click:capture", { ...details, trusted: event.isTrusted }, true);
    queueMicrotask(() => record("click:complete", {
      ...details,
      handlerMs: roundMs(performance.now() - clickStarted),
      defaultPrevented: event.defaultPrevented
    }, true));
  };
  const onVisibilityChange = () => record("document:visibility", { state: document.visibilityState }, true);
  const onWindowError = (event: ErrorEvent | Event) => {
    if (event instanceof ErrorEvent) {
      record("error:unhandled", {
        errorName: event.error instanceof Error ? safeIdentifier(event.error.name, "Error") : "ErrorEvent",
        source: event.filename ? safePath(event.filename) : null,
        line: event.lineno,
        column: event.colno
      }, true);
      return;
    }
    record("error:resource", targetDetails(event.target), true);
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => record("rejection:unhandled", reasonDetails(event.reason), true);

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("error", onWindowError, true);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  let expectedHeartbeat = performance.now() + heartbeatIntervalMs;
  const heartbeatTimer = window.setInterval(() => {
    const now = performance.now();
    const drift = Math.max(0, now - expectedHeartbeat);
    expectedHeartbeat = now + heartbeatIntervalMs;
    heartbeatTicks += 1;
    lastHeartbeatDrift = drift;
    maxHeartbeatDrift = Math.max(maxHeartbeatDrift, drift);
    if (drift >= HEARTBEAT_STALL_THRESHOLD_MS) record("heartbeat:stall", { driftMs: roundMs(drift) }, true);
  }, heartbeatIntervalMs);

  const fetchSummaryTimer = window.setInterval(() => {
    if (fetchWindowTotal === 0) return;
    record("fetch:summary", {
      total: fetchWindowTotal,
      failed: fetchWindowFailed,
      slow: fetchWindowSlow,
      maxConcurrent: fetchWindowMaxConcurrent,
      byPath: Object.fromEntries([...fetchWindowByPath.entries()].sort(([a], [b]) => a.localeCompare(b)))
    }, true);
    fetchWindowTotal = 0;
    fetchWindowFailed = 0;
    fetchWindowSlow = 0;
    fetchWindowMaxConcurrent = activeFetches;
    fetchWindowByPath.clear();
  }, fetchSummaryIntervalMs);

  let longTaskObserver: PerformanceObserver | undefined;
  if (typeof window.PerformanceObserver === "function") {
    try {
      longTaskObserver = new window.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_THRESHOLD_MS) {
            record("main-thread:long-task", { durationMs: roundMs(entry.duration), startMs: roundMs(entry.startTime) }, true);
          }
        }
      });
      longTaskObserver.observe({ type: "longtask", buffered: true });
    } catch {
      longTaskObserver = undefined;
    }
  }

  const environment = () => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const connection = (navigator as Navigator & { connection?: NetworkConnection }).connection;
    const memory = (performance as PerformanceWithMemory).memory;
    return {
      navigationProtocol: navigation?.nextHopProtocol || null,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
      effectiveType: typeof connection?.effectiveType === "string" ? connection.effectiveType.slice(0, 30) : null,
      rttMs: safeNumber(connection?.rtt),
      downlinkMbps: safeNumber(connection?.downlink),
      saveData: typeof connection?.saveData === "boolean" ? connection.saveData : null,
      usedJsHeapBytes: safeNumber(memory?.usedJSHeapSize)
    };
  };

  const diagnostics: SpaceBrowserDiagnostics = {
    report: () => ({
      schemaVersion: 1,
      enabledAt,
      uptimeMs: Math.max(0, Date.now() - startedAt),
      environment: environment(),
      connections: { activeFetches, maxConcurrentFetches, activeEventSources, activeWebSockets },
      fetch: {
        total: fetchTotal,
        failed: fetchFailed,
        slow: fetchSlow,
        byPath: Object.fromEntries([...fetchByPath.entries()].sort(([a], [b]) => a.localeCompare(b)))
      },
      heartbeat: { ticks: heartbeatTicks, lastDriftMs: roundMs(lastHeartbeatDrift), maxDriftMs: roundMs(maxHeartbeatDrift) },
      counters: { ...counters },
      records: records.map((entry) => ({ ...entry, details: { ...entry.details } }))
    }),
    clear: () => {
      records.length = 0;
      for (const key of Object.keys(counters)) delete counters[key];
    },
    stop: () => {
      if (stopped) return;
      window.clearInterval(heartbeatTimer);
      window.clearInterval(fetchSummaryTimer);
      longTaskObserver?.disconnect();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("error", onWindowError, true);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      if (debugFetch && window.fetch === debugFetch) window.fetch = originalFetch;
      if (DebugEventSource && window.EventSource === DebugEventSource) window.EventSource = originalEventSource;
      if (DebugWebSocket && window.WebSocket === DebugWebSocket) window.WebSocket = originalWebSocket;
      stopped = true;
      if (window.__SPACE_DEBUG__ === diagnostics) delete window.__SPACE_DEBUG__;
    }
  };

  window.__SPACE_DEBUG__ = diagnostics;
  record("diagnostics:ready", environment(), true);
  return diagnostics;
}
