import { describe, expect, it, vi } from "vitest";
import { BrowserHostError, type BrowserHostClient, type BrowserHostHealth } from "@space/browser-host";
import type { Pane, PaneBrowserSessionResponse } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { BrowserControlHeldError } from "../src/browser-errors.js";
import {
  browserHostReadiness,
  createBrowserHostProxy,
  createConfiguredBrowserSessionManager
} from "../src/browser-host-proxy.js";
import type { BrowserSessionManager } from "../src/browser-sessions.js";
import { getApiConfig } from "../src/config.js";

const pane = {
  id: "pane:browser-test",
  roomId: "room:browser-test",
  title: "Browser",
  mode: "BROWSER"
} as Pane;

const response = {
  session: {
    sessionId: "browser_session:test",
    paneId: pane.id,
    roomId: pane.roomId
  },
  frame: null,
  websocket: {
    paneId: pane.id,
    sessionId: "browser_session:test",
    token: "host-ticket-that-must-not-leave-the-api",
    expiresAt: "2026-07-12T00:01:00.000Z"
  }
} as PaneBrowserSessionResponse;

function unixConfig() {
  return getApiConfig({
    SPACE_BROWSER_HOST_TRANSPORT: "unix",
    SPACE_RUNTIME_STORE: "postgres",
    SPACE_DATABASE_URL: "postgres://space:test@localhost/space",
    SPACE_BROWSER_SESSIONS_ENABLED: "true"
  });
}

describe("Browser Host API proxy", () => {
  it("keeps in-process as the default and fails closed for Unix without Postgres", () => {
    const store = new InMemorySpaceStore();
    const inProcess = {} as BrowserSessionManager;
    const createInProcess = vi.fn(() => inProcess);
    expect(createConfiguredBrowserSessionManager({ store, config: getApiConfig({}), createInProcess })).toBe(inProcess);
    expect(createInProcess).toHaveBeenCalledOnce();

    expect(() => createConfiguredBrowserSessionManager({
      store,
      config: getApiConfig({ SPACE_BROWSER_HOST_TRANSPORT: "unix" }),
      createInProcess
    })).toThrow(/requires SPACE_RUNTIME_STORE=postgres and SPACE_DATABASE_URL/);
    expect(createInProcess).toHaveBeenCalledOnce();
  });

  it("dispatches input independently of slow host operations and closes both clients", async () => {
    const client = { close: vi.fn(async () => undefined), dispatchInput: vi.fn() } as unknown as BrowserHostClient;
    const inputClient = { close: vi.fn(async () => undefined), dispatchInput: vi.fn(async () => undefined) } as unknown as BrowserHostClient;
    const manager = createBrowserHostProxy({ config: unixConfig(), client, inputClient });
    await manager.dispatchInput!(pane, { type: "KEY", leaseId: "browser_lease:test", eventType: "keyDown", key: "a", modifiers: 0 }, "trace:input");
    expect(inputClient.dispatchInput).toHaveBeenCalledOnce();
    expect(client.dispatchInput).not.toHaveBeenCalled();
    await manager.closeAll();
    expect(inputClient.close).toHaveBeenCalledOnce(); expect(client.close).toHaveBeenCalledOnce();
  });
  it("delegates Unix sessions without a local manager and replaces host frame tickets", async () => {
    const client = {
      startOrRestore: vi.fn(async () => response),
      setViewport: vi.fn(async () => response),
      dispatchInput: vi.fn(async () => undefined),
      stopCapture: vi.fn(async () => ({ jobId: "browser_capture_job:test", status: "COMPLETED" })),
      cancelCapture: vi.fn(async () => ({ jobId: "browser_capture_job:test", status: "CANCELLED" })),
      close: vi.fn(async () => undefined)
    } as unknown as BrowserHostClient;
    const createInProcess = vi.fn();
    const manager = createConfiguredBrowserSessionManager({
      store: new InMemorySpaceStore(),
      config: unixConfig(),
      client,
      createInProcess
    });

    await manager.setViewport(pane, "desktop", "trace:resize", undefined, { width: 800, height: 600 });
    expect(client.setViewport).toHaveBeenCalledWith(pane, "desktop", "trace:resize", undefined, { width: 800, height: 600 });
    const result = await manager.startOrRestore({ pane, traceId: "trace:test" });
    expect(createInProcess).not.toHaveBeenCalled();
    expect(result.websocket?.token).not.toBe(response.websocket?.token);
    expect(manager.acceptFrameTicket(pane.id, response.session.sessionId, result.websocket!.token)).toBe(true);
    expect(manager.acceptFrameTicket(pane.id, response.session.sessionId, result.websocket!.token)).toBe(false);
    await expect(manager.dispatchInput!(
      pane,
      { type: "POINTER", leaseId: "browser_lease:test", eventType: "mouseMoved", x: 10, y: 20 },
      "trace:input",
      { holderType: "OPERATOR", holderId: "user:test" }
    )).resolves.toBeUndefined();
    expect(client.dispatchInput).toHaveBeenCalledWith(
      pane,
      expect.objectContaining({ type: "POINTER", eventType: "mouseMoved" }),
      "trace:input",
      { holderType: "OPERATOR", holderId: "user:test" }
    );
    await expect(manager.stopCapture!(pane, "browser_capture_job:test", "trace:stop")).resolves.toMatchObject({ status: "COMPLETED" });
    await expect(manager.cancelCapture!(pane, "browser_capture_job:test", "trace:cancel")).resolves.toMatchObject({ status: "CANCELLED" });
    expect(client.stopCapture).toHaveBeenCalledWith(pane, "browser_capture_job:test", "trace:stop", undefined);
    expect(client.cancelCapture).toHaveBeenCalledWith(pane, "browser_capture_job:test", "trace:cancel", undefined);
    await manager.closeAll();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("preserves control-held details and keeps a healthy preserved host ready across API commits", async () => {
    const details = {
      sessionId: response.session.sessionId,
      paneId: pane.id,
      roomId: pane.roomId,
      leaseId: "browser_lease:test",
      holderType: "OPERATOR" as const,
      holderId: "user:test",
      expiresAt: "2026-07-12T00:05:00.000Z",
      reason: "captcha"
    };
    const client = {
      action: vi.fn(async () => { throw new BrowserHostError("BROWSER_CONTROL_HELD", "held", details); })
    } as unknown as BrowserHostClient;
    const manager = createBrowserHostProxy({ config: unixConfig(), client });
    await expect(manager.action(pane, { type: "screenshot" }, "trace:test", { holderType: "AGENT", holderId: "agent:test" }))
      .rejects.toMatchObject<BrowserControlHeldError>({ errorCode: "BROWSER_CONTROL_HELD", details });

    const health = {
      hostPid: 123,
      startedAt: "2026-07-12T00:00:00.000Z",
      buildCommit: "a".repeat(40),
      status: { enabled: true, statusReason: "ready", defaultUrl: "https://example.com/", checkedAt: "2026-07-12T00:00:00.000Z" },
      capacity: { activeSessions: 0, maxSessions: 8, activeLiveWorkloads: 0, maxLiveWorkloads: 4 },
      captureMetrics: {
        jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 },
        segments: { OPEN: 0, FINALIZED: 0, FAILED: 0, DISCARDED: 0 }
      }
    } satisfies BrowserHostHealth;
    expect(browserHostReadiness(health, "a".repeat(40))).toBe("RUNNING");
    expect(browserHostReadiness(health, "b".repeat(40))).toBe("RUNNING");
    expect(browserHostReadiness({ ...health, status: { ...health.status, enabled: false } }, "a".repeat(40))).toBe("DISABLED");
    expect(browserHostReadiness({ ...health, capacity: { ...health.capacity, maxLiveWorkloads: 3 } }, "a".repeat(40))).toBe("CAPACITY_MISMATCH");
    expect(browserHostReadiness({ ...health, capacity: null }, "a".repeat(40))).toBe("CAPACITY_MISMATCH");
  });
});
