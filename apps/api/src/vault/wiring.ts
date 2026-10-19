import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser, Pane, VaultHostFillResult, VaultHostTarget } from "@space/contracts";
import { PostgresVaultRepository } from "@space/db";
import { cookieName, verifySession } from "../auth.js";
import { parseBody, parseQuery } from "../route-parsing.js";
import { GitControlError } from "../source-control/errors.js";
import { createVaultAgent, registerVaultAgentRoutes, type VaultAgent } from "./agent.js";
import { VaultBrokerUnavailableError, createSocketVaultBroker, type VaultBroker } from "./broker-client.js";
import { createVaultProtection, registerVaultFences, type VaultProtection, type VaultProtectionStore } from "./protection.js";
import { registerVaultRoutes, type VaultStore } from "./routes.js";

/** Tests replace the storage and the broker. */
export interface VaultOverrides { repository?: (VaultStore & VaultProtectionStore) | null; broker?: VaultBroker }
export type VaultModule = { repository: VaultStore | null; protection: VaultProtection; broker: VaultBroker; agent: VaultAgent };

const unavailable = () => Promise.reject(new VaultBrokerUnavailableError());
/** Dev never reaches stable's sockets, so it has no broker: enrollment and unlock fail closed there. */
const noBroker: VaultBroker = { transportKey: unavailable, delegationKey: unavailable, delegate: unavailable, revoke: unavailable, issueUse: unavailable, openFill: unavailable, sealServerShare: unavailable, unlock: unavailable,
  signupGrant: unavailable, signup: unavailable, signupRevoke: unavailable };

export function registerVault(app: FastifyInstance, deps: {
  config: { databaseUrl?: string | null; instance: string; internalApiToken?: string | null };
  auth: { sessionSecret: string };
  store: {
    upsertUser(user: AuthUser): Promise<AuthUser> | AuthUser;
    getPane(paneId: string): Promise<Pane> | Pane;
    getRoom(roomId: string): Promise<{ ownerUserId?: string | null }> | { ownerUserId?: string | null };
    getPaneOwner?(paneId: string): Promise<string | null> | string | null;
    listPanes(roomId: string): Promise<Pane[]> | Pane[];
  };
  /** The Browser Host's sealed fill (absent where no Browser Host runs). */
  browser?: { vaultTarget?(pane: Pane): Promise<VaultHostTarget>; vaultFill?(pane: Pane, request: unknown, traceId: string): Promise<VaultHostFillResult> };
  routeOptions: Record<string, unknown>;
  overrides?: VaultOverrides;
}): VaultModule {
  const { config, overrides = {}, browser } = deps;
  const repository = overrides.repository !== undefined ? overrides.repository
    : config.databaseUrl ? PostgresVaultRepository.fromConnectionString(config.databaseUrl) : null;
  if (repository && overrides.repository === undefined) app.addHook("onClose", async () => (repository as PostgresVaultRepository).dispose());
  const broker = overrides.broker ?? (config.instance === "stable" ? createSocketVaultBroker() : noBroker);
  // A fill's protection lifts once the Browser Host shows its page is gone.
  const protection = createVaultProtection(repository as (VaultStore & VaultProtectionStore) | null,
    browser?.vaultTarget ? async (paneId) => browser.vaultTarget!(await deps.store.getPane(paneId)) : undefined);
  registerVaultFences(app, { protection, config: { internalApiToken: config.internalApiToken ?? null } });
  const paneOwner = async (paneId: string) => {
    try {
      const pane = await deps.store.getPane(paneId);
      return (await deps.store.getPaneOwner?.(paneId)) ?? (await deps.store.getRoom(pane.roomId)).ownerUserId ?? null;
    } catch { return null; }
  };
  registerVaultRoutes(app, {
    repository, parseBody, parseQuery, broker,
    routeOptions: deps.routeOptions,
    strictRouteOptions: { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    owner: async (request) => {
      if (!request.user || !verifySession(request.cookies[cookieName], deps.auth.sessionSecret)) throw new GitControlError("UNAUTHENTICATED", "Sign in to use the Vault.", 401);
      // Proof and capture sessions act for the operator but never hold a key to their Vault.
      if (request.user.automationScope) throw new GitControlError("VAULT_AUTOMATION_REFUSED", "Automation sessions cannot use the Vault.", 403);
      return (await deps.store.upsertUser(request.user)).id;
    }
  });
  const agent = createVaultAgent({ repository, broker, protection, browser, paneOwner, listPanes: async (roomId) => deps.store.listPanes(roomId) });
  return { repository, protection, broker, agent };
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
    routeOptions: { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    requireOwner: async (request, reply) => {
      const bridge = await deps.requireBridge(request, reply);
      if (!bridge) return null;
      const owner = (await deps.store.getPaneOwner?.(bridge.claims.paneId)) ?? (await deps.store.getRoom(bridge.claims.roomId)).ownerUserId ?? null;
      return { owner, paneId: bridge.claims.paneId, roomId: bridge.claims.roomId };
    }
  });
}
