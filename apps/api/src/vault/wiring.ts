import type { SiteSigninsRepository } from "@space/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser, Pane, VaultHostFillResult, VaultHostTarget } from "@space/contracts";
import { PostgresVaultRepository } from "@space/db";
import type { BrowserControlActivity } from "../browser-control-activity.js";
import { cookieName, verifySession } from "../auth.js";
import { connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import { parseBody, parseQuery } from "../route-parsing.js";
import { registerSiteSignins } from "../site-signins.js";
import { GitControlError } from "../source-control/errors.js";
import { createVaultAgent, registerVaultAgentRoutes, type VaultAgent } from "./agent.js";
import { VaultBrokerUnavailableError, createSocketVaultBroker, type VaultBroker } from "./broker-client.js";
import { registerVaultFenceHooks } from "./fence-hooks.js";
import { createVaultProtection, registerVaultFences, type VaultProtection, type VaultProtectionStore } from "./protection.js";
import { registerVaultRoutes, type VaultStore } from "./routes.js";

/** Tests replace the storage and the broker. */
export interface VaultOverrides { repository?: (VaultStore & VaultProtectionStore) | null; broker?: VaultBroker }
export type VaultModule = { repository: VaultStore | null; protection: VaultProtection; broker: VaultBroker; agent: VaultAgent };

const unavailable = () => Promise.reject(new VaultBrokerUnavailableError());
/** Dev never reaches stable's sockets, so it has no broker: enrollment and unlock fail closed there. */
const noBroker: VaultBroker = { transportKey: unavailable, delegationKey: unavailable, delegate: unavailable, revoke: unavailable, issueUse: unavailable, openFill: unavailable, sealServerShare: unavailable, unlock: unavailable,
  signupGrant: unavailable, signup: unavailable, signupRevoke: unavailable, signupAutoGrant: unavailable, delegatePending: unavailable };

export function registerVault(app: FastifyInstance, deps: {
  siteSignins?: SiteSigninsRepository;
  config: { databaseUrl?: string | null; instance: string; internalApiToken?: string | null; agentTokenSecret?: string | null };
  auth: { sessionSecret: string };
  store: {
    upsertUser(user: AuthUser): Promise<AuthUser> | AuthUser;
    getPane(paneId: string): Promise<Pane> | Pane;
    getRoom(roomId: string): Promise<{ ownerUserId?: string | null }> | { ownerUserId?: string | null };
    getPaneOwner?(paneId: string): Promise<string | null> | string | null;
    listPanes(roomId: string): Promise<Pane[]> | Pane[];
    listGoogleAccounts?(userId: string): Promise<Array<{ id: string; email: string }>> | Array<{ id: string; email: string }>;
  };
  /** The Google account a pane's browser opens with (its id), or null. */
  paneAccount?(owner: string, pane: Pane): Promise<string | null>;
  controlActivity?: Pick<BrowserControlActivity, "agentFor">;
  /** Whether an agent session scripted this document in the page's own world (the CDP proxy's marks); absent: every fill reloads. */
  documentDirty?(paneId: string, targetId: string, document: string | null): boolean | Promise<boolean>;
  documentDirtiedBy?(paneId: string, targetId: string, document: string | null): string | null | Promise<string | null>;
  /** The Browser Host's sealed fill (absent where no Browser Host runs). */
  browser?: {
    vaultTarget?(pane: Pane): Promise<VaultHostTarget>;
    vaultFill?(pane: Pane, request: unknown, traceId: string): Promise<VaultHostFillResult>;
    listPages?(pane: Pane): Promise<{ pages: Array<{ pageId: string; isActive: boolean }> }>;
  };
  routeOptions: Record<string, unknown>;
  overrides?: VaultOverrides;
  /** Seals the API keys the operator hands to agents (plan clipboard:-qvpC_Q0rAVg). */
  crypto: ConnectorCrypto;
  /** A key just saved (an agent's key-save, the dock's Add key): Space Gateway takes the free ones (gatewayKeyJoiner). */
  keySaved?(owner: string, key: { label: string; value: string }): void;
  /** The kept keys, opened, at start and every six hours: Space Gateway takes the free ones that never joined (gatewayVaultKeyReconciler). */
  reconcileKeys?(keys: Array<{ owner: string; id: string; label: string; value: string }>): Promise<unknown>;
}): VaultModule {
  const { config, overrides = {}, browser } = deps;
  const siteSignins = deps.siteSignins ?? registerSiteSignins(app, deps.store, config.databaseUrl);
  const repository = overrides.repository !== undefined ? overrides.repository
    : config.databaseUrl ? PostgresVaultRepository.fromConnectionString(config.databaseUrl) : null;
  if (repository && overrides.repository === undefined) {
    // Expired nonces can never be used again; drop them every six hours (hardening plan step 16).
    const prune = setInterval(() => void (repository as PostgresVaultRepository).pruneNonces().catch((error) => app.log.warn({ err: error }, "Vault nonce pruning failed.")), 6 * 3_600_000);
    prune.unref();
    app.addHook("onClose", async () => { clearInterval(prune); await (repository as PostgresVaultRepository).dispose(); });
    if (deps.reconcileKeys) {
      const reconcile = async () => {
        const sealed = await (repository as PostgresVaultRepository).listKeptKeySeals();
        const keys = sealed.flatMap((key) => {
          try { return [{ owner: key.owner, id: key.id, label: key.label, value: deps.crypto.open(key.valueSealed, connectorSealContext("vault-handoff-key", key.owner, key.id)) }]; }
          catch { return []; }
        });
        await deps.reconcileKeys!(keys);
      };
      const run = () => void reconcile().catch((error) => app.log.warn({ err: error }, "Vault keys could not be reconciled with Space Gateway."));
      // After start (the gateway may still be starting), then every six hours.
      const first = setTimeout(run, 90_000);
      const every = setInterval(run, 6 * 3_600_000);
      first.unref(); every.unref();
      app.addHook("onClose", async () => { clearTimeout(first); clearInterval(every); });
    }
  }
  const broker = overrides.broker ?? (config.instance === "stable" ? createSocketVaultBroker() : noBroker);
  // A fill's protection lifts once the Browser Host shows its page is gone (its tab closed, or the tab shows another page).
  const protection = createVaultProtection(repository as (VaultStore & VaultProtectionStore) | null,
    browser?.vaultTarget ? async (paneId) => browser.vaultTarget!(await deps.store.getPane(paneId)) : undefined,
    browser?.listPages ? async (paneId) => (await browser.listPages!(await deps.store.getPane(paneId))).pages : undefined);
  registerVaultFences(app, { protection, config: { internalApiToken: config.internalApiToken ?? null, agentTokenSecret: config.agentTokenSecret ?? null } });
  const paneOwner = async (paneId: string) => {
    try {
      const pane = await deps.store.getPane(paneId);
      return (await deps.store.getPaneOwner?.(paneId)) ?? (await deps.store.getRoom(pane.roomId)).ownerUserId ?? null;
    } catch { return null; }
  };
  // A completed handoff fences the page the operator worked in; the CDP proxy hides fenced tabs from other panes.
  registerVaultFenceHooks(deps.store, {
    async fenceHandoff(paneId, viewer) {
      const owner = await paneOwner(paneId);
      if (!owner || !browser?.vaultTarget) return;
      const live = await browser.vaultTarget(await deps.store.getPane(paneId));
      if (!live.eligible || !live.targetId || !live.origin) return;
      await protection.protect(owner, paneId, { targetId: live.targetId, origin: live.origin, document: live.document ?? null }, viewer);
    },
    fencedTargets: (paneId) => protection.fencedTargets(paneId)
  });
  registerVaultRoutes(app, {
    repository, parseBody, parseQuery, broker, crypto: deps.crypto, keySaved: deps.keySaved,
    routeOptions: deps.routeOptions,
    strictRouteOptions: { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    owner: async (request) => {
      if (!request.user || !verifySession(request.cookies[cookieName], deps.auth.sessionSecret)) throw new GitControlError("UNAUTHENTICATED", "Sign in to use the Vault.", 401);
      // Proof and capture sessions act for the operator but never hold a key to their Vault.
      if (request.user.automationScope) throw new GitControlError("VAULT_AUTOMATION_REFUSED", "Automation sessions cannot use the Vault.", 403);
      return (await deps.store.upsertUser(request.user)).id;
    }
  });
  const agent = createVaultAgent({ siteSignins, repository, broker, protection, browser, paneOwner, crypto: deps.crypto, keySaved: deps.keySaved, listPanes: async (roomId) => deps.store.listPanes(roomId), controlActivity: deps.controlActivity,
    googleAccounts: deps.store.listGoogleAccounts ? async (owner) => deps.store.listGoogleAccounts!(owner) : undefined, paneAccount: deps.paneAccount, documentDirty: deps.documentDirty, documentDirtiedBy: deps.documentDirtiedBy });
  return { repository, protection, broker, agent };
}

/**
 * `space-admin-action gateway-api-key-add --vault-key` (nous_msg:71a41c2e): a kept key for Space Gateway, read through the Vault
 * agent's own key-take (agent access on, audited as pane `space-admin-action`), so the value never reaches the caller.
 */
export function vaultKeyReader(store: Pick<Parameters<typeof registerVault>[1]["store"], "upsertUser">, vault: () => VaultModule) {
  return async (request: FastifyRequest, id: string) => {
    const owner = (await store.upsertUser(request.user!)).id;
    const call = (path: "key-take" | "key-used") => vault().agent.call({ owner, paneId: "space-admin-action", roomId: "", path, body: { id }, traceId: String(request.id) });
    const taken = await call("key-take");
    return taken.status === "TAKEN" && typeof taken.value === "string" ? { value: taken.value, used: () => call("key-used") } : { reason: String(taken.reason ?? taken.status) };
  };
}

/** Agent routes on the CLI bridge: the owner is the pane's explicit owner, else the room's, from the verified token only. */
export function registerVaultAgentBridge(app: FastifyInstance, vault: VaultModule, deps: {
  store: {
    getRoom(roomId: string): Promise<{ ownerUserId?: string | null }> | { ownerUserId?: string | null };
    getPaneOwner?(paneId: string): Promise<string | null> | string | null;
  };
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: { roomId: string; paneId: string } } | null>;
}): void {
  registerVaultAgentRoutes(app, {
    agent: vault.agent, parseBody,
    // No Vault-specific limit for agents (operator request 2026-10-20); the API's global per-client limit still applies.
    routeOptions: {},
    requireOwner: async (request, reply) => {
      const bridge = await deps.requireBridge(request, reply);
      if (!bridge) return null;
      const owner = (await deps.store.getPaneOwner?.(bridge.claims.paneId)) ?? (await deps.store.getRoom(bridge.claims.roomId)).ownerUserId ?? null;
      return { owner, paneId: bridge.claims.paneId, roomId: bridge.claims.roomId };
    }
  });
}
