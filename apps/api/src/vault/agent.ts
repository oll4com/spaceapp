import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  newVaultHandle, sealToVaultPublicKey, vaultAgentAuditRequestSchema, vaultAgentAuditResultSchema, vaultAgentEmptyRequestSchema, vaultAgentFillRequestSchema,
  vaultAgentGenerateRequestSchema, vaultAgentListRequestSchema, vaultAgentListResultSchema, vaultAgentResultSchema, vaultAgentSaveRequestSchema, vaultAgentSaveSite, vaultAgentStatusResultSchema,
  vaultAgentTotpRequestSchema, vaultBase64url, vaultAgentKeyRequestSchema, vaultAgentKeyTakeResultSchema,
  type Pane, type VaultAgentResult, type VaultAuditEvent, type VaultHostFillResult, type VaultHostTarget
} from "@space/contracts";
import { connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import { isBrowserPane } from "../pane-guards.js";
import type { VaultBroker } from "./broker-client.js";
import type { VaultProtection } from "./protection.js";
import { cliVaultPathPrefix, type VaultStore } from "./routes.js";
import { handOverPendingLogin } from "./handover.js";
import { runVaultSignup } from "./signup.js";

// What agents and Nous may do with the Vault (operator decision 2026-10-18, plan clipboard:Ml8zElMcc4Ac). One switch in the
// dock is the whole authorization: while it is on, every item the dock delegated fills with no further approval, and new
// logins can be saved. The value never reaches the caller: the Browser Host types it, the fill's browser stays protected until
// the filled page is gone, and every answer is a status, a reason in the audit and, for a list, handles and origins only.
// Nous calls the same paths as the agents' bridge, so both have identical access.

export const VAULT_AGENT_PATHS = ["status", "list", "audit", "fill", "totp-fill", "generate-fill", "save", "key-take", "key-used"] as const;
export type VaultAgentPath = (typeof VAULT_AGENT_PATHS)[number];
const actions: Record<VaultAgentPath, VaultAuditEvent["action"]> = {
  status: "AGENT_LIST", list: "AGENT_LIST", audit: "AGENT_LIST", fill: "FILL", "totp-fill": "FILL", "generate-fill": "GENERATE", save: "ITEM_SAVE",
  "key-take": "KEY_HANDOFF", "key-used": "KEY_HANDOFF"
};

/**
 * `itemId`: the item a new login or generated password becomes, so the audit (and the dock's Activity) names it. `typed` and
 * `document` come from the Browser Host (never to the caller): a value entered the page, and the document it ran in.
 */
type Outcome = { status: VaultAgentResult["status"]; reason: string | null; itemId?: string; extra?: Record<string, unknown>; typed?: boolean; document?: string | null };
export interface VaultAgentCall {
  owner: string;
  /** The calling pane (a CLI pane, or the pane Nous named). */
  paneId: string;
  roomId: string;
  path: VaultAgentPath;
  body: Record<string, unknown>;
  traceId: string;
}

export function createVaultAgent(deps: {
  repository: VaultStore | null;
  broker: VaultBroker;
  protection: VaultProtection;
  listPanes(roomId: string): Promise<Pane[]>;
  /** The pane's owner (its explicit owner, else its room's); null when the pane does not exist. */
  paneOwner(paneId: string): Promise<string | null>;
  /** The Browser Host's sealed fill (absent where no Browser Host runs). */
  browser?: { vaultTarget?(pane: Pane): Promise<VaultHostTarget>; vaultFill?(pane: Pane, request: unknown, traceId: string): Promise<VaultHostFillResult> };
  /** The owner's Google accounts (id and address): a list names each login's account (Chrome imports, plan clipboard:SMcT__jALB6R). */
  googleAccounts?(owner: string): Promise<Array<{ id: string; email: string }>>;
  /** The Google account a pane's browser opens with (its id), or null. */
  paneAccount?(owner: string, pane: Pane): Promise<string | null>;
  /**
   * Whether an agent session scripted or changed this document in the page's own world (the CDP proxy's marks): the host then
   * starts from a fresh document. Absent: the host reloads every time (its safe default).
   */
  documentDirty?(paneId: string, targetId: string, document: string | null): boolean | Promise<boolean>;
  /** Opens the API keys the operator handed to agents (sealed by the operator route with the same key). */
  crypto: ConnectorCrypto;
}) {
  const blocked = (reason: string): Outcome => ({ status: "BLOCKED", reason });

  const handOverPending = (repository: VaultStore, owner: string, handle: string) => handOverPendingLogin(repository, deps.broker, owner, handle);

  /** The browser to fill: the named pane, else the caller's own browser, else the room's first browser pane; always the owner's. */
  async function browserPane(call: VaultAgentCall): Promise<Pane | null> {
    const panes = (await deps.listPanes(call.roomId)).filter((pane) => !pane.isClosed);
    const named = call.body.targetPaneId;
    const pane = typeof named === "string" ? panes.find((entry) => entry.id === named)
      : panes.find((entry) => entry.id === call.paneId && isBrowserPane(entry)) ?? panes.find((entry) => entry.mode === "BROWSER");
    return pane && isBrowserPane(pane) && await deps.paneOwner(pane.id) === call.owner ? pane : null;
  }

  async function fill(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    const { owner, path, body, traceId } = call;
    const host = deps.browser;
    if (!host?.vaultTarget || !host.vaultFill) return blocked("FILL_PATH_UNAVAILABLE");
    const { vaultTarget, vaultFill } = host;
    const pane = await browserPane(call);
    if (!pane) return blocked("NO_BROWSER");
    const live = async () => {
      const target = await vaultTarget(pane);
      return target.eligible && target.targetId && target.frameId && target.origin
        ? { targetId: target.targetId, frameId: target.frameId, origin: target.origin, document: target.document ?? null, freshDocument: target.freshDocument === true } : target.reason ?? "NOT_ELIGIBLE";
    };
    // What the host is told about the document: reload only one an agent session touched in the page's own world. Only a host
    // that takes the field gets it (an older host's strict request schema would refuse the fill).
    const freshness = async (target: { targetId: string; document: string | null; freshDocument: boolean }) =>
      deps.documentDirty && target.freshDocument ? { freshDocument: await deps.documentDirty(pane.id, target.targetId, target.document) } : {};
    // The browser is fenced before any value exists; a fill that typed nothing leaves it as it was. One that typed anything keeps
    // the fence, whatever happened after (Vault review 2026-10-22): a failed fill's scrub is best effort.
    const wasProtected = await deps.protection.ownerOf(pane.id) === owner;
    const guarded = async (target: { targetId: string; origin: string; document: string | null }, run: () => Promise<Outcome>): Promise<Outcome> => {
      if (!await deps.protection.protect(owner, pane.id, { targetId: target.targetId, origin: target.origin, document: target.document })) return blocked("PANE_PROTECTED_ELSEWHERE");
      const outcome = await run().catch((): Outcome => blocked("FILL_FAILED"));
      const kept = outcome.status === "FILLED" || outcome.status === "SUBMITTED" || outcome.typed === true;
      // The host reloaded the page before typing (a fresh document, with no script an agent left in it): the fence follows that document.
      if (kept && outcome.document && outcome.document !== target.document) {
        await deps.protection.protect(owner, pane.id, { targetId: target.targetId, origin: target.origin, document: outcome.document });
      }
      if (!wasProtected && !kept) await deps.protection.unprotect(owner, pane.id);
      return outcome;
    };

    // A new account (or a reset of an account without an item) has no item yet: it runs under a sign-up grant the operator
    // signed for the site (option B, signup.ts), else under one the broker mints from the dock's delegation.
    if (path === "generate-fill" && body.purpose === "NEW_ACCOUNT") {
      const target = await live();
      if (typeof target === "string") return blocked(target);
      const delegation = await repository.getActiveDelegation(owner);
      // Neither: refused before the browser's automation connections are closed.
      if (!delegation && !(await repository.listSignupGrants(owner)).some((grant) => grant.sites.includes(target.origin))) return blocked("NO_SIGNUP_GRANT");
      const autoGrant = delegation ? () => deps.broker.signupAutoGrant({ ownerUserId: owner, vaultId: delegation.certificate.claims.vaultId,
        certificate: delegation.certificate, origin: target.origin }) : undefined;
      const fresh = await freshness(target);
      const created = await guarded(target, () => runVaultSignup({ repository, fill: (request) => vaultFill(pane, { mode: "SIGNUP", ...request, ...fresh }, traceId), autoGrant },
        { owner, paneId: pane.id, target, label: String(body.label), username: typeof body.username === "string" ? body.username : null,
          roles: Array.isArray(body.roles) && body.roles.length ? body.roles as Array<"NEW_PASSWORD" | "CONFIRM_PASSWORD"> : ["NEW_PASSWORD"], submit: body.submit === true }));
      if (created.itemId) await handOverPending(repository, owner, created.itemId);
      return created;
    }
    const handle = path === "generate-fill" ? String(body.handle) : await paneAccountLogin(repository, owner, pane, String(body.handle));
    const fields = path === "totp-fill" ? ["OTP"] : path === "generate-fill" ? ["PASSWORD"] : (body.fields as string[]);
    const delegation = await repository.getActiveDelegation(owner);
    const delegated = delegation?.certificate.claims.items.find((item) => item.handle === handle);
    if (!delegation || !delegated || fields.some((field) => !delegated.fields.includes(field as never))) return blocked("NOT_DELEGATED");
    // Deleted or hidden since the dock last delegated: the stale envelopes are never used. A login agents saved since the
    // last unlock is no item yet, only its inbox entry.
    const item = await repository.getItem(owner, handle);
    const saved = item ? null : (await repository.listPending(owner)).find((entry) => entry.handle === handle);
    if (item ? item.metadata.status !== "ACTIVE" || !item.metadata.policy.agentUse : !saved) return blocked("NOT_DELEGATED");
    const label = item?.metadata.label ?? saved!.label;
    const submit = body.submit === true;
    if (submit && !delegated.submit) return blocked("SUBMIT_NOT_ALLOWED");
    const target = await live();
    if (typeof target === "string") return blocked(target);
    if (!delegated.origins.includes(target.origin)) return { status: "ORIGIN_MISMATCH", reason: "ORIGIN_NOT_DELEGATED" };
    // A generated password is sealed by the Browser Host to the operator's inbox key and joins the delegation at once.
    const inbox = path === "generate-fill" ? await repository.getInbox(owner) : null;
    if (path === "generate-fill" && !inbox) return blocked("INBOX_NOT_READY");
    const epoch = (await repository.getVault(owner))?.epoch;
    if (!epoch) return blocked("NOT_ENROLLED");
    const roles = Array.isArray(body.roles) && body.roles.length ? body.roles as string[] : ["NEW_PASSWORD"];
    const { capability } = await deps.broker.issueUse({ ownerUserId: owner, vaultId: delegation.certificate.claims.vaultId, certificate: delegation.certificate, epoch,
      handle, fields, submit, paneId: pane.id, targetId: target.targetId, pageId: target.targetId, frameId: target.frameId, origin: target.origin,
      ...(inbox ? { generate: { roles, inboxPublicKey: inbox.publicKey } } : {}) });
    const fresh = await freshness(target);
    return guarded(target, async () => {
      const result = await vaultFill(pane, { mode: path === "totp-fill" ? "TOTP" : path === "generate-fill" ? "GENERATE" : "FILL", capability,
        keyEnvelope: delegation.keyEnvelope, fieldEnvelopes: delegation.fillEnvelopes[handle] ?? {}, ...fresh }, traceId);
      if (result.sealedGenerated && (result.status === "FILLED" || result.status === "SUBMITTED")) {
        await repository.addPending(owner, { id: newVaultHandle("vault_pending"), kind: "CHANGE_PASSWORD", handle, label,
          origin: target.origin, sealedUsername: null, sealedPassword: result.sealedGenerated, paneId: pane.id, createdAt: new Date().toISOString() });
        await handOverPending(repository, owner, handle);
      }
      return { status: result.status, reason: result.reason, itemId: handle, typed: result.typed, document: result.document };
    });
  }

  /**
   * The same site and username saved under several Google accounts (Chrome imports): a fill into a pane browser on account X
   * uses X's login when exactly one such login exists (the browser-made login key says it is the same login).
   */
  async function paneAccountLogin(repository: VaultStore, owner: string, pane: Pane, handle: string): Promise<string> {
    const item = await repository.getItem(owner, handle);
    const account = item?.metadata.loginKey && deps.paneAccount ? await deps.paneAccount(owner, pane).catch(() => null) : null;
    if (!item || !account || item.metadata.googleAccountId === account) return handle;
    // Only a login the delegation holds can stand in (an older broker holds at most 200).
    const delegated = new Set((await repository.getActiveDelegation(owner))?.certificate.claims.items.map((entry) => entry.handle));
    const twins = (await repository.itemsByLoginKey(owner, item.metadata.loginKey!)).filter((other) => other.id !== handle && other.googleAccountId === account
      && other.status === "ACTIVE" && other.policy.agentUse && delegated.has(other.id));
    return twins.length === 1 ? twins[0]!.id : handle;
  }

  /** A login the caller created: sealed at once to the operator's inbox key and fillable at once; the dock adds it as an item on its next unlock. */
  async function save(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    const vault = await repository.getVault(call.owner);
    const inbox = vault && await repository.getInbox(call.owner);
    if (!vault || !inbox) return blocked("INBOX_NOT_READY");
    const scope = { ownerUserId: call.owner, vaultId: vault.vaultId, keyVersion: 1 };
    const seal = (text: string) => sealToVaultPublicKey(vaultBase64url.decode(inbox.publicKey), new TextEncoder().encode(text), scope);
    const { site, username, password, label } = call.body as { site: string; username: string; password?: string; label: string };
    const handle = newVaultHandle("vault_item");
    await repository.addPending(call.owner, { id: newVaultHandle("vault_pending"), kind: "NEW_ACCOUNT", handle, label,
      origin: vaultAgentSaveSite(site)!, sealedUsername: await seal(username), sealedPassword: password ? await seal(password) : null, paneId: call.paneId, createdAt: new Date().toISOString() });
    await handOverPending(repository, call.owner, handle);
    return { status: "SAVED", reason: null, itemId: handle };
  }

  /**
   * An API key the operator pasted for agents (operator request 2026-10-22, plan clipboard:-qvpC_Q0rAVg): this pane takes its
   * value once (the relay writes the file, the agent never sees it) and confirms the write, which deletes the value.
   */
  async function handoff(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    const id = String(call.body.id);
    if (call.path === "key-used") return (await repository.useHandoffKey(call.owner, id, call.paneId)) ? { status: "USED", reason: null } : blocked("KEY_NOT_TAKEN");
    const taken = await repository.takeHandoffKey(call.owner, id, call.paneId);
    if (!taken) return blocked("KEY_UNAVAILABLE");
    try { return { status: "TAKEN", reason: null, extra: { value: deps.crypto.open(taken.valueSealed, connectorSealContext("vault-handoff-key", call.owner, id)) } }; }
    catch { return blocked("KEY_UNREADABLE"); }
  }

  async function outcome(repository: VaultStore, call: VaultAgentCall): Promise<Outcome> {
    const vault = await repository.getVault(call.owner);
    if (call.path === "audit") {
      const limit = typeof call.body.limit === "number" ? call.body.limit : 20;
      const entries = (await repository.listAudit(call.owner, { limit: 200 })).filter((entry) => entry.event.paneId === call.paneId).slice(0, limit)
        .map((entry) => ({ at: entry.createdAt, action: entry.event.action, result: entry.event.result, reason: entry.event.reason, itemId: entry.event.itemId }));
      return { status: "LISTED", reason: null, extra: { entries } };
    }
    const delegated = vault?.agentAccess ? (await repository.getActiveDelegation(call.owner))?.certificate.claims.items ?? [] : [];
    // Saved and generated logins the dock has not added as items yet (they are fillable already when they joined the delegation).
    const pending = vault ? await repository.listPending(call.owner) : [];
    const pendingItems = pending.length;
    if (call.path === "status") return { status: "LISTED", reason: null, extra: { agentAccess: vault?.agentAccess ?? false, delegatedItems: delegated.length, pendingItems } };
    if (!vault) return blocked("NOT_ENROLLED");
    if (!vault.agentAccess) return blocked("AGENT_ACCESS_OFF");
    if (call.path === "save") return save(repository, call);
    if (call.path === "key-take" || call.path === "key-used") return handoff(repository, call);
    if (call.path === "list") {
      const accounts = new Map((await deps.googleAccounts?.(call.owner).catch(() => []) ?? []).map((account) => [account.id, account.email]));
      const items = [];
      const filter = listFilter(call.body);
      // One read for every item: a delegation holds as many logins as the Vault has.
      const metadata = new Map((await repository.listItems(call.owner)).map((entry) => [entry.id, entry]));
      for (const item of delegated) {
        const stored = metadata.get(item.handle);
        const label = stored ? stored.status === "ACTIVE" && stored.policy.agentUse ? stored.label : null
          : pending.find((entry) => entry.handle === item.handle)?.label ?? null;
        const account = stored?.googleAccountId ? accounts.get(stored.googleAccountId) : undefined;
        if (filter.account && account?.toLowerCase() !== filter.account) continue;
        if (filter.host && !item.origins.some((origin) => { const host = new URL(origin).hostname; return host === filter.host || host.endsWith(`.${filter.host}`); })) continue;
        if (label) items.push({ handle: item.handle, label, origins: item.origins, fields: item.fields, ...(account ? { account } : {}) });
      }
      return { status: "LISTED", reason: null, extra: { items, pendingItems } };
    }
    return fill(repository, call);
  }

  return {
    /** One audited agent or Nous call; the answer is the fixed agent shape for its path. */
    async call(call: VaultAgentCall): Promise<Record<string, unknown>> {
      const repository = deps.repository;
      if (!repository) return vaultAgentResultSchema.parse({ status: "BLOCKED", auditId: null });
      const result = await outcome(repository, call).catch((): Outcome => blocked("FILL_FAILED"));
      const audited = await repository.appendAudit(call.owner, { actor: "AGENT", action: actions[call.path], result: result.status, reason: result.reason,
        itemId: result.itemId ?? (typeof call.body.handle === "string" ? call.body.handle : null), paneId: call.paneId });
      const answer = { status: result.status, auditId: audited?.id ?? null, ...result.extra };
      // The one answer that carries a value: the relay writes it into the file and never shows it to the agent.
      if (call.path === "key-take" && result.status === "TAKEN") return vaultAgentKeyTakeResultSchema.parse({ ...answer, reason: null });
      // The audit's short code goes with the status (2026-10-22), so a fill answer can be acted on (FIELD_NOT_FOUND_AFTER_RELOAD).
      if (result.status !== "LISTED") return vaultAgentResultSchema.parse({ ...answer, reason: result.reason ?? null });
      return (call.path === "status" ? vaultAgentStatusResultSchema : call.path === "audit" ? vaultAgentAuditResultSchema : vaultAgentListResultSchema).parse(answer);
    }
  };
}
export type VaultAgent = ReturnType<typeof createVaultAgent>;

/** space_vault_list's filters: the site's host (an address or a bare host name) and the account address, lower-case. */
function listFilter(body: Record<string, unknown>): { host: string | null; account: string | null } {
  const site = typeof body.site === "string" ? body.site.trim() : "";
  let host: string | null = null;
  if (site) { try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`).hostname.toLowerCase(); } catch { host = site.toLowerCase(); } }
  return { host, account: typeof body.account === "string" ? body.account.trim().toLowerCase() : null };
}

export interface VaultAgentRouteDependencies {
  agent: VaultAgent;
  /** The verified bridge's pane owner (the pane's explicit owner, else the room's); null when the pane has none. */
  requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<{ owner: string | null; paneId: string; roomId: string } | null>;
  routeOptions: Record<string, unknown>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
}

const agentSchemas: Record<VaultAgentPath, z.ZodTypeAny> = {
  status: vaultAgentEmptyRequestSchema, list: vaultAgentListRequestSchema, audit: vaultAgentAuditRequestSchema, fill: vaultAgentFillRequestSchema,
  "totp-fill": vaultAgentTotpRequestSchema, "generate-fill": vaultAgentGenerateRequestSchema, save: vaultAgentSaveRequestSchema,
  "key-take": vaultAgentKeyRequestSchema, "key-used": vaultAgentKeyRequestSchema
};

/** Every agent call is validated and audited; a pane without an owner has no Vault to use. */
export function registerVaultAgentRoutes(app: FastifyInstance, deps: VaultAgentRouteDependencies): void {
  for (const [path, schema] of Object.entries(agentSchemas) as Array<[VaultAgentPath, z.ZodTypeAny]>) {
    app.post(`${cliVaultPathPrefix}${path}`, deps.routeOptions, async (request, reply) => {
      const context = await deps.requireOwner(request, reply);
      if (!context) return reply;
      const body = deps.parseBody(schema, request.body ?? {}) as Record<string, unknown>;
      if (!context.owner) return vaultAgentResultSchema.parse({ status: "BLOCKED", auditId: null });
      return deps.agent.call({ owner: context.owner, paneId: context.paneId, roomId: context.roomId, path, body, traceId: request.requestIdForSpace ?? "" });
    });
  }
}
