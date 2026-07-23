import { randomBytes } from "node:crypto";
import {
  BrowserHostClient,
  BrowserHostError,
  type BrowserHostActorContext,
  type BrowserHostHealth
} from "@space/browser-host";
import type { BrowserFrameToken, PaneBrowserSessionResponse } from "@space/contracts";
import { SpaceConflictError, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { BrowserControlHeldError, type BrowserControlHeldDetails } from "./browser-errors.js";
import { createBrowserSessionManager, type BrowserSessionManager } from "./browser-sessions.js";
import type { SpaceApiConfig } from "./config.js";

export interface BrowserSessionManagerWithHostHealth extends BrowserSessionManager {
  browserHostHealth?(): Promise<BrowserHostHealth>;
}

interface LocalFrameTicket {
  paneId: string;
  sessionId: string;
  expiresAt: number;
}

function translateHostError(error: unknown): never {
  if (!(error instanceof BrowserHostError)) throw error;
  if (error.code === "BROWSER_HOST_NOT_FOUND") throw new SpaceNotFoundError(error.message);
  if (error.code === "BROWSER_HOST_CONFLICT") throw new SpaceConflictError(error.message);
  if (error.code === "BROWSER_CONTROL_HELD") {
    throw new BrowserControlHeldError(error.message, error.details as BrowserControlHeldDetails);
  }
  if (
    error.code === "BROWSER_HOST_TIMEOUT" ||
    error.code === "BROWSER_HOST_CONNECT_TIMEOUT" ||
    error.code === "BROWSER_HOST_UNAVAILABLE" ||
    error.code === "BROWSER_HOST_TRANSPORT_CLOSED" ||
    error.code === "BROWSER_HOST_INTERNAL_ERROR"
  ) {
    throw new SpaceFeatureDisabledError("BROWSER_HOST_UNAVAILABLE", "The Browser Host is unavailable.", {
      hostCode: error.code,
      hostDetails: error.details
    });
  }
  throw new SpaceFeatureDisabledError(error.code, error.message, error.details);
}

async function hostCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    translateHostError(error);
  }
}

export function createBrowserHostProxy(options: {
  config: SpaceApiConfig;
  client?: BrowserHostClient;
}): BrowserSessionManagerWithHostHealth {
  const { config } = options;
  const client = options.client ?? new BrowserHostClient({
    socketPath: config.browserHostSocketPath,
    requestTimeoutMs: 30_000,
    healthTimeoutMs: 3_000,
    closeTimeoutMs: 1_000
  });
  const tickets = new Map<string, LocalFrameTicket>();
  let lastHealth: BrowserHostHealth | null = null;

  function issueFrameTicket(paneId: string, sessionId: string, ttlMs: number): BrowserFrameToken {
    const now = Date.now();
    for (const [token, ticket] of tickets) {
      if (ticket.expiresAt <= now) tickets.delete(token);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + ttlMs;
    tickets.set(token, { paneId, sessionId, expiresAt });
    return { paneId, sessionId, token, expiresAt: new Date(expiresAt).toISOString() };
  }

  function withLocalTicket(response: PaneBrowserSessionResponse): PaneBrowserSessionResponse {
    return {
      ...response,
      websocket: response.websocket === null
        ? null
        : issueFrameTicket(response.session.paneId, response.session.sessionId, config.browserSessionsTokenTtlMs)
    };
  }

  return {
    status() {
      return lastHealth?.status ?? {
        enabled: config.browserSessionsEnabled,
        statusReason: "Managed browser sessions are delegated to the Unix Browser Host.",
        defaultUrl: config.browserSessionsDefaultUrl,
        checkedAt: new Date().toISOString()
      };
    },
    capacity: () => lastHealth?.capacity ?? {
      activeSessions: 0,
      maxSessions: 0,
      activeLiveWorkloads: 0,
      maxLiveWorkloads: 0
    },
    async browserHostHealth() {
      lastHealth = await hostCall(() => client.health());
      return lastHealth;
    },
    async startOrRestore(input, context) { return withLocalTicket(await hostCall(() => client.startOrRestore(input, context))); },
    async getActive(pane) {
      const response = await hostCall(() => client.getActive(pane));
      return response ? withLocalTicket(response) : null;
    },
    async navigate(pane, url, traceId, context) { return withLocalTicket(await hostCall(() => client.navigate(pane, url, traceId, context))); },
    async setViewport(pane, viewport, traceId, context) { return withLocalTicket(await hostCall(() => client.setViewport(pane, viewport, traceId, context))); },
    async setStreamMode(pane, mode, traceId, context) { return withLocalTicket(await hostCall(() => client.setStreamMode(pane, mode, traceId, context))); },
    action(pane, input, traceId, context?: BrowserHostActorContext) { return hostCall(() => client.action(pane, input, traceId, context)); },
    captureFrame(sessionId) { return hostCall(() => client.captureFrame(sessionId)); },
    async stopPane(paneId, traceId, context) { await hostCall(() => client.stopPane(paneId, traceId, context)); },
    async stopRoom(roomId, traceId, context) { await hostCall(() => client.stopRoom(roomId, traceId, context)); },
    listPages(pane) { return hostCall(() => client.listPages(pane)); },
    createPage(pane, url, activate, traceId, context) { return hostCall(() => client.createPage(pane, url, activate, traceId, context)); },
    activatePage(pane, pageId, traceId, context) { return hostCall(() => client.activatePage(pane, pageId, traceId, context)); },
    closePage(pane, pageId, traceId, context) { return hostCall(() => client.closePage(pane, pageId, traceId, context)); },
    acquireControl(pane, input, traceId, context) { return hostCall(() => client.acquireControl(pane, input, traceId, context)); },
    heartbeatControl(pane, input, traceId, context) { return hostCall(() => client.heartbeatControl(pane, input, traceId, context)); },
    releaseControl(pane, input, traceId, context) { return hostCall(() => client.releaseControl(pane, input, traceId, context)); },
    dispatchInput(pane, input, traceId, context) { return hostCall(() => client.dispatchInput(pane, input, traceId, context)); },
    input(pane, input, traceId, context) { return hostCall(() => client.input(pane, input, traceId, context)); },
    createCapture(pane, captureOptions, context) { return hostCall(() => client.createCapture(pane, captureOptions, context)); },
    getCapture(pane, jobId) { return hostCall(() => client.getCapture(pane, jobId)); },
    stopCapture(pane, jobId, traceId, context) { return hostCall(() => client.stopCapture(pane, jobId, traceId, context)); },
    cancelCapture(pane, jobId, traceId, context) { return hostCall(() => client.cancelCapture(pane, jobId, traceId, context)); },
    diagnostics(pane, includeNetwork, limit) { return hostCall(() => client.diagnostics(pane, includeNetwork, limit)); },
    startFrameStream(sessionId, mode, onFrame, hints) {
      return hostCall(() => client.startFrameStream(sessionId, mode, onFrame, hints));
    },
    async closeAll() {
      await client.close();
    },
    issueFrameTicket,
    acceptFrameTicket(paneId, sessionId, token) {
      const ticket = tickets.get(token);
      tickets.delete(token);
      return Boolean(ticket && ticket.paneId === paneId && ticket.sessionId === sessionId && ticket.expiresAt > Date.now());
    }
  };
}

export function createConfiguredBrowserSessionManager(options: {
  store: SpaceStore;
  config: SpaceApiConfig;
  client?: BrowserHostClient;
  createInProcess?: typeof createBrowserSessionManager;
}): BrowserSessionManagerWithHostHealth {
  if (options.config.browserHostTransport === "in-process") {
    return (options.createInProcess ?? createBrowserSessionManager)({ store: options.store, config: options.config });
  }
  if (options.config.runtimeStore !== "postgres" || !options.config.databaseUrl) {
    throw new Error("SPACE_BROWSER_HOST_TRANSPORT=unix requires SPACE_RUNTIME_STORE=postgres and SPACE_DATABASE_URL.");
  }
  return createBrowserHostProxy({ config: options.config, client: options.client });
}

export type BrowserHostReadiness = "RUNNING" | "DISABLED" | "CAPACITY_MISMATCH";

export function browserHostReadiness(health: BrowserHostHealth, _expectedCommit: string | null): BrowserHostReadiness {
  if (!health.status.enabled) return "DISABLED";
  if (!health.capacity || health.capacity.maxSessions < 8 || health.capacity.maxLiveWorkloads < 4) {
    return "CAPACITY_MISMATCH";
  }
  return "RUNNING";
}
