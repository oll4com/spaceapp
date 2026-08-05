import {
  appDiagnosticsClientBufferMaxBytes,
  appDiagnosticsClientBufferMaxEvents,
  appDiagnosticsDomSnapshotSchema,
  appDiagnosticsEventBatchMaxBytes,
  appDiagnosticsEventBatchMaxEvents,
  appDiagnosticsEventBatchSchema,
  appDiagnosticsSnapshotMaxElements,
  appDiagnosticsTechnicalEventSchema,
  type AppDiagnosticsDomSnapshot,
  type AppDiagnosticsEventBatch,
  type AppDiagnosticsTechnicalEvent
} from "@space/contracts";
import {
  APP_DIAGNOSTICS_PERFORMANCE_EVENT,
  parseAppDiagnosticsPerformanceDetail
} from "./app-diagnostics-performance.js";

type AppDiagnosticsEventInput = AppDiagnosticsTechnicalEvent extends infer Event
  ? Event extends AppDiagnosticsTechnicalEvent
    ? Omit<Event, "sequence" | "occurredAt">
    : never
  : never;

export interface AppDiagnosticsCollectorStats {
  isCollecting: boolean;
  bufferedEvents: number;
  bufferedBytes: number;
  droppedEvents: number;
  lastSequence: number;
}

export interface AppDiagnosticsCollector {
  record(event: AppDiagnosticsEventInput): number | null;
  flushNow(): Promise<void>;
  stats(): AppDiagnosticsCollectorStats;
  stop(): void;
}

export interface CreateAppDiagnosticsCollectorOptions {
  captureId: string;
  clientId: string;
  upload(batch: AppDiagnosticsEventBatch, signal: AbortSignal): Promise<void>;
  onStats?: (stats: AppDiagnosticsCollectorStats) => void;
  onInactiveCapture?: () => void;
  flushIntervalMs?: number;
  mutationFlushMs?: number;
  maxRetryAttempts?: number;
  now?: () => Date;
}

type UploadFailure = Error & { code?: string };

const dynamicRouteSegmentPattern = /^(?:\d+|[0-9a-f]{8}-[0-9a-f-]{27,}|[A-Za-z0-9_-]{10,})$/i;
const staticRouteSegments = new Set(["client-events"]);
const diagnosticsPathPattern = /^\/api\/(?:auth\/csrf|app-diagnostics|admin\/app-diagnostics)(?:\/|$)/;
const safeNamePattern = /^[A-Za-z][A-Za-z0-9._:-]{0,99}$/;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{5,99}$/;
const safeCorrelationIdPattern = /^(?:correlation|req|request|trace):[A-Za-z0-9_-]{3,80}$/;
const maxSnapshotPayloadBytes = 240 * 1024;
const flickerMutationThreshold = 6;
const flickerWindowMs = 500;
const flickerSnapshotCooldownMs = 2_000;
const structuralRoles = new Set([
  "alert", "button", "cell", "checkbox", "dialog", "form", "grid", "gridcell",
  "heading", "link", "list", "listbox", "listitem", "main", "menu", "menuitem",
  "navigation", "option", "progressbar", "radio", "region", "row", "rowgroup",
  "search", "separator", "slider", "status", "switch", "tab", "table", "tabpanel",
  "textbox", "timer", "toolbar", "tree", "treeitem"
]);
const normalizedErrorNames = new Set([
  "AbortError", "AggregateError", "DOMException", "Error", "EvalError", "InternalError",
  "NetworkError", "NotAllowedError", "RangeError", "ReferenceError", "ResourceError",
  "SyntaxError", "TypeError", "URIError", "UnhandledRejection"
]);
const sensitiveTechnicalNamePattern = /(api[_-]?key|authorization|bearer|cookie|credential|password|secret|session|token)/i;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function createId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID().replaceAll("-", "")}`;
}

function safeName(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== "string") return fallback;
  const candidate = value.slice(0, 100);
  return safeNamePattern.test(candidate) ? candidate : fallback;
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && safeIdPattern.test(value) ? value : undefined;
}

function safeCorrelationId(value: unknown): string | undefined {
  const candidate = safeId(value);
  return candidate &&
    safeCorrelationIdPattern.test(candidate) &&
    !sensitiveTechnicalNamePattern.test(candidate)
    ? candidate
    : undefined;
}

function safeTag(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const tag = target.tagName.toLowerCase().slice(0, 30);
  return /^[a-z][a-z0-9-]*$/.test(tag) ? tag : undefined;
}

function safeRole(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const role = target.getAttribute("role")?.toLowerCase();
  return role && structuralRoles.has(role) ? role : undefined;
}

function safeErrorName(value: unknown, fallback: string): string {
  const name = safeName(value);
  return name && normalizedErrorNames.has(name) ? name : fallback;
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(value) &&
    !sensitiveTechnicalNamePattern.test(value)
    ? value
    : undefined;
}

export function templateAppDiagnosticsPath(input: RequestInfo | URL | string): string {
  let raw: string;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.href;
  else raw = input.url;
  try {
    const pathname = new URL(raw, window.location.href).pathname;
    const normalized = pathname
      .split("/")
      .map((segment, index) => (
        index > 0 &&
        !staticRouteSegments.has(segment) &&
        (dynamicRouteSegmentPattern.test(segment) || sensitiveTechnicalNamePattern.test(segment))
          ? ":id"
          : segment
      ))
      .join("/");
    return normalized.slice(0, 240) || "/";
  } catch {
    return "/";
  }
}

function safeSnapshotStyle(computed: CSSStyleDeclaration): AppDiagnosticsDomSnapshot["nodes"][number]["style"] {
  const display = new Set([
    "block", "contents", "flex", "flow-root", "grid", "inline", "inline-block",
    "inline-flex", "inline-grid", "list-item", "none", "table"
  ]);
  const visibility = new Set(["collapse", "hidden", "visible"]);
  const position = new Set(["absolute", "fixed", "relative", "static", "sticky"]);
  return {
    display: display.has(computed.display) ? computed.display : "other",
    visibility: visibility.has(computed.visibility) ? computed.visibility : "other",
    opacity: /^(?:0|1|0?\.\d{1,4})$/.test(computed.opacity) ? computed.opacity : "other",
    position: position.has(computed.position) ? computed.position : "other",
    transform: computed.transform === "none" ? "none" : "active",
    animationName: computed.animationName === "none" ? "none" : "active",
    transitionProperty: computed.transitionProperty === "none" ? "none" : "active"
  };
}

function eventByteSize(event: AppDiagnosticsTechnicalEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength;
}

function snapshotByteSize(snapshot: AppDiagnosticsDomSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
}

function stackLocations(error: unknown, filename?: string, line?: number, column?: number) {
  const locations: Array<{ file: string; line: number; column?: number }> = [];
  const seen = new Set<string>();
  const add = (file: string, lineNumber: number, columnNumber?: number) => {
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || locations.length >= 12) return;
    const normalized = templateAppDiagnosticsPath(file);
    const key = `${normalized}:${lineNumber}:${columnNumber ?? 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    locations.push({
      file: normalized,
      line: lineNumber,
      ...(Number.isInteger(columnNumber) && columnNumber! > 0 ? { column: columnNumber } : {})
    });
  };
  if (filename && line) add(filename, line, column);
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  for (const row of stack.split("\n").slice(0, 20)) {
    const match = row.match(/(?:\(|\s|^)((?:https?:\/\/|\/)[^)\s]+):(\d+):(\d+)\)?$/);
    if (match) add(match[1]!, Number(match[2]), Number(match[3]));
  }
  return locations;
}

async function createDomSnapshot(
  snapshotId: string,
  anomalySequence: number,
  capturedAt: string
): Promise<AppDiagnosticsDomSnapshot> {
  const elements = document.body
    ? [document.body, ...Array.from(document.body.querySelectorAll("*"))].slice(0, appDiagnosticsSnapshotMaxElements)
    : [];
  const indexes = new Map<Element, number>();
  const nodes: AppDiagnosticsDomSnapshot["nodes"] = [];
  let truncated = elements.length >= appDiagnosticsSnapshotMaxElements;
  let estimatedBytes = 256;
  for (const [elementIndex, element] of elements.entries()) {
    if (elementIndex > 0 && elementIndex % 50 === 0) {
      await new Promise<void>((resolvePromise) => window.setTimeout(resolvePromise, 0));
    }
    const index = nodes.length;
    const tag = safeTag(element);
    if (!tag) continue;
    indexes.set(element, index);
    const computed = window.getComputedStyle(element);
    const node: AppDiagnosticsDomSnapshot["nodes"][number] = {
      index,
      parentIndex: element.parentElement ? indexes.get(element.parentElement) ?? null : null,
      tag,
      ...(safeRole(element) ? { role: safeRole(element) } : {}),
      classes: [],
      style: safeSnapshotStyle(computed)
    };
    const nodeBytes = new TextEncoder().encode(JSON.stringify(node)).byteLength + 1;
    if (estimatedBytes + nodeBytes > maxSnapshotPayloadBytes) {
      truncated = true;
      break;
    }
    nodes.push(node);
    estimatedBytes += nodeBytes;
  }
  let snapshot = appDiagnosticsDomSnapshotSchema.parse({
    snapshotId,
    anomalySequence,
    capturedAt,
    truncated: truncated || elements.length > nodes.length,
    nodes
  });
  while (snapshot.nodes.length && snapshotByteSize(snapshot) > maxSnapshotPayloadBytes) {
    snapshot = appDiagnosticsDomSnapshotSchema.parse({
      ...snapshot,
      truncated: true,
      nodes: snapshot.nodes.slice(0, -1)
    });
  }
  return snapshot;
}

export function createAppDiagnosticsCollector(
  options: CreateAppDiagnosticsCollectorOptions
): AppDiagnosticsCollector {
  const now = options.now ?? (() => new Date());
  const flushIntervalMs = boundedInteger(options.flushIntervalMs, 2_000, 250, 60_000);
  const mutationFlushMs = boundedInteger(options.mutationFlushMs, 250, 10, 2_000);
  const maxRetryAttempts = boundedInteger(options.maxRetryAttempts, 3, 1, 10);
  const events: AppDiagnosticsTechnicalEvent[] = [];
  const snapshots: AppDiagnosticsDomSnapshot[] = [];
  let bufferedBytes = 0;
  let unreportedDroppedEvents = 0;
  let sequence = 0;
  let stopped = false;
  let uploadAttempts = 0;
  let inFlight: Promise<void> | null = null;
  let uploadAbort: AbortController | null = null;
  let pendingBatch: AppDiagnosticsEventBatch | null = null;
  let statsQueued = false;

  const currentStats = (): AppDiagnosticsCollectorStats => ({
    isCollecting: !stopped,
    bufferedEvents: events.length,
    bufferedBytes,
    droppedEvents: unreportedDroppedEvents,
    lastSequence: sequence
  });
  const emitStats = () => {
    if (!options.onStats || statsQueued) return;
    statsQueued = true;
    queueMicrotask(() => {
      statsQueued = false;
      options.onStats?.(currentStats());
    });
  };
  const dropThrough = (lastSequence: number, countAsDropped: boolean) => {
    let removed = 0;
    while (events[0] && events[0].sequence <= lastSequence) {
      bufferedBytes -= eventByteSize(events.shift()!);
      removed += 1;
    }
    for (let index = snapshots.length - 1; index >= 0; index -= 1) {
      if (snapshots[index]!.anomalySequence <= lastSequence) {
        bufferedBytes -= snapshotByteSize(snapshots[index]!);
        snapshots.splice(index, 1);
      }
    }
    bufferedBytes = Math.max(0, bufferedBytes);
    if (countAsDropped) unreportedDroppedEvents += removed;
    emitStats();
  };
  const enforceBufferBounds = () => {
    while (
      events.length > appDiagnosticsClientBufferMaxEvents ||
      bufferedBytes > appDiagnosticsClientBufferMaxBytes
    ) {
      const removableIndex = pendingBatch
        ? events.findIndex((event) => event.sequence > pendingBatch!.lastSequence)
        : 0;
      if (removableIndex < 0) break;
      const [oldest] = events.splice(removableIndex, 1);
      if (!oldest) break;
      bufferedBytes -= eventByteSize(oldest);
      unreportedDroppedEvents += 1;
      for (let index = snapshots.length - 1; index >= 0; index -= 1) {
        if (snapshots[index]!.anomalySequence === oldest.sequence) {
          bufferedBytes -= snapshotByteSize(snapshots[index]!);
          snapshots.splice(index, 1);
        }
      }
    }
    bufferedBytes = Math.max(0, bufferedBytes);
  };

  const record = (input: AppDiagnosticsEventInput): number | null => {
    if (stopped) return null;
    const event = appDiagnosticsTechnicalEventSchema.parse({
      ...input,
      sequence: ++sequence,
      occurredAt: now().toISOString()
    });
    events.push(event);
    bufferedBytes += eventByteSize(event);
    enforceBufferBounds();
    emitStats();
    return event.sequence;
  };

  const addSnapshot = (snapshot: AppDiagnosticsDomSnapshot) => {
    if (stopped || !events.some((event) => event.sequence === snapshot.anomalySequence)) return;
    snapshots.push(snapshot);
    bufferedBytes += snapshotByteSize(snapshot);
    enforceBufferBounds();
    emitStats();
  };

  const buildBatch = (): AppDiagnosticsEventBatch | null => {
    if (!events.length) return null;
    const batchId = createId("app_debug_batch");
    let selectedEvents = events.slice(0, appDiagnosticsEventBatchMaxEvents);
    let selectedSnapshots = snapshots
      .filter((snapshot) => (
        snapshot.anomalySequence >= selectedEvents[0]!.sequence &&
        snapshot.anomalySequence <= selectedEvents.at(-1)!.sequence
      ))
      .slice(0, 4)
      .map((snapshot) => ({ ...snapshot, nodes: [...snapshot.nodes] }));
    const make = () => appDiagnosticsEventBatchSchema.parse({
      captureId: options.captureId,
      clientId: options.clientId,
      batchId,
      firstSequence: selectedEvents[0]!.sequence,
      lastSequence: selectedEvents.at(-1)!.sequence,
      startedAt: selectedEvents[0]!.occurredAt,
      endedAt: selectedEvents.at(-1)!.occurredAt,
      droppedBeforeBatch: unreportedDroppedEvents,
      events: selectedEvents,
      snapshots: selectedSnapshots
    });
    let batch = make();
    while (new TextEncoder().encode(JSON.stringify(batch)).byteLength > appDiagnosticsEventBatchMaxBytes) {
      const snapshot = selectedSnapshots.at(-1);
      if (snapshot?.nodes.length) {
        snapshot.nodes = snapshot.nodes.slice(0, Math.floor(snapshot.nodes.length * 0.75));
      } else if (selectedSnapshots.length) {
        selectedSnapshots = selectedSnapshots.slice(0, -1);
      } else if (selectedEvents.length > 1) {
        selectedEvents = selectedEvents.slice(0, -1);
      } else {
        return null;
      }
      batch = make();
    }
    return batch;
  };

  const flushNow = async (): Promise<void> => {
    if (stopped || inFlight || navigator.onLine === false) {
      await (inFlight ?? Promise.resolve());
      return;
    }
    const batch = pendingBatch ?? buildBatch();
    if (!batch) return;
    pendingBatch = batch;
    uploadAbort = new AbortController();
    inFlight = (async () => {
      try {
        await options.upload(batch, uploadAbort!.signal);
        if (!stopped) {
          uploadAttempts = 0;
          dropThrough(batch.lastSequence, false);
          unreportedDroppedEvents = Math.max(
            0,
            unreportedDroppedEvents - batch.droppedBeforeBatch
          );
          pendingBatch = null;
          emitStats();
        }
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
        const failure = error as UploadFailure;
        if (failure.code === "CAPTURE_INACTIVE") {
          dropThrough(batch.lastSequence, true);
          pendingBatch = null;
          options.onInactiveCapture?.();
          return;
        }
        uploadAttempts += 1;
        if (uploadAttempts >= maxRetryAttempts) {
          uploadAttempts = 0;
          dropThrough(batch.lastSequence, true);
          pendingBatch = null;
        }
      } finally {
        uploadAbort = null;
        inFlight = null;
      }
    })();
    await inFlight;
  };

  const originalFetch = window.fetch;
  const instrumentedFetch: typeof window.fetch = async (input, init) => {
    const pathTemplate = templateAppDiagnosticsPath(input);
    if (diagnosticsPathPattern.test(pathTemplate)) {
      return originalFetch.call(window, input, init);
    }
    const startedAt = performance.now();
    const method = safeName(
      (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
      "GET"
    ) as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
    record({ category: "NETWORK", transport: "HTTP", phase: "OPEN", method, pathTemplate });
    try {
      const response = await originalFetch.call(window, input, init);
      const correlationId = safeCorrelationId(response.headers.get("x-request-id"));
      record({
        category: "NETWORK",
        transport: "HTTP",
        phase: "COMPLETE",
        method,
        pathTemplate,
        status: response.status,
        durationMs: Math.max(0, performance.now() - startedAt),
        ...(correlationId ? { correlationId } : {})
      });
      return response;
    } catch (error) {
      record({
        category: "NETWORK",
        transport: "HTTP",
        phase: "ERROR",
        method,
        pathTemplate,
        durationMs: Math.max(0, performance.now() - startedAt)
      });
      throw error;
    }
  };
  if (typeof originalFetch === "function") window.fetch = instrumentedFetch;

  const originalEventSource = window.EventSource;
  let InstrumentedEventSource: typeof EventSource | null = null;
  if (typeof originalEventSource === "function") {
    InstrumentedEventSource = class extends originalEventSource {
      readonly #pathTemplate: string;
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(url, eventSourceInitDict);
        this.#pathTemplate = templateAppDiagnosticsPath(url);
        record({ category: "NETWORK", transport: "SSE", phase: "OPEN", pathTemplate: this.#pathTemplate });
        this.addEventListener("error", () => {
          record({ category: "NETWORK", transport: "SSE", phase: "ERROR", pathTemplate: this.#pathTemplate });
        });
      }
      override close() {
        record({ category: "NETWORK", transport: "SSE", phase: "CLOSE", pathTemplate: this.#pathTemplate });
        super.close();
      }
    };
    window.EventSource = InstrumentedEventSource;
  }

  const originalWebSocket = window.WebSocket;
  let InstrumentedWebSocket: typeof WebSocket | null = null;
  if (typeof originalWebSocket === "function") {
    InstrumentedWebSocket = class extends originalWebSocket {
      readonly #pathTemplate: string;
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url);
        else super(url, protocols);
        this.#pathTemplate = templateAppDiagnosticsPath(url);
        record({ category: "NETWORK", transport: "WEBSOCKET", phase: "OPEN", pathTemplate: this.#pathTemplate });
        this.addEventListener("error", () => {
          record({ category: "NETWORK", transport: "WEBSOCKET", phase: "ERROR", pathTemplate: this.#pathTemplate });
        });
        this.addEventListener("close", () => {
          record({ category: "NETWORK", transport: "WEBSOCKET", phase: "CLOSE", pathTemplate: this.#pathTemplate });
        });
      }
    };
    window.WebSocket = InstrumentedWebSocket;
  }

  let frameClockResetPending = document.visibilityState === "hidden";
  const onVisibility = () => {
    frameClockResetPending = true;
    record({
      category: "LIFECYCLE",
      event: "VISIBILITY",
      visibilityState: document.visibilityState
    });
  };
  const onPerformanceMetric = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = parseAppDiagnosticsPerformanceDetail(event.detail);
    if (detail) record(detail);
  };
  const onPageShow = () => record({ category: "LIFECYCLE", event: "PAGE_SHOW" });
  const onPageHide = () => record({ category: "LIFECYCLE", event: "PAGE_HIDE" });
  const onPointer = (event: PointerEvent) => record({
    category: "INTERACTION",
    event: "POINTER",
    ...(safeTag(event.target) ? { elementTag: safeTag(event.target) } : {}),
    ...(safeRole(event.target) ? { role: safeRole(event.target) } : {}),
    ...(["mouse", "pen", "touch"].includes(event.pointerType) ? {
      pointerType: event.pointerType as "mouse" | "pen" | "touch"
    } : {})
  });
  const onKeyboard = (event: KeyboardEvent) => record({
    category: "INTERACTION",
    event: "KEYBOARD",
    ...(safeTag(event.target) ? { elementTag: safeTag(event.target) } : {}),
    ...(safeRole(event.target) ? { role: safeRole(event.target) } : {})
  });
  const onFocus = (event: FocusEvent) => record({
    category: "INTERACTION",
    event: event.type === "focusin" ? "FOCUS" : "BLUR",
    ...(safeTag(event.target) ? { elementTag: safeTag(event.target) } : {}),
    ...(safeRole(event.target) ? { role: safeRole(event.target) } : {})
  });
  const onSelection = (event: MouseEvent) => {
    const element = event.target instanceof Element ? event.target : null;
    const runtime = element?.closest<HTMLElement>("[data-room-runtime-id]");
    const room = element?.closest<HTMLElement>("[data-space-room-id], [data-room-id]");
    const pane = element?.closest<HTMLElement>("[data-space-pane-id], [data-pane-id]");
    const settings = element?.closest(".settings-dock, [data-diagnostics-surface='SETTINGS']");
    if (!runtime && !room && !pane && !settings) return;
    const roomId = safeId(
      runtime?.dataset.roomRuntimeId ??
      pane?.dataset.spaceRoomId ??
      room?.dataset.spaceRoomId ??
      room?.dataset.roomId
    );
    const paneId = safeId(pane?.dataset.spacePaneId ?? pane?.dataset.paneId);
    record({
      category: "SELECTION",
      surface: settings ? "SETTINGS" : pane ? "PANE" : "ROOM",
      ...(roomId ? { roomId } : {}),
      ...(paneId ? { paneId } : {})
    });
  };
  const onError = (event: ErrorEvent | Event) => {
    const error = event instanceof ErrorEvent ? event.error : null;
    const name = event instanceof ErrorEvent
      ? safeErrorName(error instanceof Error ? error.name : "Error", "Error")
      : "ResourceError";
    record({
      category: "ERROR",
      name,
      ...(safeErrorCode((error as { code?: unknown } | null)?.code) ? {
        code: safeErrorCode((error as { code?: unknown }).code)
      } : {}),
      stackLocations: event instanceof ErrorEvent
        ? stackLocations(error, event.filename, event.lineno, event.colno)
        : []
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    record({
      category: "ERROR",
      name: safeErrorName(reason instanceof Error ? reason.name : "UnhandledRejection", "Error"),
      ...(safeErrorCode((reason as { code?: unknown } | null)?.code) ? {
        code: safeErrorCode((reason as { code?: unknown }).code)
      } : {}),
      stackLocations: stackLocations(reason)
    });
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener(APP_DIAGNOSTICS_PERFORMANCE_EVENT, onPerformanceMetric);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKeyboard, true);
  document.addEventListener("focusin", onFocus, true);
  document.addEventListener("focusout", onFocus, true);
  document.addEventListener("click", onSelection, true);
  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onUnhandledRejection);

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);
  const recordNavigation = (event: "PUSH" | "REPLACE" | "POP" | "HASH") => {
    record({ category: "NAVIGATION", event, pathTemplate: templateAppDiagnosticsPath(window.location.href) });
  };
  history.pushState = ((...args: Parameters<History["pushState"]>) => {
    originalPushState(...args);
    recordNavigation("PUSH");
  }) as History["pushState"];
  history.replaceState = ((...args: Parameters<History["replaceState"]>) => {
    originalReplaceState(...args);
    recordNavigation("REPLACE");
  }) as History["replaceState"];
  const onPopState = () => recordNavigation("POP");
  const onHashChange = () => recordNavigation("HASH");
  window.addEventListener("popstate", onPopState);
  window.addEventListener("hashchange", onHashChange);

  const onVisualEvent = (event: Event) => {
    const names = {
      animationstart: "ANIMATION_START",
      animationend: "ANIMATION_END",
      transitionstart: "TRANSITION_START",
      transitionend: "TRANSITION_END"
    } as const;
    const visual = names[event.type as keyof typeof names];
    if (!visual) return;
    const animation = event as AnimationEvent;
    const transition = event as TransitionEvent;
    record({
      category: "VISUAL",
      event: visual,
      ...(safeTag(event.target) ? { elementTag: safeTag(event.target) } : {}),
      ...(safeRole(event.target) ? { role: safeRole(event.target) } : {}),
      ...(event.type.startsWith("animation") && animation.animationName ? {
        propertyName: animation.animationName === "none" ? "none" : "active"
      } : {}),
      ...(event.type.startsWith("transition") && transition.propertyName ? {
        propertyName: transition.propertyName.startsWith("--")
          ? "custom-property"
          : /^[a-z][a-z-]{0,63}$/.test(transition.propertyName)
            ? transition.propertyName
            : "other"
      } : {})
    });
  };
  for (const type of ["animationstart", "animationend", "transitionstart", "transitionend"]) {
    document.addEventListener(type, onVisualEvent, true);
  }

  let mutationTimer: number | null = null;
  let mutationWindowStartedAt = 0;
  let rootMounted = Boolean(document.getElementById("root")?.childElementCount);
  let addedNodes = 0;
  let removedNodes = 0;
  let attributeChanges = 0;
  let visibilityChanges = 0;
  let lastFlickerSnapshotAt = -Infinity;
  const flushMutations = () => {
    mutationTimer = null;
    const total = addedNodes + removedNodes + attributeChanges;
    if (total === 0) return;
    record({
      category: "VISUAL",
      event: "DOM_MUTATION",
      addedNodes: Math.min(appDiagnosticsSnapshotMaxElements, addedNodes),
      removedNodes: Math.min(appDiagnosticsSnapshotMaxElements, removedNodes),
      attributeChanges: Math.min(appDiagnosticsSnapshotMaxElements, attributeChanges)
    });
    const elapsed = Math.max(1, performance.now() - mutationWindowStartedAt);
    const churn = attributeChanges >= flickerMutationThreshold
      ? visibilityChanges >= flickerMutationThreshold ? "VISIBILITY_CHURN" : "STYLE_CHURN"
      : addedNodes + removedNodes >= flickerMutationThreshold ? "REMOUNT_CHURN" : null;
    if (churn) {
      record({
        category: "ANOMALY",
        anomaly: churn,
        occurrenceCount: Math.min(10_000, Math.max(2, total)),
        windowMs: Math.min(60_000, Math.ceil(elapsed))
      });
      if (
        total >= flickerMutationThreshold &&
        performance.now() - lastFlickerSnapshotAt >= flickerSnapshotCooldownMs
      ) {
        const snapshotId = createId("app_debug_snapshot");
        const anomalySequence = record({
          category: "ANOMALY",
          anomaly: "FLICKER",
          occurrenceCount: Math.min(10_000, Math.max(2, total)),
          windowMs: Math.min(60_000, Math.ceil(elapsed)),
          snapshotId
        });
        if (anomalySequence !== null) {
          const capturedAt = now().toISOString();
          void createDomSnapshot(snapshotId, anomalySequence, capturedAt).then(addSnapshot);
          lastFlickerSnapshotAt = performance.now();
        }
      }
    }
    addedNodes = 0;
    removedNodes = 0;
    attributeChanges = 0;
    visibilityChanges = 0;
  };
  const mutationObserver = typeof MutationObserver === "function"
    ? new MutationObserver((records) => {
        if (mutationTimer === null) mutationWindowStartedAt = performance.now();
        for (const mutation of records) {
          if (
            mutation.target instanceof Element &&
            mutation.target.closest(".terminal-xterm, .xterm")
          ) {
            continue;
          }
          addedNodes += mutation.addedNodes.length;
          removedNodes += mutation.removedNodes.length;
          if (mutation.type === "attributes") {
            attributeChanges += 1;
            if (mutation.attributeName === "hidden" || mutation.attributeName === "style") visibilityChanges += 1;
          }
          if (mutation.type === "childList" && mutation.target === document.getElementById("root")) {
            const nextMounted = Boolean((mutation.target as Element).childElementCount);
            if (nextMounted !== rootMounted) {
              rootMounted = nextMounted;
              record({ category: "LIFECYCLE", event: nextMounted ? "MOUNT" : "UNMOUNT" });
            }
          }
        }
        if (mutationTimer !== null) window.clearTimeout(mutationTimer);
        mutationTimer = window.setTimeout(flushMutations, mutationFlushMs);
      })
    : null;
  mutationObserver?.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-hidden"]
  });

  let performanceObserver: PerformanceObserver | null = null;
  if (typeof PerformanceObserver === "function") {
    try {
      performanceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === "longtask") {
            record({ category: "PERFORMANCE", metric: "LONG_TASK", durationMs: entry.duration });
          } else if (entry.entryType === "layout-shift") {
            const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
            record({
              category: "PERFORMANCE",
              metric: "LAYOUT_SHIFT",
              value: Math.max(0, shift.value ?? 0),
              hadRecentInput: Boolean(shift.hadRecentInput)
            });
          }
        }
      });
      performanceObserver.observe({ entryTypes: ["longtask", "layout-shift"] });
    } catch {
      performanceObserver = null;
    }
  }

  let animationFrame = 0;
  let previousFrame = performance.now();
  const measureFrame = (timestamp: number) => {
    if (document.visibilityState === "hidden" || frameClockResetPending) {
      previousFrame = timestamp;
      frameClockResetPending = document.visibilityState === "hidden";
      animationFrame = window.requestAnimationFrame(measureFrame);
      return;
    }
    const durationMs = timestamp - previousFrame;
    previousFrame = timestamp;
    if (durationMs > 100) record({ category: "PERFORMANCE", metric: "FRAME_STALL", durationMs });
    animationFrame = window.requestAnimationFrame(measureFrame);
  };
  if (typeof window.requestAnimationFrame === "function") {
    animationFrame = window.requestAnimationFrame(measureFrame);
  }

  const flushTimer = window.setInterval(() => void flushNow(), flushIntervalMs);
  const onOnline = () => void flushNow();
  window.addEventListener("online", onOnline);
  record({ category: "LIFECYCLE", event: "BOOTSTRAP" });
  if (document.getElementById("root")?.childElementCount) {
    record({ category: "LIFECYCLE", event: "MOUNT" });
  }
  emitStats();

  const collector: AppDiagnosticsCollector = {
    record,
    flushNow,
    stats: currentStats,
    stop: () => {
      if (stopped) return;
      stopped = true;
      uploadAbort?.abort();
      window.clearInterval(flushTimer);
      if (mutationTimer !== null) window.clearTimeout(mutationTimer);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      mutationObserver?.disconnect();
      performanceObserver?.disconnect();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(APP_DIAGNOSTICS_PERFORMANCE_EVENT, onPerformanceMetric);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKeyboard, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", onFocus, true);
      document.removeEventListener("click", onSelection, true);
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
      for (const type of ["animationstart", "animationend", "transitionstart", "transitionend"]) {
        document.removeEventListener(type, onVisualEvent, true);
      }
      if (window.fetch === instrumentedFetch) window.fetch = originalFetch;
      if (InstrumentedEventSource && window.EventSource === InstrumentedEventSource) {
        window.EventSource = originalEventSource;
      }
      if (InstrumentedWebSocket && window.WebSocket === InstrumentedWebSocket) {
        window.WebSocket = originalWebSocket;
      }
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      events.length = 0;
      snapshots.length = 0;
      pendingBatch = null;
      bufferedBytes = 0;
      emitStats();
    }
  };
  return collector;
}
