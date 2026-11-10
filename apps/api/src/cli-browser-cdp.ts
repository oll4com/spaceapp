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
import { browserProfilePathForIdentity, readBrowserAccountTabIdentities } from "./browser-sessions.js";
import { ownBrowserPane, type BrowserControlActivity } from "./browser-control-activity.js";
import { isT3AgentSessionId, t3AgentPrincipal } from "./t3code/agent-tokens.js";
import { harnessAgentPrincipal, isHarnessAgentSessionId } from "./harness-agent-tokens.js";
import { vaultFencedTargets } from "./vault/fence-hooks.js";
import type { VaultProtection } from "./vault/protection.js";

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
  // An agent's handoff (sign-in, code, CAPTCHA) waits for the operator in this browser; only the agent that asked drives it.
  BROWSER_HANDOFF_PENDING: 4425,
  // A Vault-protected browser (vault/protection.ts) has no automation endpoint.
  VAULT_PROTECTED: 4424,
  // The pane's active tab moved into another Google account's Chrome (or back); the client reconnects there.
  ACTIVE_TAB_MOVED: 4410,
  // Same profile, new Chrome/session or restored targets: rediscover them on the next connection.
  BROWSER_CHANGED: 4411,
  ENDPOINT_UNAVAILABLE: 4502
});
export type CliBrowserCdpRefusal = keyof typeof cliBrowserCdpCloseCodes;

const paneIdPattern = /^pane:[A-Za-z0-9_-]{6,80}$/;

export const browserHandoffPendingReason = "The operator is finishing a sign-in, code or CAPTCHA in this browser; wait until the handoff ends.";

/**
 * While an agent's handoff waits (or the operator works in it), any other agent is refused: the tab the operator was sent to
 * stays as they left it. shortcut: a restarted requester CLI gets a new session id and waits like the others; key it on the pane if that bites.
 */
export async function handoffHeldFrom(store: Pick<SpaceStore, "getActiveBrowserHandoffRequest">, sessionId: string, actorId: string): Promise<string | null> {
  const handoff = await store.getActiveBrowserHandoffRequest(sessionId);
  return handoff && handoff.requestedById !== actorId ? browserHandoffPendingReason : null;
}

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

/**
 * The Chrome profile of the pane's active tab: a tab in another Google account lives in that account's Chrome
 * (browser-sessions.ts switchPageAccount), so automation follows it there; otherwise the pane's own Chrome.
 */
export async function activeTabProfilePath(profileRoot: string, pane: Pick<Pane, "id" | "roomId">, session: PaneBrowserSession): Promise<string> {
  const active = session.pages.find((page) => page.pageId === session.activePageId) ?? session.pages.find((page) => page.isActive);
  if (!active?.account) return session.profilePath;
  const identity = (await readBrowserAccountTabIdentities(profileRoot, pane.id))[active.account.profileId];
  try {
    return identity ? browserProfilePathForIdentity(profileRoot, pane, identity) : session.profilePath;
  } catch {
    return session.profilePath;
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
  config: Pick<SpaceApiConfig, "browserToolBridgeEnabled" | "internalApiToken" | "agentTokenSecret" | "browserSessionsProfileRoot">;
  isBrowserPane(pane: Pick<Pane, "mode">): boolean;
  /** Who drives each pane browser: a plain CLI pane gets only its own browser (ownBrowserPane). */
  controlActivity?: Pick<BrowserControlActivity, "agentFor">;
  assertRuntimeEnabled?(runtimeId: string): Promise<void>;
  /** The Vault fence of the pane a connection lands in (vault/protection.ts); without it no fence is checked here. */
  vaultProtection?: Pick<VaultProtection, "ownerOf" | "release">;
  onConnected?(request: FastifyRequest, resolution: CliBrowserCdpResolution): Promise<void> | void;
  log?: { warn(obj: unknown, msg?: string): void };
}

export interface CliBrowserCdpProxy {
  resolve(request: FastifyRequest): Promise<CliBrowserCdpResolution | CliBrowserCdpRefused>;
  register(app: FastifyInstance, routeOptions: Record<string, unknown>): void;
  /** Drops every automation connection of a pane (but `keepCliSessionId`'s); used when an operator takes control or a handoff starts. */
  closeForPane(paneId: string, refusal: CliBrowserCdpRefusal, reason: string, keepCliSessionId?: string): number;
  connectionCount(paneId: string): number;
  /** Whether an agent session scripted or changed this document in the page's own world (a sealed fill then starts from a fresh one). */
  documentDirty(paneId: string, targetId: string, loaderId: string | null): boolean;
  /** The CDP method that first made it dirty, for the fill's answer; null when it is clean. */
  documentDirtiedBy(paneId: string, targetId: string, loaderId: string | null): string | null;
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
 * Runs in Playwright's isolated utility world, where its snapshots and input reads run: a password field's value reads as a
 * mask there (2026-10-19). Each world has its own prototypes, so the page's own scripts still see the real value.
 */
export const cliBrowserPasswordRedaction = `(() => {
  const proto = HTMLInputElement.prototype, desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (!desc || !desc.get || proto.__spacePasswordRedaction) return;
  Object.defineProperty(proto, "__spacePasswordRedaction", { value: true });
  Object.defineProperty(proto, "value", { configurable: true, enumerable: desc.enumerable, set: desc.set,
    get() { const value = desc.get.call(this); return this.type === "password" && value ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : value; } });
})()`;
const playwrightUtilityWorld = "__playwright_utility_world_";

/**
 * Panes on one browser account share one Chrome, and a raw CDP connection sees every tab of it. This filter
 * hides the pages that the store lists for the other panes of that Chrome: their targets leave Target.getTargets
 * and the browser-level Target events, commands aimed at them are answered with an error, and when the client
 * auto-attaches to one the proxy resumes it (it may wait for the debugger) and detaches, so a hidden page is never
 * left paused. Once the store lists this pane's own pages, a page no live pane owns that was already open when the
 * client came (a tab of a pane long gone) is hidden the same way: Playwright's connectOverCDP waits for every page it
 * sees, and a tab blocked on a dialog or a busy script never answers (Clara/Nik 2026-10-21: initializeServer timed out).
 * Popups of this pane pass immediately. Other new tabs wait until the store lists their owner before discovery.
 */
/**
 * Which documents an agent's automation touched in the page's own world (Vault review 2026-10-22, plan clipboard:HIPO0ALNjfsP
 * step 5). A sealed fill reloads only a document a session scripted or changed in the main world (a listener or a focus trap
 * left there would see the value), so a login that lives in one document (username, Continue, password) keeps its step when
 * nothing scripted it. Fail closed: every command outside the safe list marks the document the session is on; a main-world
 * init script, a non-web navigation or an unknown document latches the whole pane. At most 50 documents per pane; more latch it.
 */
export function createCliBrowserDocumentMarks() {
  // Each dirty document (and a latched pane) keeps the CDP method that first dirtied it, so a fill's answer can name it (28/10).
  const panes = new Map<string, { documents: Map<string, string>; latched: string | null }>();
  const of = (paneId: string) => { const known = panes.get(paneId); if (known) return known; const made = { documents: new Map<string, string>(), latched: null }; panes.set(paneId, made); return made; };
  return {
    mark(paneId: string, targetId: string, loaderId: string | null, method = "UNKNOWN"): void {
      const pane = of(paneId);
      if (!loaderId || pane.documents.size >= 50) { pane.latched ??= method; return; }
      const key = `${targetId}|${loaderId}`;
      if (!pane.documents.has(key)) pane.documents.set(key, method);
    },
    latch(paneId: string, method = "UNKNOWN"): void { of(paneId).latched ??= method; },
    latchedBy(paneId: string): string | null { return panes.get(paneId)?.latched ?? null; },
    /** True when a fill of this document must start from a fresh one; a pane no automation touched is clean. */
    isDirty(paneId: string, targetId: string, loaderId: string | null): boolean {
      const pane = panes.get(paneId);
      return pane !== undefined && (pane.latched !== null || !loaderId || pane.documents.has(`${targetId}|${loaderId}`));
    },
    /** The CDP method that first made this document dirty (or latched the pane), null when it is clean. */
    dirtiedBy(paneId: string, targetId: string, loaderId: string | null): string | null {
      const pane = panes.get(paneId);
      if (!pane) return null;
      return pane.latched ?? (loaderId ? pane.documents.get(`${targetId}|${loaderId}`) ?? null : "UNKNOWN_DOCUMENT");
    }
  };
}
export type CliBrowserDocumentMarks = ReturnType<typeof createCliBrowserDocumentMarks>;

// Commands that run or change nothing in the page's own world. Everything else marks the document (fail closed).
// DOM.setFileInputFiles (31/10) runs no agent code: like typing, it sets a value and the page's own listeners see the change.
const SAFE_CDP_DOMAINS = ["Input.", "Accessibility.", "Emulation.", "Network.", "Target.", "Browser.", "Log.", "Security.", "Inspector.", "Console.", "IO.", "Overlay.",
  "Performance.", "Storage.", "DOMStorage.", "IndexedDB.", "CacheStorage.", "Schema.", "SystemInfo.", "Tracing."];
const SAFE_CDP_METHODS = new Set([
  "Page.enable", "Page.disable", "Page.getFrameTree", "Page.getLayoutMetrics", "Page.getNavigationHistory", "Page.navigateToHistoryEntry", "Page.reload", "Page.stopLoading",
  "Page.bringToFront", "Page.captureScreenshot", "Page.captureSnapshot", "Page.createIsolatedWorld", "Page.setLifecycleEventsEnabled", "Page.handleJavaScriptDialog", "Page.close",
  "Page.setInterceptFileChooserDialog", "Page.setDownloadBehavior", "Page.getResourceTree", "Page.printToPDF",
  "Runtime.enable", "Runtime.disable", "Runtime.addBinding", "Runtime.removeBinding", "Runtime.runIfWaitingForDebugger", "Runtime.releaseObject", "Runtime.releaseObjectGroup",
  "Runtime.discardConsoleEntries", "Runtime.getProperties", "Runtime.awaitPromise", "Runtime.setAsyncCallStackDepth", "Runtime.getHeapUsage", "Runtime.getIsolateId",
  "DOM.enable", "DOM.disable", "DOM.getDocument", "DOM.getFlattenedDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.describeNode", "DOM.getBoxModel", "DOM.getContentQuads",
  "DOM.getNodeForLocation", "DOM.getOuterHTML", "DOM.getAttributes", "DOM.requestNode", "DOM.requestChildNodes", "DOM.resolveNode", "DOM.scrollIntoViewIfNeeded", "DOM.focus",
  "DOM.getFrameOwner", "DOM.pushNodesByBackendIdsToFrontend", "DOM.setFileInputFiles", "CSS.enable", "CSS.disable", "CSS.getComputedStyleForNode", "CSS.getMatchedStylesForNode", "CSS.getInlineStylesForNode"
]);
/** Code runs where these say: safe only in an isolated world this session made or saw created. */
const CONTEXT_CDP_METHODS = new Set(["Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.compileScript", "Runtime.runScript"]);

type DocumentMarkSource = { method: string; sessionId: string; targetId: string; loaderId: string | null; scope: "DOCUMENT" | "PANE" };
export function createCliBrowserCdpTargetFilter(sendToChrome: (message: Record<string, unknown>) => void, documents?: {
  paneId: string; marks: CliBrowserDocumentMarks; onDirty?(source: DocumentMarkSource): void;
}) {
  let foreign = new Set<string>();
  let own = new Set<string>();
  // Pages Chrome created while this client is connected, and pages this filter hid (their ids, for id-only events).
  const opened = new Set<string>();
  const hiddenPages = new Set<string>();
  let nextId = cliBrowserCdpProxyIdBase;
  const getTargetsIds = new Set<string>();
  const hiddenSessions = new Set<string>();
  // Document marks: which session drives which target, the isolated worlds each session knows, and the replies to wait for.
  const sessionTargets = new Map<string, string>();
  const sessionParents = new Map<string, string>();
  const pageSessions = new Set<string>();
  const browserSessions = new Set<string>();
  const isolated = new Map<string, { ids: Set<number>; unique: Set<string>; objects: Set<string> }>();
  // Playwright calls its utility script by objectId, without a context id. Trust only handles returned by Chrome from
  // code in a world this session made or saw; object ids are opaque and never evidence of their own context.
  const objectRequests = new Set<string>();
  const requestKey = (session: string, id: number) => `${session}|${id}`;
  const forgetObjectRequests = (session: string) => { for (const key of objectRequests) if (key.startsWith(`${session}|`)) objectRequests.delete(key); };
  const worldRequests = new Map<string, string>();
  const attachRequests = new Map<string, { targetId: string | null; parent?: string }>();
  const proxyReplies = new Map<number, (message: { result?: Record<string, unknown> }) => void>();
  const worldsOf = (session: string) => { const known = isolated.get(session); if (known) return known; const made = { ids: new Set<number>(), unique: new Set<string>(), objects: new Set<string>() }; isolated.set(session, made); return made; };
  const classify = (method: string, params: Record<string, unknown>, session: string | undefined): "safe" | "dirty" | "latch" => {
    if (typeof session !== "string") return "safe";
    if (CONTEXT_CDP_METHODS.has(method)) {
      const id = params.contextId ?? params.executionContextId;
      const worlds = isolated.get(session);
      if (method === "Runtime.callFunctionOn" && typeof params.objectId === "string") return worlds?.objects.has(params.objectId) ? "safe" : "dirty";
      return (typeof id === "number" && worlds?.ids.has(id)) || (typeof params.uniqueContextId === "string" && worlds?.unique.has(params.uniqueContextId)) ? "safe" : "dirty";
    }
    if (method === "Page.addScriptToEvaluateOnNewDocument") return typeof params.worldName === "string" && params.worldName.length > 0 ? "safe" : "latch";
    if (method === "Page.navigate") { const url = String(params.url ?? ""); return /^https?:\/\//i.test(url) || url === "about:blank" ? "safe" : "latch"; }
    if (method === "Page.setDocumentContent") return "latch";
    return SAFE_CDP_METHODS.has(method) || SAFE_CDP_DOMAINS.some((domain) => method.startsWith(domain)) ? "safe" : "dirty";
  };
  const markDocument = (session: string, method: string) => {
    if (!documents) return;
    const pageSession = owningPageSession(session);
    const targetId = pageSession && sessionTargets.get(pageSession);
    if (!pageSession || !targetId) return;
    const id = ++nextId;
    proxyReplies.set(id, (reply) => {
      // A closing/hidden target cannot execute this call anymore. Its late lookup error must not latch unrelated new tabs.
      if (blockedSession(session) || owningPageSession(session) !== pageSession || sessionTargets.get(pageSession) !== targetId) return;
      const frame = (reply.result as { frameTree?: { frame?: { loaderId?: unknown } } } | undefined)?.frameTree?.frame;
      const loaderId = typeof frame?.loaderId === "string" ? frame.loaderId.slice(0, 128) : null;
      const previous = documents.marks.dirtiedBy(documents.paneId, targetId, loaderId);
      const previousLatch = documents.marks.latchedBy(documents.paneId);
      documents.marks.mark(documents.paneId, targetId, loaderId, method);
      const latched = documents.marks.latchedBy(documents.paneId) !== null;
      if (!previous || (!previousLatch && latched)) documents.onDirty?.({ method, sessionId: session, targetId, loaderId, scope: latched ? "PANE" : "DOCUMENT" });
    });
    sendToChrome({ id, method: "Page.getFrameTree", params: {}, sessionId: pageSession });
  };
  const isForeignPage = (info: unknown): boolean => {
    const target = info as { type?: unknown; targetId?: unknown } | null;
    if (target?.type !== "page" || typeof target.targetId !== "string") return false;
    const id = target.targetId;
    const hidden = foreign.has(id) || (own.size > 0 && !own.has(id) && !opened.has(id));
    if (hidden) hiddenPages.add(id);
    return hidden;
  };
  const isHiddenId = (id: string) => foreign.has(id) || (hiddenPages.has(id) && !own.has(id) && !opened.has(id));
  const owningPageSession = (session: string): string | null => {
    const seen = new Set<string>();
    for (let current: string | undefined = session; current && !seen.has(current); current = sessionParents.get(current)) {
      seen.add(current);
      if (pageSessions.has(current)) return current;
    }
    return null;
  };
  const blockedSession = (session: string): boolean => {
    if (hiddenSessions.has(session) || (!sessionTargets.has(session) && !browserSessions.has(session))) return true;
    const page = owningPageSession(session);
    return page !== null && isHiddenId(sessionTargets.get(page)!);
  };
  const forgetSession = (session: string) => {
    for (const [child, parent] of sessionParents) if (parent === session) forgetSession(child);
    isolated.delete(session); forgetObjectRequests(session); sessionTargets.delete(session);
    sessionParents.delete(session); pageSessions.delete(session); browserSessions.delete(session);
  };
  const refusedCommand = (id: unknown, session?: string) => ({ forward: false as const, reply: JSON.stringify({ id,
    ...(session ? { sessionId: session } : {}), error: { code: -32000, message: "This CDP session or page is not available to this pane; reconnect or open tabs through Space (space_browser_tab_create)." } }) });
  const proxyCommand = (method: string, params: Record<string, unknown>, sessionId?: string) =>
    sendToChrome({ id: ++nextId, method, params, ...(sessionId ? { sessionId } : {}) });
  return {
    setForeignPages(pageIds: Iterable<string>) { foreign = new Set(pageIds); },
    /** A previously hidden target needs fresh discovery: changing this set cannot replay its lost attach events. */
    setOwnPages(pageIds: Iterable<string>): boolean {
      const next = new Set(pageIds);
      const needsDiscovery = [...next].some((id) => hiddenPages.has(id) && !own.has(id) && !opened.has(id) && !foreign.has(id));
      own = next;
      return needsDiscovery;
    },
    /** A client command: forward (returns the frame) or answer it locally (returns a reply for the client). */
    fromClient(text: string): { forward: true } | { forward: false; reply: string } {
      let message: { id?: unknown; method?: unknown; params?: { targetId?: unknown }; sessionId?: unknown };
      try { message = JSON.parse(text); } catch { return { forward: true }; }
      if (typeof message.method !== "string") return { forward: true };
      const params = (message.params ?? {}) as Record<string, unknown>;
      const session = typeof message.sessionId === "string" ? message.sessionId : undefined;
      // Browser-wide auto-attach also sees other panes. Refuse their sessions, and stale/unknown ids, before classifying
      // commands: forwarding first would let them change a foreign page and a failed lookup could latch this entire pane.
      if (session && blockedSession(session)) return refusedCommand(message.id, session);
      if (pageTargetCommands.has(message.method) && typeof params.targetId === "string" && isHiddenId(params.targetId)) return refusedCommand(message.id, session);
      const verdict = classify(message.method, params, session);
      if (session && verdict !== "safe" && !owningPageSession(session)) return refusedCommand(message.id, session);
      if (typeof message.id === "number") {
        const key = requestKey(session ?? "", message.id);
        if (message.method === "Target.attachToTarget" && typeof params.targetId === "string") attachRequests.set(key, { targetId: params.targetId, parent: session });
        if (message.method === "Target.attachToBrowserTarget") attachRequests.set(key, { targetId: null });
      }
      if (documents) {
        if (typeof message.id === "number" && session && message.method === "Page.createIsolatedWorld") worldRequests.set(requestKey(session, message.id), session);
        if (session && typeof message.id === "number" && verdict === "safe" && (message.method === "Runtime.evaluate" || message.method === "Runtime.callFunctionOn"
          || (message.method === "DOM.resolveNode" && typeof params.executionContextId === "number" && isolated.get(session)?.ids.has(params.executionContextId)))) {
          objectRequests.add(requestKey(session, message.id));
        }
        if (session && message.method === "Runtime.releaseObject" && typeof params.objectId === "string") isolated.get(session)?.objects.delete(params.objectId);
        if (session && message.method === "Runtime.releaseObjectGroup") { isolated.get(session)?.objects.clear(); forgetObjectRequests(session); }
        if (verdict === "latch" && session) {
          const targetId = sessionTargets.get(owningPageSession(session)!)!;
          const previous = documents.marks.latchedBy(documents.paneId);
          documents.marks.latch(documents.paneId, message.method);
          if (!previous) documents.onDirty?.({ method: message.method, sessionId: session, targetId, loaderId: null, scope: "PANE" });
        }
        else if (verdict === "dirty" && session) markDocument(session, message.method);
      }
      if (message.method === "Target.getTargets" && typeof message.id === "number") getTargetsIds.add(requestKey(session ?? "", message.id));
      return { forward: true };
    },
    /** A Chrome frame: the text to send to the client, or null to drop it. */
    fromChrome(text: string): string | null {
      let outer: { id?: number; sessionId?: string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
      try { outer = JSON.parse(text); } catch { return text; }
      if (typeof outer.id === "number" && outer.id > cliBrowserCdpProxyIdBase) {
        const waiting = proxyReplies.get(outer.id);
        proxyReplies.delete(outer.id);
        waiting?.(outer);
        return null;
      }
      if (typeof outer.sessionId === "string" && blockedSession(outer.sessionId)) {
        // Even a hidden parent's late auto-attach must be released, never left waiting for the debugger.
        if (outer.method === "Target.attachedToTarget" && typeof outer.params?.sessionId === "string") {
          hiddenSessions.add(outer.params.sessionId);
          if (outer.params.waitingForDebugger === true) proxyCommand("Runtime.runIfWaitingForDebugger", {}, outer.params.sessionId);
          proxyCommand("Target.detachFromTarget", { sessionId: outer.params.sessionId });
        }
        return null;
      }
      const head = text.slice(0, 32);
      const reply = /^\{"id":(\d+)/.exec(head);
      if (reply) {
        const id = Number(reply[1]);
        if (objectRequests.size > 0) {
          try {
            const message = JSON.parse(text) as { sessionId?: unknown; result?: { result?: { objectId?: unknown }; object?: { objectId?: unknown }; exceptionDetails?: unknown } };
            if (typeof message.sessionId === "string" && objectRequests.delete(requestKey(message.sessionId, id)) && !message.result?.exceptionDetails) {
              const objectId = message.result?.result?.objectId ?? message.result?.object?.objectId;
              if (typeof objectId === "string") isolated.get(message.sessionId)?.objects.add(objectId);
            }
          } catch { /* not a reply this filter reads */ }
        }
        const key = requestKey(outer.sessionId ?? "", id);
        const world = worldRequests.get(key);
        const attaching = attachRequests.get(key);
        if (world !== undefined || attaching !== undefined) {
          worldRequests.delete(key); attachRequests.delete(key);
          try {
            const message = JSON.parse(text) as { result?: { executionContextId?: unknown; sessionId?: unknown } };
            if (world !== undefined && typeof message.result?.executionContextId === "number") worldsOf(world).ids.add(message.result.executionContextId);
            if (attaching !== undefined && typeof message.result?.sessionId === "string") {
              const session = message.result.sessionId;
              if (attaching.targetId === null) browserSessions.add(session);
              else {
                sessionTargets.set(session, attaching.targetId);
                if (attaching.parent) sessionParents.set(session, attaching.parent);
                // Page.attach replies may precede their target event. Only listed pages can authorize this shortcut.
                if (own.has(attaching.targetId) || opened.has(attaching.targetId)) pageSessions.add(session);
              }
            }
          } catch { /* not a reply this filter reads */ }
          return text;
        }
        if (!getTargetsIds.delete(key)) return text;
        try {
          const message = JSON.parse(text) as { result?: { targetInfos?: unknown[] } };
          if (!Array.isArray(message.result?.targetInfos)) return text;
          return JSON.stringify({ ...message, result: { ...message.result, targetInfos: message.result.targetInfos.filter((info) => !isForeignPage(info)) } });
        } catch { return text; }
      }
      if (text.startsWith('{"method":"Runtime.executionContextCreated"')) {
        // The mask goes in before the client learns of the world, so Chrome runs it ahead of the client's first call there.
        try {
          const event = JSON.parse(text) as { method?: unknown; params?: { context?: { id?: unknown; name?: unknown; uniqueId?: unknown; auxData?: { isDefault?: unknown } } }; sessionId?: unknown };
          const context = event.params?.context;
          const session = typeof event.sessionId === "string" ? event.sessionId : undefined;
          if (event.method === "Runtime.executionContextCreated" && typeof context?.id === "number" && typeof context.name === "string"
            && context.name.startsWith(playwrightUtilityWorld)) {
            proxyCommand("Runtime.evaluate", { expression: cliBrowserPasswordRedaction, contextId: context.id, returnByValue: true, silent: true }, session);
          }
          // Every world that is not the page's own counts as isolated for the document marks.
          if (session && typeof context?.id === "number" && context.auxData?.isDefault === false) {
            const worlds = worldsOf(session);
            worlds.ids.add(context.id);
            if (typeof context.uniqueId === "string") worlds.unique.add(context.uniqueId);
          }
        } catch { /* not a frame this filter reads */ }
        return text;
      }
      if (text.startsWith('{"method":"Runtime.executionContextDestroyed"') || text.startsWith('{"method":"Runtime.executionContextsCleared"')) {
        try {
          const event = JSON.parse(text) as { method?: string; sessionId?: string; params?: { executionContextId?: number; executionContextUniqueId?: string } };
          if (event.sessionId) {
            const worlds = isolated.get(event.sessionId);
            // Invalidate pending replies too: a late handle from the old document must never become trusted again.
            forgetObjectRequests(event.sessionId);
            if (event.method === "Runtime.executionContextsCleared") isolated.delete(event.sessionId);
            else if (worlds) {
              if (event.params?.executionContextId !== undefined) worlds.ids.delete(event.params.executionContextId);
              if (event.params?.executionContextUniqueId !== undefined) worlds.unique.delete(event.params.executionContextUniqueId);
              else worlds.unique.clear();
              worlds.objects.clear();
            }
          }
        } catch { /* not a frame this filter reads */ }
        return text;
      }
      if (!head.startsWith('{"method":"Target.')) return text;
      let event: { method: string; params?: Record<string, unknown>; sessionId?: unknown };
      try { event = JSON.parse(text); } catch { return text; }
      const params = event.params ?? {};
      const attachedId = (params.targetInfo as { targetId?: unknown } | undefined)?.targetId;
      if (event.method === "Target.attachedToTarget" && typeof params.sessionId === "string" && typeof attachedId === "string") {
        const opener = (params.targetInfo as { openerId?: unknown }).openerId;
        if (params.waitingForDebugger === true && !foreign.has(attachedId) && (own.has(attachedId)
          || (typeof opener === "string" && (own.has(opener) || opened.has(opener)) && !isHiddenId(opener)))) opened.add(attachedId);
        // Apply ownership to nested attaches too. A parent session never authorizes another pane's page.
        if (isForeignPage(params.targetInfo)) {
          hiddenSessions.add(params.sessionId);
          if (params.waitingForDebugger === true) proxyCommand("Runtime.runIfWaitingForDebugger", {}, params.sessionId);
          proxyCommand("Target.detachFromTarget", { sessionId: params.sessionId }, typeof event.sessionId === "string" ? event.sessionId : undefined);
          return null;
        }
        sessionTargets.set(params.sessionId, attachedId);
        if (typeof event.sessionId === "string") sessionParents.set(params.sessionId, event.sessionId);
        if ((params.targetInfo as { type?: unknown }).type === "page") pageSessions.add(params.sessionId);
      }
      if (event.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
        forgetSession(params.sessionId);
        if (hiddenSessions.delete(params.sessionId)) return null;
      }
      if (event.method === "Target.targetDestroyed" && typeof params.targetId === "string") {
        for (const [session, target] of sessionTargets) if (target === params.targetId) forgetSession(session);
        opened.delete(params.targetId);
      }
      if (event.sessionId !== undefined) return text;
      if (targetInfoEvents.has(event.method) && isForeignPage(params.targetInfo)) return null;
      if (targetIdEvents.has(event.method) && typeof params.targetId === "string" && isHiddenId(params.targetId)) return null;
      return text;
    }
  };
}

/**
 * Page ids the store lists for the other panes whose browser session uses the connected Chrome profile, plus every tab a
 * Vault fence of another pane covers (a fill or a completed handoff), wherever it lives.
 */
async function foreignPageIds(store: SpaceStore, paneId: string, profilePath: string): Promise<string[]> {
  const sessions = (await store.listActivePaneBrowserSessions()).filter((session) => session.paneId !== paneId);
  // A pane's tab in another Google account lives in that account's Chrome, which may be this pane's own.
  const listed = sessions
    .flatMap((session) => (session.pages ?? []).filter((page) => session.profilePath === profilePath || page.account))
    .map((page) => page.pageId);
  const fenced = await Promise.all([...new Set(sessions.map((session) => session.paneId))].map((id) => vaultFencedTargets(store, id)));
  return [...listed, ...fenced.flat()];
}

export function createCliBrowserCdpProxy(options: CliBrowserCdpProxyOptions): CliBrowserCdpProxy {
  const profileRoot = options.config.browserSessionsProfileRoot;
  const connections = new Map<string, Set<WsSocket>>();
  const socketCliSession = new WeakMap<WsSocket, string>();
  const marks = createCliBrowserDocumentMarks();

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
    // A plain CLI pane (the wrapper sends its own id) drives its own browser pane, the one space_browser_start uses; never another agent's.
    if (pane.id === claims.paneId && !options.isBrowserPane(pane)) {
      const own = ownBrowserPane(await options.store.listPanes(claims.roomId, false), claims.paneId, options.controlActivity);
      if (!own) return { refused: "PANE_NOT_FOUND", reason: "This pane has no browser of its own and the room's browsers are other agents': start yours with space_browser_start." };
      pane = own;
    }
    if (pane.roomId !== claims.roomId || pane.isClosed || !options.isBrowserPane(pane)) {
      return { refused: "PANE_NOT_FOUND", reason: "Browser pane was not found in the CLI session room." };
    }
    // The fence is checked on the pane the connection lands in: the route hook sees only the ids a request names, never the
    // room's default browser pane a plain CLI token drives (Vault review 2026-10-22).
    if (options.vaultProtection && await options.vaultProtection.ownerOf(pane.id) && !(await options.vaultProtection.release(pane.id))) {
      return { refused: "VAULT_PROTECTED", reason: "This browser holds a Vault fill: no automation until it shows the next page." };
    }
    const session = await options.store.getActivePaneBrowserSession(pane.id);
    if (!session || !session.isActive || session.status === "CLOSED" || session.status === "ERROR") {
      return { refused: "BROWSER_NOT_RUNNING", reason: "The managed browser of this pane is not running." };
    }
    const lease = await options.store.getActiveBrowserControlLease(session.sessionId);
    if (lease) {
      return { refused: "BROWSER_CONTROL_HELD", reason: "An operator holds browser control; wait for the handoff to finish." };
    }
    const handoffHeld = await handoffHeldFrom(options.store, session.sessionId, `cli:${claims.cliSessionId}`);
    if (handoffHeld) return { refused: "BROWSER_HANDOFF_PENDING", reason: handoffHeld };
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
    // The pane is known only after resolve(); the first client frames are buffered until Chrome answers, after resolve().
    let paneId: string | null = null;
    let principal: CliBrowserBridgeTokenPayload | null = null;
    const filter = createCliBrowserCdpTargetFilter((message) => {
      if (upstream && upstream.readyState === upstream.OPEN) upstream.send(JSON.stringify(message));
    }, { get paneId() { return paneId ?? ""; }, marks,
      // Metadata only: enough to attribute a future mark without logging code, object handles, URLs or page contents.
      onDirty: (source) => options.log?.warn({ event: "cli_browser.document_dirty", paneId, cliPaneId: principal?.paneId,
        cliSessionId: principal?.cliSessionId, ...source }, "CLI browser document marked dirty.") });
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
    paneId = resolution.pane.id;
    principal = resolution.claims;
    socketCliSession.set(socket, resolution.claims.cliSessionId);
    const untrack = track(resolution.pane.id, socket);
    const profilePath = await activeTabProfilePath(profileRoot, resolution.pane, resolution.session);
    const endpoint = await readChromeAutomationEndpoint(profilePath);
    const lease = await options.store.getActiveBrowserControlLease(resolution.session.sessionId);
    if (!endpoint || lease || clientClosed) {
      untrack();
      if (lease) socket.close(cliBrowserCdpCloseCodes.BROWSER_CONTROL_HELD, "An operator holds browser control; wait for the handoff to finish.");
      else if (!endpoint) socket.close(cliBrowserCdpCloseCodes.ENDPOINT_UNAVAILABLE, "Browser automation endpoint is unavailable.");
      return;
    }
    const refreshPages = async (session: PaneBrowserSession) => {
      filter.setForeignPages(await foreignPageIds(options.store, resolution.pane.id, profilePath));
      return filter.setOwnPages(session.pages.map((page) => page.pageId));
    };
    try {
      await refreshPages(resolution.session);
    } catch {
      untrack();
      socket.close(cliBrowserCdpCloseCodes.ENDPOINT_UNAVAILABLE, "Browser automation state is unavailable; reconnect.");
      return;
    }
    const refreshConnection = async () => {
      const session = await options.store.getActivePaneBrowserSession(resolution.pane.id);
      if (!session || !session.isActive || session.status === "CLOSED" || session.status === "ERROR") {
        finish(cliBrowserCdpCloseCodes.BROWSER_NOT_RUNNING, "The pane browser stopped; reconnect after it starts.");
      } else if (session.sessionId !== resolution.session.sessionId) {
        finish(cliBrowserCdpCloseCodes.BROWSER_CHANGED, "The pane browser session changed; reconnect to its current Chrome.");
      } else if (await activeTabProfilePath(profileRoot, resolution.pane, session) !== profilePath) {
        finish(cliBrowserCdpCloseCodes.ACTIVE_TAB_MOVED, "The active tab moved into another Google account's browser.");
      } else if (await readChromeAutomationEndpoint(profilePath) !== endpoint) {
        finish(cliBrowserCdpCloseCodes.BROWSER_CHANGED, "The pane Chrome endpoint changed; reconnect to its current browser.");
      } else if (await refreshPages(session)) {
        finish(cliBrowserCdpCloseCodes.BROWSER_CHANGED, "The pane's restored tabs need fresh discovery; reconnect to its browser.");
      }
    };
    // Reuse the existing cadence, with no overlapping reads. A host restart may keep the profile path and stored
    // session id while replacing Chrome's endpoint or targets. Never splice a new upstream into old CDP sessions:
    // closing invalidates Playwright's cached backend, so its next tool call resolves and discovers the live browser.
    let settled = false;
    let refreshing = false;
    const refresher = setInterval(() => {
      if (settled || refreshing) return;
      refreshing = true;
      void refreshConnection().catch(() => finish(cliBrowserCdpCloseCodes.ENDPOINT_UNAVAILABLE, "Browser automation state is unavailable; reconnect."))
        .finally(() => { refreshing = false; });
    }, 3_000);
    refresher.unref();
    // CDP responses (snapshots, screenshots) are large; the client side keeps the server limit.
    const chrome = new WsClient(endpoint, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    upstream = chrome;
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
          if (resolution.refused === "VAULT_PROTECTED") reply.code(409);
          return { ready: false, reason: resolution.refused, detail: resolution.reason, paneId: null, sessionId: null };
        }
        return { ready: true, reason: null, detail: null, paneId: resolution.pane.id, sessionId: resolution.session.sessionId };
      });
    },
    closeForPane(paneId, refusal, reason, keepCliSessionId) {
      const bucket = connections.get(paneId);
      if (!bucket) return 0;
      const sockets = [...bucket].filter((socket) => !keepCliSessionId || socketCliSession.get(socket) !== keepCliSessionId);
      for (const socket of sockets) {
        try { socket.close(cliBrowserCdpCloseCodes[refusal], reason.slice(0, 120)); } catch { /* already closed */ }
      }
      return sockets.length;
    },
    connectionCount(paneId) {
      return connections.get(paneId)?.size ?? 0;
    },
    documentDirty: (paneId, targetId, loaderId) => marks.isDirty(paneId, targetId, loaderId),
    documentDirtiedBy: (paneId, targetId, loaderId) => marks.dirtiedBy(paneId, targetId, loaderId)
  };
}
