import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { VaultHostTarget } from "@space/contracts";
import type { PostgresVaultRepository, VaultFillTarget } from "@space/db";
import { cliBrowserBridgeTokenHeader, verifyCliBrowserBridgeToken } from "../cli-browser-bridge.js";
import type { SpaceApiConfig } from "../config.js";
import { sendApiError } from "../http-errors.js";
import { SpaceConflictError } from "@space/runtime";

// Vault protected panes (ADR-012; automatic since operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac). Each agent or
// Nous fill protects the browser it fills: one hook fences every generic read of it, so the filled value can never be read
// back. Agents keep navigation, clicks, typing and scrolling (they return no page content); only its owner sees it (live
// view); nobody records or diagnoses it. The protection lifts by itself once the filled page is gone. A completed operator
// handoff fences the page the same way (fence-hooks.ts), and a tab that left view still holds what was typed into it, so
// only a closed tab, or the tab itself showing another document, origin or no web page, counts as gone (2026-10-19).

export type VaultProtectionStore = Pick<PostgresVaultRepository, "protectPane" | "unprotectPane" | "protectedPane">;
type Entry = { owner: string; fill: VaultFillTarget | null } | null;
/** A pane's open tabs as the Browser Host lists them. */
export type VaultOpenPage = { pageId: string; isActive: boolean };
// A bound on the row, far above the tabs a pane keeps open; tabs leave the list as soon as they are gone.
const MAX_FENCED_TABS = 50;

const CACHE_MS = 5_000;
// Viewers' frame polls ask the Browser Host about the live page at most this often (agents' calls always ask).
const RELEASE_CHECK_MS = 2_000;

/**
 * True once the page a fill (or handoff) landed in is gone: its tab is closed, or that tab shows another document, origin
 * or no web page. A tab that is only out of view still holds the value. Unknown tabs (no list) keep the fence when another
 * tab is shown. A host started before 2026-10-18 also reports PROFILE_SHARED or SECOND_TARGET, which say nothing about the page.
 */
export function vaultFillPageGone(fill: Pick<VaultFillTarget, "targetId" | "origin" | "document">, live: VaultHostTarget,
  pages?: readonly VaultOpenPage[] | null): boolean {
  if (pages) {
    const tab = pages.find((page) => page.pageId === fill.targetId);
    if (!tab) return true;
    if (!tab.isActive) return false;
  }
  if (!live.eligible) return live.reason === "NO_WEB_ORIGIN" && (Boolean(pages) || live.targetId === fill.targetId);
  if (live.targetId !== fill.targetId) return false;
  return live.origin !== fill.origin || (fill.document !== null && typeof live.document === "string" && live.document !== fill.document);
}

/** Every tab a fence covers: the latest fill or handoff page and the earlier ones still open. */
export function vaultFencedTabs(fill: VaultFillTarget): Array<Pick<VaultFillTarget, "targetId" | "origin" | "document">> {
  const { also, ...latest } = fill;
  return [latest, ...(also ?? [])];
}

export function createVaultProtection(repository: VaultProtectionStore | null, liveTarget?: (paneId: string) => Promise<VaultHostTarget>,
  openPages?: (paneId: string) => Promise<VaultOpenPage[]>) {
  const cache = new Map<string, { entry: Entry; at: number }>();
  const checked = new Map<string, number>();
  const listeners = new Set<(paneId: string) => void>();
  const entryOf = async (paneId: string): Promise<Entry> => {
    if (!repository) return null;
    const hit = cache.get(paneId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.entry;
    const entry = await repository.protectedPane(paneId);
    cache.set(paneId, { entry, at: Date.now() });
    return entry;
  };
  const unprotect = async (owner: string, paneId: string): Promise<boolean> => {
    const removed = repository ? await repository.unprotectPane(owner, paneId) : false;
    if (removed) cache.delete(paneId);
    return removed;
  };
  return {
    ownerOf: async (paneId: string): Promise<string | null> => (await entryOf(paneId))?.owner ?? null,
    /** Protects the pane for the page a fill is about to land in; false when another account protects it. */
    async protect(owner: string, paneId: string, target: VaultFillTarget): Promise<boolean> {
      // One fence per pane: tabs it already covers stay covered next to the new page.
      const previous = (await entryOf(paneId).catch(() => null))?.fill;
      const earlier = previous ? vaultFencedTabs(previous).filter((tab) => tab.targetId !== target.targetId) : [];
      const fill: VaultFillTarget = { targetId: target.targetId, origin: target.origin, document: target.document,
        ...(earlier.length ? { also: earlier.slice(0, MAX_FENCED_TABS) } : {}) };
      if (!repository || !await repository.protectPane(owner, paneId, fill)) return false;
      cache.set(paneId, { entry: { owner, fill }, at: Date.now() });
      // Open automation connections to this browser close now (the CLI CDP proxy listens).
      for (const listener of listeners) listener(paneId);
      return true;
    },
    unprotect,
    /** Lifts the protection when its filled page is gone; true when the pane is free now. Any doubt keeps it. */
    async release(paneId: string, { throttled = false }: { throttled?: boolean } = {}): Promise<boolean> {
      const entry = await entryOf(paneId);
      if (!entry) return true;
      // Protected by hand before 2026-10-18: no fill page is known, and that step no longer exists.
      if (!entry.fill) return unprotect(entry.owner, paneId);
      if (!liveTarget || (throttled && Date.now() - (checked.get(paneId) ?? 0) < RELEASE_CHECK_MS)) return false;
      checked.set(paneId, Date.now());
      const live = await liveTarget(paneId).catch(() => null);
      if (live === null) return false;
      const pages = openPages ? await openPages(paneId).catch(() => null) : null;
      const tabs = vaultFencedTabs(entry.fill);
      const left = tabs.filter((tab) => !vaultFillPageGone(tab, live, pages));
      if (!left.length) return unprotect(entry.owner, paneId);
      // Tabs that are gone leave the fence; the rest keep it.
      if (left.length < tabs.length && repository) {
        const [latest, ...also] = left;
        const fill: VaultFillTarget = { ...latest!, ...(also.length ? { also } : {}) };
        if (await repository.protectPane(entry.owner, paneId, fill)) cache.set(paneId, { entry: { owner: entry.owner, fill }, at: Date.now() });
      }
      return false;
    },
    /** The tabs this pane's fence covers (none when it has no fence). */
    async fencedTargets(paneId: string): Promise<string[]> {
      const fill = (await entryOf(paneId))?.fill;
      return fill ? vaultFencedTabs(fill).map((tab) => tab.targetId) : [];
    },
    onProtected(listener: (paneId: string) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
export type VaultProtection = ReturnType<typeof createVaultProtection>;

const paneBrowserRoute = /^\/api\/panes\/:id\/browser(\/|$)/;
// The owner keeps the live view and control; recordings, captures and diagnostics stay off until the filled page is gone.
const ownerRefused = /^\/api\/panes\/:id\/browser\/(captures|diagnostics)(\/|$)/;
const cliBrowserRoutes = new Set(["/api/cli/browser/actions", "/api/cli/browser/commands", "/api/cli/browser/cdp", "/api/cli/browser/cdp/status", "/api/cli/browser/context"]);
const interactionActions = new Set(["navigate", "click", "type", "scroll", "set_viewport", "press"]);
// The operator handoff stays open under a fence (2026-10-22, Nous decision): a human check or CAPTCHA after a fill, before
// Submit. Its answers are handoff and lease records only, never page content; the fence holds through and after it.
const handoffCommands = new Set(["REQUEST_HANDOFF", "HANDOFF_STATUS", "CANCEL_HANDOFF", "RECLAIM_CONTROL"]);

/**
 * The fence for in-process callers that reach a browser without the HTTP routes the hook covers (the Dot gateway, the
 * internal agent route): an action that returns page content (text, a recording, a capture) is refused while the pane
 * holds a Vault fill; navigation, clicks, typing and scrolling stay open (1.1.7 review, Codex #4).
 */
export async function assertVaultBrowserActionAllowed(protection: Pick<VaultProtection, "ownerOf" | "release">, paneId: string, actionType: string): Promise<void> {
  if (interactionActions.has(actionType) || !await protection.ownerOf(paneId) || await protection.release(paneId)) return;
  throw new SpaceConflictError("This browser holds a Vault fill: until it shows the next page, it can only be navigated, clicked, typed into and scrolled.");
}

export function registerVaultFences(app: FastifyInstance, deps: { protection: VaultProtection; config: Pick<SpaceApiConfig, "internalApiToken" | "agentTokenSecret"> }): void {
  const refuse = (reply: FastifyReply, code: "VAULT_PROTECTED_PANE_PRIVATE" | "VAULT_PROTECTED_SESSION_REQUIRED", message: string) =>
    sendApiError(reply, code === "VAULT_PROTECTED_PANE_PRIVATE" ? 403 : 409, code, message);
  const fencedCloses = new WeakSet<FastifyRequest>();
  app.addHook("preSerialization", async (request: FastifyRequest, _reply: FastifyReply, payload: unknown) => {
    if (!fencedCloses.has(request) || !payload || typeof payload !== "object") return payload;
    const { sessionId, activePageId, pages } = payload as { sessionId?: unknown; activePageId?: unknown; pages?: unknown };
    if (!Array.isArray(pages)) return payload;
    return { sessionId, activePageId,
      pages: pages.map((page: { pageId?: unknown; kind?: unknown; isActive?: unknown }) => ({ pageId: page?.pageId, kind: page?.kind, isActive: page?.isActive })) };
  });
  // preHandler: the session user is known (onRequest auth ran) and bodies are parsed; WebSocket upgrades pass here too.
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions.url ?? "";
    if (paneBrowserRoute.test(route)) {
      const paneId = (request.params as { id?: unknown } | undefined)?.id;
      if (typeof paneId !== "string") return;
      const owner = await deps.protection.ownerOf(paneId);
      if (!owner) return;
      const ownerView = request.user?.id === owner && !request.user?.automationScope && !ownerRefused.test(route);
      if (ownerView || await deps.protection.release(paneId, { throttled: true })) return;
      if (request.user?.id !== owner || request.user?.automationScope) return refuse(reply, "VAULT_PROTECTED_PANE_PRIVATE", "This browser is private while it holds a Vault fill.");
      return refuse(reply, "VAULT_PROTECTED_PANE_PRIVATE", "Recordings and diagnostics are off while this browser holds a Vault fill.");
    }
    if (cliBrowserRoutes.has(route)) {
      const token = request.headers[cliBrowserBridgeTokenHeader] ?? (request.query as { token?: unknown } | undefined)?.token;
      const claims = verifyCliBrowserBridgeToken(deps.config, typeof token === "string" ? token : null);
      if (!claims) return;
      // Every pane the request can reach: the token's own pane and any browser pane it names.
      const body = (request.body ?? {}) as { targetPaneId?: unknown; actions?: Array<{ targetPaneId?: unknown; action?: { type?: unknown } }> };
      const named = [claims.paneId, (request.query as { paneId?: unknown } | undefined)?.paneId, body.targetPaneId, ...(body.actions ?? []).map((entry) => entry?.targetPaneId)]
        .filter((id): id is string => typeof id === "string");
      const protectedPanes = new Set<string>();
      for (const id of new Set(named)) if (await deps.protection.ownerOf(id)) protectedPanes.add(id);
      if (protectedPanes.size === 0) return;
      // Actions that return no page content stay open, so a login can go on (Next, Sign in, a mail code, Verify) while the
      // fill is in the page; the pane that holds the fence also gets masked screenshots of it (fields drawn as dots), never
      // another pane (2026-10-19, Nous decision on the Alstom report).
      const onlyInteraction = route === "/api/cli/browser/actions" && Array.isArray(body.actions) && body.actions.length > 0
        && body.actions.every((entry) => !protectedPanes.has(String(entry?.targetPaneId)) || interactionActions.has(String(entry?.action?.type))
          || (entry?.action?.type === "masked_screenshot" && entry?.targetPaneId === claims.paneId));
      if (onlyInteraction) return;
      // Closing a tab stays open, so an agent is never stuck behind the tab that holds the fence; its answer keeps only the
      // remaining tab ids (preSerialization below), never their addresses or titles.
      const commandType = route === "/api/cli/browser/commands" ? (body as { command?: { type?: unknown } }).command?.type : undefined;
      if (commandType === "CLOSE_PAGE") {
        fencedCloses.add(request);
        return;
      }
      if (handoffCommands.has(String(commandType))) return;
      let released = true;
      for (const id of protectedPanes) released = await deps.protection.release(id) && released;
      if (released) return;
      return refuse(reply, "VAULT_PROTECTED_SESSION_REQUIRED", "This browser holds a Vault fill: until it shows the next page, agents can only navigate, click, type and scroll it (no page reads, DevTools or Playwright).");
    }
  });
}
