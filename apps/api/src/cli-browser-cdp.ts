import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket as WsClient, type RawData, type WebSocket as WsSocket } from "ws";
import type { Pane, PaneBrowserSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import {
  cliBrowserBridgeEnabled,
  cliBrowserBridgeTokenHeader,
  verifyCliBrowserBridgeToken,
  type CliBrowserBridgeTokenPayload
} from "./cli-browser-bridge.js";
import type { SpaceApiConfig } from "./config.js";
import { isT3AgentSessionId, t3AgentPrincipal } from "./t3code/agent-tokens.js";
import { harnessAgentPrincipal, isHarnessAgentSessionId } from "./harness-agent-tokens.js";

// CLI sessions run in their own network namespaces, so the managed Chrome's
// loopback DevTools port is reachable only from the API. This proxy pipes a
// pane-scoped CDP WebSocket to that port so element-level tooling (Playwright
// MCP) drives the same browser the operator sees in the pane. The live view,
// recording and operator handoff stay with Space: connections are refused and
// dropped while an operator holds the control lease.
export const cliBrowserCdpPath = "/api/cli/browser/cdp";
export const cliBrowserCdpStatusPath = "/api/cli/browser/cdp/status";

/** Application close codes mirror the HTTP status an operator would expect. */
export const cliBrowserCdpCloseCodes = Object.freeze({
  TOKEN_INVALID: 4401,
  BRIDGE_DISABLED: 4403,
  PANE_NOT_FOUND: 4404,
  BROWSER_NOT_RUNNING: 4409,
  BROWSER_CONTROL_HELD: 4423,
  // A Vault-protected browser (vault/protection.ts) has no automation endpoint.
  VAULT_PROTECTED: 4424,
  ENDPOINT_UNAVAILABLE: 4502
});
export type CliBrowserCdpRefusal = keyof typeof cliBrowserCdpCloseCodes;

const paneIdPattern = /^pane:[A-Za-z0-9_-]{6,80}$/;

/** Chrome writes "<port>\n<browser websocket path>" once DevTools listens on the loopback port. */
export async function readChromeAutomationEndpoint(profilePath: string): Promise<string | null> {
  try {
    const [port, path] = (await readFile(join(profilePath, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
    if (!port || !/^\d{2,5}$/.test(port) || !path?.startsWith("/devtools/browser/")) return null;
    return `ws://127.0.0.1:${port}${path}`;
  } catch {
    return null;
  }
}

export interface CliBrowserCdpResolution {
  claims: CliBrowserBridgeTokenPayload;
  pane: Pane;
  session: PaneBrowserSession;
}
export interface CliBrowserCdpRefused {
  refused: CliBrowserCdpRefusal;
  reason: string;
}

export interface CliBrowserCdpProxyOptions {
  store: SpaceStore;
  config: Pick<SpaceApiConfig, "browserToolBridgeEnabled" | "internalApiToken">;
  isBrowserPane(pane: Pick<Pane, "mode">): boolean;
  assertRuntimeEnabled?(runtimeId: string): Promise<void>;
  readEndpoint?(session: PaneBrowserSession): Promise<string | null>;
  onConnected?(request: FastifyRequest, resolution: CliBrowserCdpResolution): Promise<void> | void;
  log?: { warn(obj: unknown, msg?: string): void };
}

export interface CliBrowserCdpProxy {
  resolve(request: FastifyRequest): Promise<CliBrowserCdpResolution | CliBrowserCdpRefused>;
  register(app: FastifyInstance, routeOptions: Record<string, unknown>): void;
  /** Drops every automation connection of a pane; used when an operator takes control. */
  closeForPane(paneId: string, refusal: CliBrowserCdpRefusal, reason: string): number;
  connectionCount(paneId: string): number;
}

function queryString(query: unknown, key: string): string | null {
  if (!query || typeof query !== "object") return null;
  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function headerString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ws rejects reserved codes (1004-1006) and anything outside 1000-1014 / 3000-4999.
function forwardableCloseCode(code: number): number {
  if (code === 1000 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return 1011;
}

/** Ids at or above this value are the proxy's own commands; their replies never reach the client. */
export const cliBrowserCdpProxyIdBase = 1_000_000_000;
const pageTargetCommands = new Set(["Target.attachToTarget", "Target.activateTarget", "Target.closeTarget"]);
const targetInfoEvents = new Set(["Target.targetCreated", "Target.targetInfoChanged"]);
const targetIdEvents = new Set(["Target.targetDestroyed", "Target.targetCrashed"]);

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/**
 * Panes on one browser account share one Chrome, and a raw CDP connection sees every tab of it. This filter
 * hides the pages that the store lists for the other panes of that Chrome: their targets leave Target.getTargets
 * and the browser-level Target events, commands aimed at them are answered with an error, and when the client
 * auto-attaches to one the proxy resumes it (it may wait for the debugger) and detaches, so a hidden page is never
 * left paused. Pages no pane owns yet are passed through as before.
 */
export function createCliBrowserCdpTargetFilter(sendToChrome: (message: Record<string, unknown>) => void) {
  let foreign = new Set<string>();
  let nextId = cliBrowserCdpProxyIdBase;
  const getTargetsIds = new Set<number>();
  const hiddenSessions = new Set<string>();
  const isForeignPage = (info: unknown): boolean => {
    const target = info as { type?: unknown; targetId?: unknown } | null;
    return target?.type === "page" && typeof target.targetId === "string" && foreign.has(target.targetId);
  };
  const proxyCommand = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    sendToChrome({ id: ++nextId, method, params, ...(sessionId ? { sessionId } : {}) });
  return {
    setForeignPages(pageIds: Iterable<string>) { foreign = new Set(pageIds); },
    /** A client command: forward (returns the frame) or answer it locally (returns a reply for the client). */
    fromClient(text: string): { forward: true } | { forward: false; reply: string } {
      let message: { id?: unknown; method?: unknown; params?: { targetId?: unknown }; sessionId?: unknown };
      try { message = JSON.parse(text); } catch { return { forward: true }; }
      if (message.sessionId !== undefined || typeof message.method !== "string") return { forward: true };
      if (message.method === "Target.getTargets" && typeof message.id === "number") getTargetsIds.add(message.id);
      if (pageTargetCommands.has(message.method) && typeof message.params?.targetId === "string" && foreign.has(message.params.targetId)) {
        return { forward: false, reply: JSON.stringify({ id: message.id, error: { code: -32000, message: "This page belongs to another pane of this browser; open tabs through Space (space_browser_tab_create)." } }) };
      }
      return { forward: true };
    },
    /** A Chrome frame: the text to send to the client, or null to drop it. */
    fromChrome(text: string): string | null {
      const head = text.slice(0, 32);
      const reply = /^\{"id":(\d+)/.exec(head);
      if (reply) {
        const id = Number(reply[1]);
        if (id > cliBrowserCdpProxyIdBase) return null;
        if (!getTargetsIds.delete(id)) return text;
        try {
          const message = JSON.parse(text) as { result?: { targetInfos?: unknown[] } };
          if (!Array.isArray(message.result?.targetInfos)) return text;
          return JSON.stringify({ ...message, result: { ...message.result, targetInfos: message.result.targetInfos.filter((info) => !isForeignPage(info)) } });
        } catch { return text; }
      }
      if (!head.startsWith('{"method":"Target.')) return text;
      let event: { method: string; params?: Record<string, unknown>; sessionId?: unknown };
      try { event = JSON.parse(text); } catch { return text; }
      if (event.sessionId !== undefined) return text;
      const params = event.params ?? {};
      if (event.method === "Target.attachedToTarget" && isForeignPage(params.targetInfo) && typeof params.sessionId === "string") {
        hiddenSessions.add(params.sessionId);
        if (params.waitingForDebugger === true) proxyCommand("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
        proxyCommand("Target.detachFromTarget", { sessionId: params.sessionId });
        return null;
      }
      if (event.method === "Target.detachedFromTarget" && typeof params.sessionId === "string" && hiddenSessions.delete(params.sessionId)) return null;
      if (targetInfoEvents.has(event.method) && isForeignPage(params.targetInfo)) return null;
      if (targetIdEvents.has(event.method) && typeof params.targetId === "string" && foreign.has(params.targetId)) return null;
      return text;
    }
  };
}

/** Page ids the store lists for the other panes whose browser session uses the same Chrome profile. */
async function foreignPageIds(store: SpaceStore, resolution: CliBrowserCdpResolution): Promise<string[]> {
  const sessions = await store.listActivePaneBrowserSessions();
  // A pane's tab in another Google account lives in that account's Chrome, which may be this pane's own.
  return sessions
    .filter((session) => session.paneId !== resolution.pane.id)
    .flatMap((session) => (session.pages ?? []).filter((page) => session.profilePath === resolution.session.profilePath || page.account))
    .map((page) => page.pageId);
}

export function createCliBrowserCdpProxy(options: CliBrowserCdpProxyOptions): CliBrowserCdpProxy {
  const readEndpoint = options.readEndpoint ?? ((session: PaneBrowserSession) => readChromeAutomationEndpoint(session.profilePath));
  const connections = new Map<string, Set<WsSocket>>();

  async function resolve(request: FastifyRequest): Promise<CliBrowserCdpResolution | CliBrowserCdpRefused> {
    if (!cliBrowserBridgeEnabled(options.config)) {
      return { refused: "BRIDGE_DISABLED", reason: "Space CLI browser bridge is disabled." };
    }
    const token = headerString(request.headers[cliBrowserBridgeTokenHeader]) ?? queryString(request.query, "token");
    let claims = verifyCliBrowserBridgeToken(options.config, token);
    if (!claims) return { refused: "TOKEN_INVALID", reason: "CLI browser bridge token is missing, invalid, or expired." };
    if (isT3AgentSessionId(claims.cliSessionId)) {
      // A T3 Code agent acts for its open T3 pane (t3code/agent-tokens.ts).
      if (!await t3AgentPrincipal(options.store, claims)) {
        return { refused: "TOKEN_INVALID", reason: "The T3 Code pane for this browser bridge token is closed or was not found." };
      }
    } else if (isHarnessAgentSessionId(claims.cliSessionId)) {
      // A Harness agent acts for its open Harness pane (harness-agent-tokens.ts).
      if (!await harnessAgentPrincipal(options.store, claims)) {
        return { refused: "TOKEN_INVALID", reason: "The Harness pane for this browser bridge token is closed or was not found." };
      }
    } else {
      const cliSession = await options.store.getPaneCliSession(claims.cliSessionId);
      // A moved pane keeps its running CLI session; the token then acts in the pane's current room.
      if (!cliSession || cliSession.paneId !== claims.paneId) {
        return { refused: "TOKEN_INVALID", reason: "CLI session for browser bridge token was not found." };
      }
      claims = { ...claims, roomId: cliSession.roomId };
      if (!cliSession.isActive || cliSession.status === "EXITED" || cliSession.status === "ERROR" || cliSession.purpose !== "NORMAL") {
        return { refused: "BROWSER_NOT_RUNNING", reason: "CLI session for browser bridge token is not active." };
      }
      try {
        await options.assertRuntimeEnabled?.(cliSession.runtimeId);
      } catch {
        return { refused: "BRIDGE_DISABLED", reason: "CLI runtime is disabled." };
      }
    }
    const requestedPaneId = queryString(request.query, "paneId");
    if (requestedPaneId && !paneIdPattern.test(requestedPaneId)) {
      return { refused: "PANE_NOT_FOUND", reason: "Browser pane id is invalid." };
    }
    const paneId = requestedPaneId ?? claims.paneId;
    let pane: Pane;
    try {
      pane = await options.store.getPane(paneId);
    } catch {
      return { refused: "PANE_NOT_FOUND", reason: "Browser pane was not found." };
    }
    // A plain CLI pane (the wrapper sends its own id) drives the room's browser pane, the one space_browser_start uses.
    if (pane.id === claims.paneId && !options.isBrowserPane(pane)) {
      pane = (await options.store.listPanes(claims.roomId, false)).find((candidate) => candidate.mode === "BROWSER") ?? pane;
    }
    if (pane.roomId !== claims.roomId || pane.isClosed || !options.isBrowserPane(pane)) {
      return { refused: "PANE_NOT_FOUND", reason: "Browser pane was not found in the CLI session room." };
    }
    const session = await options.store.getActivePaneBrowserSession(pane.id);
    if (!session || !session.isActive || session.status === "CLOSED" || session.status === "ERROR") {
      return { refused: "BROWSER_NOT_RUNNING", reason: "The managed browser of this pane is not running." };
    }
    const lease = await options.store.getActiveBrowserControlLease(session.sessionId);
    if (lease) {
      return { refused: "BROWSER_CONTROL_HELD", reason: "An operator holds browser control; wait for the handoff to finish." };
    }
    return { claims, pane, session };
  }

  function track(paneId: string, socket: WsSocket): () => void {
    const bucket = connections.get(paneId) ?? new Set<WsSocket>();
    bucket.add(socket);
    connections.set(paneId, bucket);
    return () => {
      bucket.delete(socket);
      if (bucket.size === 0) connections.delete(paneId);
    };
  }

  async function handle(socket: WsSocket, request: FastifyRequest): Promise<void> {
    // Playwright sends its first CDP commands as soon as the socket opens, so
    // buffer client frames before any await; nothing may be lost or reordered.
    const pending: Array<{ data: RawData; isBinary: boolean }> = [];
    let upstream: WsClient | null = null;
    let clientClosed = false;
    const filter = createCliBrowserCdpTargetFilter((message) => {
      if (upstream && upstream.readyState === upstream.OPEN) upstream.send(JSON.stringify(message));
    });
    const forward = (data: RawData, isBinary: boolean) => {
      if (!upstream) return;
      if (!isBinary) {
        const decision = filter.fromClient(rawText(data));
        if (!decision.forward) {
          if (socket.readyState === socket.OPEN) socket.send(decision.reply);
          return;
        }
      }
      upstream.send(data, { binary: isBinary });
    };
    socket.on("message", (data, isBinary) => {
      if (upstream && upstream.readyState === upstream.OPEN) forward(data, isBinary);
      else pending.push({ data, isBinary });
    });
    socket.once("close", () => { clientClosed = true; });

    const resolution = await resolve(request);
    if ("refused" in resolution) {
      socket.close(cliBrowserCdpCloseCodes[resolution.refused], resolution.reason.slice(0, 120));
      return;
    }
    // Tracked before any further await so an operator taking control meanwhile
    // can drop this socket; the lease is re-read afterwards to close the gap.
    const untrack = track(resolution.pane.id, socket);
    const endpoint = await readEndpoint(resolution.session);
    const lease = await options.store.getActiveBrowserControlLease(resolution.session.sessionId);
    if (!endpoint || lease || clientClosed) {
      untrack();
      if (lease) socket.close(cliBrowserCdpCloseCodes.BROWSER_CONTROL_HELD, "An operator holds browser control; wait for the handoff to finish.");
      else if (!endpoint) socket.close(cliBrowserCdpCloseCodes.ENDPOINT_UNAVAILABLE, "Browser automation endpoint is unavailable.");
      return;
    }
    const refreshForeign = () => foreignPageIds(options.store, resolution).then((ids) => filter.setForeignPages(ids), () => undefined);
    await refreshForeign();
    // Panes open and close tabs while the automation runs; the hidden set follows the store.
    const refresher = setInterval(() => { void refreshForeign(); }, 3_000);
    refresher.unref();
    // CDP responses (snapshots, screenshots) are large; the client side keeps the server limit.
    const chrome = new WsClient(endpoint, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    upstream = chrome;
    let settled = false;
    const finish = (code: number, reason: string) => {
      if (settled) return;
      settled = true;
      clearInterval(refresher);
      untrack();
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(forwardableCloseCode(code), reason.slice(0, 120));
      if (chrome.readyState === chrome.OPEN) chrome.close(1000, "space proxy closed");
      else if (chrome.readyState === chrome.CONNECTING) chrome.terminate();
    };
    chrome.once("open", () => {
      for (const message of pending.splice(0)) forward(message.data, message.isBinary);
    });
    chrome.on("message", (data, isBinary) => {
      if (socket.readyState !== socket.OPEN) return;
      if (isBinary) { socket.send(data, { binary: true }); return; }
      const text = filter.fromChrome(rawText(data));
      if (text !== null) socket.send(text);
    });
    chrome.on("close", (code, reason) => finish(code, reason.toString("utf8") || "browser closed the automation connection"));
    chrome.on("error", (error) => {
      options.log?.warn({ err: error, paneId: resolution.pane.id }, "CLI browser CDP upstream failed");
      finish(cliBrowserCdpCloseCodes.ENDPOINT_UNAVAILABLE, "Browser automation endpoint failed.");
    });
    socket.on("close", () => finish(1000, "client closed"));
    socket.on("error", () => finish(1011, "client failed"));
    try {
      await options.onConnected?.(request, resolution);
    } catch (error) {
      options.log?.warn({ err: error, paneId: resolution.pane.id }, "CLI browser CDP audit failed");
    }
  }

  return {
    resolve,
    register(app, routeOptions) {
      app.get(cliBrowserCdpPath, { ...routeOptions, websocket: true }, (socket, request) => {
        void handle(socket as unknown as WsSocket, request).catch((error) => {
          options.log?.warn({ err: error }, "CLI browser CDP proxy failed");
          try { socket.close(1011, "proxy failure"); } catch { /* already closed */ }
        });
      });
      app.get(cliBrowserCdpStatusPath, routeOptions, async (request, reply) => {
        const resolution = await resolve(request);
        if ("refused" in resolution) {
          if (resolution.refused === "TOKEN_INVALID") reply.code(401);
          return { ready: false, reason: resolution.refused, detail: resolution.reason, paneId: null, sessionId: null };
        }
        return { ready: true, reason: null, detail: null, paneId: resolution.pane.id, sessionId: resolution.session.sessionId };
      });
    },
    closeForPane(paneId, refusal, reason) {
      const bucket = connections.get(paneId);
      if (!bucket) return 0;
      const sockets = [...bucket];
      for (const socket of sockets) {
        try { socket.close(cliBrowserCdpCloseCodes[refusal], reason.slice(0, 120)); } catch { /* already closed */ }
      }
      return sockets.length;
    },
    connectionCount(paneId) {
      return connections.get(paneId)?.size ?? 0;
    }
  };
}
