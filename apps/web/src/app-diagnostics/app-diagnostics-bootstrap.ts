import {
  appDiagnosticsStatusSchema,
  type AppDiagnosticsEventBatch,
  type AppDiagnosticsStatus
} from "@space/contracts";
import type {
  AppDiagnosticsCollector,
  AppDiagnosticsCollectorStats
} from "./app-diagnostics-collector.js";

export const APP_DIAGNOSTICS_HINT_STORAGE_KEY = "space.appDiagnostics.enabledHint.v1";
export const APP_DIAGNOSTICS_CLIENT_ID_STORAGE_KEY = "space.appDiagnostics.clientId.v1";
export const APP_DIAGNOSTICS_STATE_EVENT = "space:app-diagnostics-state";

const appDiagnosticsBroadcastChannelName = "space.app-diagnostics.v1";
const hintMaxAgeMs = 5 * 60_000;
const pollIntervalDefaultMs = 12_000;
const diagnosticsIdPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{5,99}$/;

export interface AppDiagnosticsClientState {
  status: AppDiagnosticsStatus | null;
  collector: AppDiagnosticsCollectorStats;
  lastErrorCode: string | null;
}

interface DiagnosticsChannel {
  postMessage(value: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

interface CollectorLoadInput {
  captureId: string;
  clientId: string;
  upload(batch: AppDiagnosticsEventBatch, signal: AbortSignal): Promise<void>;
  onStats(stats: AppDiagnosticsCollectorStats): void;
  onInactiveCapture(): void;
}

interface CreateAppDiagnosticsBootstrapOptions {
  storage?: Storage;
  now?: () => Date;
  pollIntervalMs?: number;
  fetchStatus?: () => Promise<AppDiagnosticsStatus>;
  loadCollector?: (input: CollectorLoadInput) => Promise<AppDiagnosticsCollector>;
  channelFactory?: () => DiagnosticsChannel | null;
}

export interface AppDiagnosticsBootstrap {
  start(): { beforeMount: Promise<void> };
  refresh(): Promise<void>;
  applyStatus(status: AppDiagnosticsStatus, broadcast?: boolean): Promise<void>;
  getState(): AppDiagnosticsClientState;
  stop(): void;
}

type Hint = {
  version: 1;
  isEnabled: true;
  captureId: string;
  checkedAt: string;
};

class DiagnosticsHttpError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "DiagnosticsHttpError";
  }
}

function emptyCollectorStats(): AppDiagnosticsCollectorStats {
  return { isCollecting: false, bufferedEvents: 0, bufferedBytes: 0, droppedEvents: 0, lastSequence: 0 };
}

function parseHint(storage: Storage, now: Date): Hint | null {
  try {
    const parsed = JSON.parse(storage.getItem(APP_DIAGNOSTICS_HINT_STORAGE_KEY) ?? "null") as Partial<Hint> | null;
    if (
      parsed?.version !== 1 ||
      parsed.isEnabled !== true ||
      typeof parsed.captureId !== "string" ||
      !diagnosticsIdPattern.test(parsed.captureId) ||
      typeof parsed.checkedAt !== "string"
    ) {
      storage.removeItem(APP_DIAGNOSTICS_HINT_STORAGE_KEY);
      return null;
    }
    const checkedAt = Date.parse(parsed.checkedAt);
    const age = now.getTime() - checkedAt;
    if (!Number.isFinite(checkedAt) || age < -60_000 || age > hintMaxAgeMs) {
      storage.removeItem(APP_DIAGNOSTICS_HINT_STORAGE_KEY);
      return null;
    }
    return parsed as Hint;
  } catch {
    return null;
  }
}

function clientId(storage: Storage): string {
  const stored = storage.getItem(APP_DIAGNOSTICS_CLIENT_ID_STORAGE_KEY);
  if (stored && diagnosticsIdPattern.test(stored)) return stored;
  const created = `app_debug_client:${crypto.randomUUID().replaceAll("-", "")}`;
  storage.setItem(APP_DIAGNOSTICS_CLIENT_ID_STORAGE_KEY, created);
  return created;
}

export function getAppDiagnosticsClientId(storage: Storage = window.localStorage): string {
  return clientId(storage);
}

function defaultChannelFactory(): DiagnosticsChannel | null {
  return typeof BroadcastChannel === "function"
    ? new BroadcastChannel(appDiagnosticsBroadcastChannelName)
    : null;
}

function createHttpTransport(fetchImpl: typeof fetch) {
  let csrfToken: string | null = null;
  let csrfHeaderName = "x-space-csrf-token";
  const parseResponse = async (response: Response): Promise<unknown> => {
    const raw = await response.text();
    if (!raw) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };
  const csrf = async (signal?: AbortSignal) => {
    if (csrfToken) return csrfToken;
    const response = await fetchImpl("/api/auth/csrf", { credentials: "include", signal });
    const payload = await parseResponse(response) as { csrfToken?: unknown; headerName?: unknown } | null;
    if (
      !response.ok ||
      typeof payload?.csrfToken !== "string" ||
      typeof payload.headerName !== "string"
    ) {
      throw new DiagnosticsHttpError("CSRF_UNAVAILABLE", response.status);
    }
    csrfToken = payload.csrfToken;
    csrfHeaderName = payload.headerName;
    return csrfToken;
  };
  return {
    fetchStatus: async () => {
      const response = await fetchImpl("/api/app-diagnostics", { credentials: "include" });
      const payload = await parseResponse(response);
      if (!response.ok) {
        const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
        throw new DiagnosticsHttpError(typeof code === "string" ? code : "STATUS_UNAVAILABLE", response.status);
      }
      return appDiagnosticsStatusSchema.parse(payload);
    },
    upload: async (batch: AppDiagnosticsEventBatch, signal: AbortSignal) => {
      const send = async () => fetchImpl("/api/app-diagnostics/event-batches", {
        method: "POST",
        credentials: "include",
        signal,
        headers: {
          "Content-Type": "application/json",
          [csrfHeaderName]: await csrf(signal)
        },
        body: JSON.stringify(batch)
      });
      let response = await send();
      if (response.status === 403) {
        csrfToken = null;
        response = await send();
      }
      const payload = await parseResponse(response);
      if (!response.ok) {
        const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
        throw new DiagnosticsHttpError(typeof code === "string" ? code : "UPLOAD_FAILED", response.status);
      }
    }
  };
}

export function createAppDiagnosticsBootstrap(
  options: CreateAppDiagnosticsBootstrapOptions = {}
): AppDiagnosticsBootstrap {
  const storage = options.storage ?? window.localStorage;
  const now = options.now ?? (() => new Date());
  const pollIntervalMs = Math.min(15_000, Math.max(10_000, options.pollIntervalMs ?? pollIntervalDefaultMs));
  const nativeFetch = window.fetch.bind(window);
  const transport = createHttpTransport(nativeFetch);
  const fetchStatus = options.fetchStatus ?? transport.fetchStatus;
  const loadCollector = options.loadCollector ?? (async (input) => {
    const { createAppDiagnosticsCollector } = await import("./app-diagnostics-collector.js");
    return createAppDiagnosticsCollector(input);
  });
  const channelFactory = options.channelFactory ?? defaultChannelFactory;
  let state: AppDiagnosticsClientState = {
    status: null,
    collector: emptyCollectorStats(),
    lastErrorCode: null
  };
  let collector: AppDiagnosticsCollector | null = null;
  let collectorCaptureId: string | null = null;
  let collectorFlight: Promise<void> | null = null;
  let channel: DiagnosticsChannel | null = null;
  let pollTimer: number | null = null;
  let started = false;
  let stopped = false;

  const emit = () => {
    window.dispatchEvent(new CustomEvent<AppDiagnosticsClientState>(
      APP_DIAGNOSTICS_STATE_EVENT,
      { detail: state }
    ));
  };
  const updateCollectorStats = (stats: AppDiagnosticsCollectorStats) => {
    state = { ...state, collector: stats };
    emit();
  };
  const stopCollector = () => {
    collector?.stop();
    collector = null;
    collectorCaptureId = null;
    collectorFlight = null;
    state = { ...state, collector: emptyCollectorStats() };
    emit();
  };
  const ensureCollector = async (captureId: string) => {
    if (stopped || collectorCaptureId === captureId && collector) return;
    if (collectorFlight && collectorCaptureId === captureId) return collectorFlight;
    if (collector && collectorCaptureId !== captureId) stopCollector();
    collectorCaptureId = captureId;
    collectorFlight = loadCollector({
      captureId,
      clientId: clientId(storage),
      upload: transport.upload,
      onStats: updateCollectorStats,
      onInactiveCapture: () => void bootstrap.refresh()
    }).then((loaded) => {
      if (stopped || collectorCaptureId !== captureId) {
        loaded.stop();
        return;
      }
      collector = loaded;
      state = { ...state, collector: loaded.stats() };
      emit();
    }).catch((error) => {
      collectorCaptureId = null;
      const code = error instanceof DiagnosticsHttpError ? error.code : "COLLECTOR_LOAD_FAILED";
      state = { ...state, lastErrorCode: code, collector: emptyCollectorStats() };
      emit();
    }).finally(() => {
      collectorFlight = null;
    });
    return collectorFlight;
  };

  const bootstrap: AppDiagnosticsBootstrap = {
    start: () => {
      if (started) return { beforeMount: collectorFlight ?? Promise.resolve() };
      started = true;
      channel = channelFactory();
      if (channel) {
        channel.onmessage = (event) => {
          const candidate = (event.data as { type?: unknown; status?: unknown } | null);
          if (candidate?.type !== "STATUS") return;
          const parsed = appDiagnosticsStatusSchema.safeParse(candidate.status);
          if (parsed.success) void bootstrap.applyStatus(parsed.data, false);
        };
      }
      const hint = parseHint(storage, now());
      const beforeMount = hint ? ensureCollector(hint.captureId) : Promise.resolve();
      void bootstrap.refresh();
      pollTimer = window.setInterval(() => void bootstrap.refresh(), pollIntervalMs);
      return { beforeMount };
    },
    refresh: async () => {
      if (stopped) return;
      try {
        const status = await fetchStatus();
        await bootstrap.applyStatus(status, true);
      } catch (error) {
        const code = error instanceof DiagnosticsHttpError ? error.code : "STATUS_UNAVAILABLE";
        if (error instanceof DiagnosticsHttpError && (error.status === 401 || error.status === 403)) {
          storage.removeItem(APP_DIAGNOSTICS_HINT_STORAGE_KEY);
          stopCollector();
        }
        state = { ...state, lastErrorCode: code };
        emit();
      }
    },
    applyStatus: async (input, broadcast = true) => {
      if (stopped) return;
      const status = appDiagnosticsStatusSchema.parse(input);
      state = { ...state, status, lastErrorCode: null };
      if (status.isEnabled && status.captureId) {
        storage.setItem(APP_DIAGNOSTICS_HINT_STORAGE_KEY, JSON.stringify({
          version: 1,
          isEnabled: true,
          captureId: status.captureId,
          checkedAt: status.checkedAt
        } satisfies Hint));
        await ensureCollector(status.captureId);
      } else {
        storage.removeItem(APP_DIAGNOSTICS_HINT_STORAGE_KEY);
        stopCollector();
      }
      if (broadcast) channel?.postMessage({ type: "STATUS", status });
      emit();
    },
    getState: () => ({
      ...state,
      collector: { ...state.collector },
      status: state.status ? { ...state.status } : null
    }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      channel?.close();
      channel = null;
      stopCollector();
    }
  };
  return bootstrap;
}

let defaultBootstrap: AppDiagnosticsBootstrap | null = null;

export function startAppDiagnosticsBootstrap(): { beforeMount: Promise<void> } {
  defaultBootstrap ??= createAppDiagnosticsBootstrap();
  return defaultBootstrap.start();
}

export function getAppDiagnosticsClientState(): AppDiagnosticsClientState {
  return defaultBootstrap?.getState() ?? {
    status: null,
    collector: emptyCollectorStats(),
    lastErrorCode: null
  };
}

export function refreshAppDiagnosticsStatus(): Promise<void> {
  return defaultBootstrap?.refresh() ?? Promise.resolve();
}

export function applyAppDiagnosticsStatus(status: AppDiagnosticsStatus): Promise<void> {
  return defaultBootstrap?.applyStatus(status, true) ?? Promise.resolve();
}
