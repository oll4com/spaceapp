import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDiagnosticsStatus } from "@space/contracts";
import {
  APP_DIAGNOSTICS_HINT_STORAGE_KEY,
  appDiagnosticsSessionIsAuthenticated,
  createAppDiagnosticsBootstrap
} from "../src/app-diagnostics/app-diagnostics-bootstrap.js";
import { clearAuthBootstrapCache, consumeAuthBootstrap } from "../src/auth-bootstrap-cache.js";

const enabledStatus: AppDiagnosticsStatus = {
  isEnabled: true,
  captureId: "app_debug_capture:bootstrap0001",
  enabledAt: "2026-07-24T10:00:00.000Z",
  enabledByUserId: "user:admin",
  retentionHours: 24,
  quotaBytes: 8 * 1024 ** 3,
  technicalQuotaBytes: 512 * 1024 ** 2,
  visualQuotaBytes: 8 * 1024 ** 3 - 512 * 1024 ** 2,
  usage: {
    technicalBytes: 0,
    visualBytes: 0,
    totalBytes: 0,
    segmentCount: 0
  },
  counters: { droppedEvents: 0, quotaDrops: 0, rejectedUploads: 0 },
  recorder: { status: "IDLE" },
  checkedAt: "2026-07-24T10:00:00.000Z"
};

afterEach(() => {
  clearAuthBootstrapCache();
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("app diagnostics bootstrap", () => {
  it("aborts a stalled authentication preflight so the application can mount", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: unknown, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      })) as unknown as typeof fetch;
      const authentication = appDiagnosticsSessionIsAuthenticated(fetchImpl);
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(authentication).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not start protected diagnostics polling for an unauthenticated browser", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      user: null,
      isAuthenticated: false,
      isSetupRequired: false
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(appDiagnosticsSessionIsAuthenticated(fetchImpl)).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("/api/auth/me", { credentials: "include", signal: expect.any(AbortSignal) });
    expect(consumeAuthBootstrap()).toMatchObject({ isAuthenticated: false });
  });

  it("reuses the validated authenticated response during app bootstrap", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      user: { id: "user:admin", email: "admin@example.com", role: "ADMIN" },
      isAuthenticated: true,
      isSetupRequired: false
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(appDiagnosticsSessionIsAuthenticated(fetchImpl)).resolves.toBe(true);
    expect(consumeAuthBootstrap()).toMatchObject({
      isAuthenticated: true,
      user: { id: "user:admin" }
    });
    expect(consumeAuthBootstrap()).toBeNull();
  });

  it("starts the lazy collector before mount from a recent validated local enable hint", async () => {
    window.localStorage.setItem(APP_DIAGNOSTICS_HINT_STORAGE_KEY, JSON.stringify({
      version: 1,
      isEnabled: true,
      captureId: enabledStatus.captureId,
      checkedAt: enabledStatus.checkedAt
    }));
    const collector = {
      stop: vi.fn(),
      record: vi.fn(() => null),
      flushNow: vi.fn(async () => undefined),
      stats: () => ({ isCollecting: true, bufferedEvents: 1, bufferedBytes: 100, droppedEvents: 0, lastSequence: 1 })
    };
    const loadCollector = vi.fn(async () => collector);
    const bootstrap = createAppDiagnosticsBootstrap({
      now: () => new Date("2026-07-24T10:01:00.000Z"),
      fetchStatus: async () => enabledStatus,
      loadCollector,
      pollIntervalMs: 60_000
    });

    const startup = bootstrap.start();
    await startup.beforeMount;

    expect(loadCollector).toHaveBeenCalledWith(expect.objectContaining({
      captureId: enabledStatus.captureId
    }));
    expect(bootstrap.getState()).toMatchObject({
      collector: { isCollecting: true }
    });
    bootstrap.stop();
  });

  it("polls the authoritative state, broadcasts it, and stops capture immediately after OFF", async () => {
    vi.useFakeTimers();
    const statuses: AppDiagnosticsStatus[] = [
      enabledStatus,
      {
        ...enabledStatus,
        isEnabled: false,
        captureId: null,
        enabledAt: null,
        enabledByUserId: null,
        checkedAt: "2026-07-24T10:00:12.000Z"
      }
    ];
    const collector = {
      stop: vi.fn(),
      record: vi.fn(() => null),
      flushNow: vi.fn(async () => undefined),
      stats: () => ({ isCollecting: true, bufferedEvents: 0, bufferedBytes: 0, droppedEvents: 0, lastSequence: 0 })
    };
    const posted: unknown[] = [];
    const channel = {
      postMessage: (value: unknown) => posted.push(value),
      close: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null
    };
    const bootstrap = createAppDiagnosticsBootstrap({
      fetchStatus: async () => statuses.shift()!,
      loadCollector: async () => collector,
      channelFactory: () => channel,
      pollIntervalMs: 12_000
    });

    bootstrap.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(bootstrap.getState().status?.isEnabled).toBe(true));
    expect(posted).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(12_000);
    await vi.waitFor(() => expect(bootstrap.getState().status?.isEnabled).toBe(false));
    expect(collector.stop).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(APP_DIAGNOSTICS_HINT_STORAGE_KEY)).toBeNull();
    bootstrap.stop();
    expect(channel.close).toHaveBeenCalledTimes(1);
  });
});
