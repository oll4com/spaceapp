import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import {
  newVaultHandle, sealToVaultPublicKey, vaultAgentAuditRequestSchema, vaultAgentAuditResultSchema, vaultAgentEmptyRequestSchema, vaultAgentFillRequestSchema,
  vaultAgentGenerateRequestSchema, vaultAgentListResultSchema, vaultAgentResultSchema, vaultAgentSaveRequestSchema, vaultAgentSaveSite, vaultAgentStatusResultSchema,
  vaultAgentTotpRequestSchema, vaultBase64url, type Pane, type VaultAgentResult, type VaultAuditEvent, type VaultHostFillResult, type VaultHostTarget
} from "@space/contracts";
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

export const VAULT_AGENT_PATHS = ["status", "list", "audit", "fill", "totp-fill", "generate-fill", "save"] as const;
export type VaultAgentPath = (typeof VAULT_AGENT_PATHS)[number];
const actions: Record<VaultAgentPath, VaultAuditEvent["action"]> = {
  status: "AGENT_LIST", list: "AGENT_LIST", audit: "AGENT_LIST", fill: "FILL", "totp-fill": "FILL", "generate-fill": "GENERATE", save: "ITEM_SAVE"
};

/** `itemId`: the item a new login or generated password becomes, so the audit (and the dock's Activity) names it. */
type Outcome = { status: VaultAgentResult["status"]; reason: string | null; itemId?: string; extra?: Record<string, unknown> };
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
        ? { targetId: target.targetId, frameId: target.frameId, origin: target.origin, document: target.document ?? null } : target.reason ?? "NOT_ELIGIBLE";
    };
    // The browser is fenced before any value exists; a fill that typed nothing leaves it as it was.
    const wasProtected = await deps.protection.ownerOf(pane.id) === owner;
    const guarded = async (target: { targetId: string; origin: string; document: string | null }, run: () => Promise<Outcome>): Promise<Outcome> => {
      if (!await deps.protection.protect(owner, pane.id, { targetId: target.targetId, origin: target.origin, document: target.document })) return blocked("PANE_PROTECTED_ELSEWHERE");
      const outcome = await run().catch((): Outcome => blocked("FILL_FAILED"));
      if (!wasProtected && outcome.status !== "FILLED" && outcome.status !== "SUBMITTED") await deps.protection.unprotect(owner, pane.id);
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
      const created = await guarded(target, () => runVaultSignup({ repository, fill: (request) => vaultFill(pane, { mode: "SIGNUP", ...request }, traceId), autoGrant },
        { owner, paneId: pane.id, target, label: String(body.label), username: typeof body.username === "string" ? body.username : null,
          roles: Array.isArray(body.roles) && body.roles.length ? body.roles as Array<"NEW_PASSWORD" | "CONFIRM_PASSWORD"> : ["NEW_PASSWORD"], submit: body.submit === true }));
      if (created.itemId) await handOverPending(repository, owner, created.itemId);
      return created;
    }
    const handle = String(body.handle);
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
    return guarded(target, async () => {
      const result = await vaultFill(pane, { mode: path === "totp-fill" ? "TOTP" : path === "generate-fill" ? "GENERATE" : "FILL", capability,
        keyEnvelope: delegation.keyEnvelope, fieldEnvelopes: delegation.fillEnvelopes[handle] ?? {} }, traceId);
      if (result.sealedGenerated && (result.status === "FILLED" || result.status === "SUBMITTED")) {
        await repository.addPending(owner, { id: newVaultHandle("vault_pending"), kind: "CHANGE_PASSWORD", handle, label,
          origin: target.origin, sealedUsername: null, sealedPassword: result.sealedGenerated, paneId: pane.id, createdAt: new Date().toISOString() });
        await handOverPending(repository, owner, handle);
      }
      return { status: result.status, reason: result.reason };
    });
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
    if (call.path === "list") {
      const items = [];
      for (const item of delegated) {
        const stored = await repository.getItem(call.owner, item.handle);
        const label = stored ? stored.metadata.status === "ACTIVE" && stored.metadata.policy.agentUse ? stored.metadata.label : null
          : pending.find((entry) => entry.handle === item.handle)?.label ?? null;
        if (label) items.push({ handle: item.handle, label, origins: item.origins, fields: item.fields });
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
      if (result.status !== "LISTED") return vaultAgentResultSchema.parse(answer);
      return (call.path === "status" ? vaultAgentStatusResultSchema : call.path === "audit" ? vaultAgentAuditResultSchema : vaultAgentListResultSchema).parse(answer);
    }
  };
}
export type VaultAgent = ReturnType<typeof createVaultAgent>;

export interface VaultAgentRouteDependencies {
  agent: VaultAgent;
  /** The verified bridge's pane owner (the pane's explicit owner, else the room's); null when the pane has none. */
  requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<{ owner: string | null; paneId: string; roomId: string } | null>;
  routeOptions: Record<string, unknown>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
}

const agentSchemas: Record<VaultAgentPath, z.ZodTypeAny> = {
  status: vaultAgentEmptyRequestSchema, list: vaultAgentEmptyRequestSchema, audit: vaultAgentAuditRequestSchema, fill: vaultAgentFillRequestSchema,
  "totp-fill": vaultAgentTotpRequestSchema, "generate-fill": vaultAgentGenerateRequestSchema, save: vaultAgentSaveRequestSchema
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
