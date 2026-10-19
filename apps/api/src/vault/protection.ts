import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { VaultHostTarget } from "@space/contracts";
import type { PostgresVaultRepository, VaultFillTarget } from "@space/db";
import { cliBrowserBridgeTokenHeader, verifyCliBrowserBridgeToken } from "../cli-browser-bridge.js";
import type { SpaceApiConfig } from "../config.js";
import { sendApiError } from "../http-errors.js";

// Vault protected panes (ADR-012; automatic since operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac). Each agent or
// Nous fill protects the browser it fills: one hook fences every generic read of it, so the filled value can never be read
// back. Agents keep navigation, clicks, typing and scrolling (they return no page content); only its owner sees it (live
// view); nobody records or diagnoses it. The protection lifts by itself once the filled page is gone.

export type VaultProtectionStore = Pick<PostgresVaultRepository, "protectPane" | "unprotectPane" | "protectedPane">;
type Entry = { owner: string; fill: VaultFillTarget | null } | null;

const CACHE_MS = 5_000;
// Viewers' frame polls ask the Browser Host about the live page at most this often (agents' calls always ask).
const RELEASE_CHECK_MS = 2_000;

/** True once the page a fill landed in is gone: another tab, origin or document, or no web page at all. */
export function vaultFillPageGone(fill: VaultFillTarget, live: VaultHostTarget): boolean {
  // A host started before 2026-10-18 also reports PROFILE_SHARED or SECOND_TARGET, which say nothing about the page.
  if (!live.eligible) return live.reason === "NO_WEB_ORIGIN";
  return live.targetId !== fill.targetId || live.origin !== fill.origin
    || (fill.document !== null && typeof live.document === "string" && live.document !== fill.document);
}

export function createVaultProtection(repository: VaultProtectionStore | null, liveTarget?: (paneId: string) => Promise<VaultHostTarget>) {
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
    async protect(owner: string, paneId: string, fill: VaultFillTarget): Promise<boolean> {
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
      return live !== null && vaultFillPageGone(entry.fill, live) && await unprotect(entry.owner, paneId);
    },
    onProtected(listener: (paneId: string) => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }
  };
}
export type VaultProtection = ReturnType<typeof createVaultProtection>;

const paneBrowserRoute = /^\/api\/panes\/:id\/browser(\/|$)/;
// The owner keeps the live view and control; recordings, captures and diagnostics stay off until the filled page is gone.
const ownerRefused = /^\/api\/panes\/:id\/browser\/(captures|diagnostics)(\/|$)/;
const cliBrowserRoutes = new Set(["/api/cli/browser/actions", "/api/cli/browser/commands", "/api/cli/browser/cdp", "/api/cli/browser/cdp/status", "/api/cli/browser/context"]);
const interactionActions = new Set(["navigate", "click", "type", "scroll", "set_viewport"]);

export function registerVaultFences(app: FastifyInstance, deps: { protection: VaultProtection; config: Pick<SpaceApiConfig, "internalApiToken"> }): void {
  const refuse = (reply: FastifyReply, code: "VAULT_PROTECTED_PANE_PRIVATE" | "VAULT_PROTECTED_SESSION_REQUIRED", message: string) =>
    sendApiError(reply, code === "VAULT_PROTECTED_PANE_PRIVATE" ? 403 : 409, code, message);
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
      // Actions that return no page content stay open, so a login can go on (Next, Sign in) while the fill is in the page.
      const onlyInteraction = route === "/api/cli/browser/actions" && Array.isArray(body.actions) && body.actions.length > 0
        && body.actions.every((entry) => !protectedPanes.has(String(entry?.targetPaneId)) || interactionActions.has(String(entry?.action?.type)));
      if (onlyInteraction) return;
      let released = true;
      for (const id of protectedPanes) released = await deps.protection.release(id) && released;
      if (released) return;
      return refuse(reply, "VAULT_PROTECTED_SESSION_REQUIRED", "This browser holds a Vault fill: until it shows the next page, agents can only navigate, click, type and scroll it (no page reads, DevTools or Playwright).");
    }
  });
}
