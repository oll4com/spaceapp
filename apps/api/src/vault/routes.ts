import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  vaultAgentAccessRequestSchema, vaultAuditQuerySchema, vaultEnrollRequestSchema,
  vaultItemIdSchema, vaultItemRecordSchema, vaultPasswordRotateRequestSchema, vaultRecoverySetRequestSchema, vaultUnlockRequestSchema,
  vaultBase64url, vaultCanonicalJson, vaultDelegateRequestSchema, vaultInboxKeySetRequestSchema, vaultPendingIdSchema,
  vaultDelegationCertificateSchema, vaultDigest, verifyVaultCertificate, verifyVaultMessage, vaultOperatorRequestMessage,
  vaultSignupGrantCertificateSchema, vaultSignupGrantIdSchema, vaultSignupGrantRequestSchema, VAULT_SIGNUP_GRANT_LIMITS, VAULT_BROKER_API_MAX_BYTES,
  vaultItemBatchRequestSchema, vaultItemDeleteRequestSchema, vaultSiteCheckRequestSchema, type VaultAuditEvent, type VaultOperatorSignedKind,
  newVaultHandle, vaultHandoffKeyCreateRequestSchema, vaultHandoffKeyIdSchema
} from "@space/contracts";
import { VaultConflictError, type PostgresVaultRepository, type VaultState } from "@space/db";
import { connectorSealContext, type ConnectorCrypto } from "../dot-connectors.js";
import { GitControlError } from "../source-control/errors.js";
import { VaultBrokerRefusedError, VaultBrokerUnavailableError, type VaultBroker } from "./broker-client.js";
import { handOverPendingLogin } from "./handover.js";
import { checkVaultSites, type VaultSiteResult } from "./site-check.js";

// Vault routes (plan clipboard:vEYtT6-bEN0J step 4, ADR-012). Operator routes under /api/space-vault/* move ciphertext,
// public keys and metadata only (the browser decrypts); session, CSRF and same-site checks are the API's global hook.
// Agent routes under /api/cli/space-vault/* (agent.ts) answer only the fixed agent shapes; while the operator's agent-access
// switch is off every call but status is BLOCKED, and every call is audited.

export const cliVaultPathPrefix = "/api/cli/space-vault/";
export type VaultStore = Pick<PostgresVaultRepository,
  "getVault" | "enroll" | "rotateUnlock" | "setRecovery" | "bumpEpoch" | "saveItem" | "saveItems" | "deleteItems" | "getItem" | "listItems" | "listItemRecords" | "itemsByLoginKey" | "itemStats"
  | "enableAgentAccess" | "revokeAgentAccess" | "issueNonce" | "consumeNonce" | "appendAudit" | "listAudit" | "verifyAudit" | "createDelegation" | "getActiveDelegation" | "extendDelegation"
  | "setInbox" | "getInbox" | "addPending" | "listPending" | "deletePending" | "addSignupGrant" | "listSignupGrants" | "revokeSignupGrant"
  | "addHandoffKey" | "listHandoffKeys" | "takeHandoffKey" | "useHandoffKey" | "deleteHandoffKey">;

const notEnrolled = (): never => { throw new GitControlError("VAULT_NOT_ENROLLED", "Set up the Vault first.", 404); };
const itemNotFound = (): never => { throw new GitControlError("VAULT_ITEM_NOT_FOUND", "This Vault item was not found.", 404); };
const itemParams = z.object({ id: vaultItemIdSchema }).strict();
const conflict = (error: unknown): never => {
  if (error instanceof VaultConflictError) throw new GitControlError(error.code, "The Vault changed meanwhile or the request does not match it.", 409);
  throw error;
};

export interface VaultRouteDependencies {
  /** null without a database: every route answers VAULT_STORAGE_UNAVAILABLE. */
  repository: VaultStore | null;
  broker: VaultBroker;
  /** The signed-in user (never an automation session); a vault is personal, so this is the only owner. */
  owner(request: FastifyRequest): Promise<string>;
  routeOptions: Record<string, unknown>;
  /** Unlock, enrollment and key changes: a tighter per-client limit. */
  strictRouteOptions: Record<string, unknown>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  /** Tests replace the network check. */
  siteCheck?: (origins: string[]) => Promise<VaultSiteResult[]>;
  /** Seals the API keys the operator hands to agents (server-readable by design, unlike logins). */
  crypto: ConnectorCrypto;
}

export function registerVaultRoutes(app: FastifyInstance, deps: VaultRouteDependencies): void {
  const { routeOptions, strictRouteOptions, parseBody, parseQuery, broker } = deps;
  const route = (path: string) => `/api/space-vault${path}`;
  const repository = () => {
    if (!deps.repository) throw new GitControlError("VAULT_STORAGE_UNAVAILABLE", "The Vault needs the Space database.", 503);
    return deps.repository;
  };
  const vaultOf = async (owner: string) => (await repository().getVault(owner)) ?? notEnrolled();
  // Key changes and deletes carry the unlocked dock's unlock-key signature over the request (Vault review 2026-10-22): a session
  // cookie alone can no longer swap the inbox key, replace the password or recovery envelope, or delete logins. The signed body
  // names the current epoch, so a signature from before a lock, revoke or password change is stale. Verified like the broker
  // verifies a delegation: against the enrolled unlock public key.
  const signedByOperator = async <T extends { operatorSignature: string; epoch?: number; expectedEpoch?: number }>(
    owner: string, vault: VaultState, kind: VaultOperatorSignedKind, body: T, action: VaultAuditEvent["action"]
  ): Promise<Omit<T, "operatorSignature">> => {
    const { operatorSignature, ...rest } = body;
    const stale = (rest.epoch ?? rest.expectedEpoch) !== vault.epoch;
    const signed = !stale && await verifyVaultMessage(vaultBase64url.decode(vault.unlockPublicKey),
      vaultOperatorRequestMessage(kind, { ownerUserId: owner, vaultId: vault.vaultId, ...rest }), operatorSignature);
    if (!signed) {
      await repository().appendAudit(owner, { actor: "OPERATOR", action, result: "BLOCKED", reason: stale ? "EPOCH_STALE" : "SIGNATURE_REFUSED" });
      throw stale ? new GitControlError("VAULT_EPOCH_STALE", "The Vault was locked, revoked or changed elsewhere: lock it and unlock it again.", 409)
        : new GitControlError("VAULT_SIGNATURE_REFUSED", "This change needs the unlocked Vault's signature.", 409);
    }
    return rest;
  };

  app.get(route("/state"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const vault = await repository().getVault(owner);
    const delegation = vault?.agentAccess ? await repository().getActiveDelegation(owner) : null;
    const brokerAvailable = await broker.transportKey().then(() => true, () => false);
    return {
      ownerUserId: owner, enrolled: vault !== null, brokerAvailable, agentAccess: vault?.agentAccess ?? false, delegatedItems: delegation?.certificate.claims.items.length ?? 0,
      // Logins agents saved or the Vault generated that wait for an unlocked dock to add and hand them over.
      pendingItems: vault ? (await repository().listPending(owner)).length : 0,
      vault: vault && { vaultId: vault.vaultId, epoch: vault.epoch, delegationGeneration: vault.delegationGeneration, kdf: vault.kdf,
        unlockKeyVersion: vault.unlockKeyVersion, hasRecovery: vault.recovery !== null, auditSeq: vault.auditSeq, createdAt: vault.createdAt, updatedAt: vault.updatedAt }
    };
  });

  // The broker's own audit chain for ADMIN (space-admin-action vault-broker-audit, hardening plan step 16): ops, results, hashes.
  app.get(route("/broker-audit"), routeOptions, async (request) => {
    await deps.owner(request);
    if (request.user?.role !== "ADMIN") throw new GitControlError("ADMIN_REQUIRED", "Only an administrator reads the broker's audit.", 403);
    if (!broker.audit) throw new GitControlError("VAULT_BROKER_UNAVAILABLE", "The Vault broker is unavailable.", 503);
    return broker.audit();
  });

  app.get(route("/broker"), routeOptions, async (request) => {
    await deps.owner(request);
    return broker.transportKey();
  });

  app.post(route("/enroll"), strictRouteOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const body = parseBody(vaultEnrollRequestSchema, request.body);
    if (await repository().getVault(owner)) throw new GitControlError("VAULT_EXISTS", "This account already has a Vault.", 409);
    const serverShareEnvelope = await broker.sealServerShare({ ownerUserId: owner, vaultId: body.vaultId, keyVersion: 1, sealedServerShare: body.sealedServerShare, unlockPublicKey: body.unlockPublicKey });
    const { sealedServerShare: _sealed, ...rest } = body;
    const vault = await repository().enroll(owner, { ...rest, serverShareEnvelope }).catch(conflict);
    return reply.code(201).send({ vaultId: vault.vaultId, epoch: vault.epoch });
  });

  app.post(route("/unlock/challenge"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    const vault = await vaultOf(owner);
    const issued = (await repository().issueNonce(owner, "UNLOCK_CHALLENGE", 120_000)) ?? notEnrolled();
    // The browser opens its password envelope (ciphertext under the master password) to sign the challenge.
    return { challenge: issued.nonce, epoch: issued.epoch, expiresAt: issued.expiresAt, vaultId: vault.vaultId, passwordEnvelope: vault.passwordEnvelope, kdf: vault.kdf, unlockKeyVersion: vault.unlockKeyVersion };
  });

  app.post(route("/unlock"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    const body = parseBody(vaultUnlockRequestSchema, request.body);
    const vault = await vaultOf(owner);
    const blocked = async (reason: string) => {
      await repository().appendAudit(owner, { actor: "OPERATOR", action: "UNLOCK", result: "BLOCKED", reason });
      return new GitControlError("VAULT_UNLOCK_REFUSED", "The unlock was refused. Start again.", 409);
    };
    if (!await repository().consumeNonce(owner, body.challenge, "UNLOCK_CHALLENGE")) throw await blocked("CHALLENGE_INVALID");
    let sealedServerShare;
    try {
      sealedServerShare = await broker.unlock({ ownerUserId: owner, vaultId: vault.vaultId, epoch: vault.epoch, ...body,
        unlockPublicKey: vault.unlockPublicKey, serverShareEnvelope: vault.serverShareEnvelope });
    } catch (error) {
      await repository().appendAudit(owner, { actor: "OPERATOR", action: "UNLOCK", result: "BLOCKED", reason: "BROKER_REFUSED" });
      throw error;
    }
    await repository().appendAudit(owner, { actor: "OPERATOR", action: "UNLOCK", result: "OK" });
    return { sealedServerShare, epoch: vault.epoch };
  });

  app.post(route("/lock"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    return { epoch: (await repository().bumpEpoch(owner, "OPERATOR_LOCK", "LOCK")) ?? notEnrolled() };
  });

  app.get(route("/items"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    return { items: await repository().listItems(owner), stats: await repository().itemStats(owner) };
  });

  // Every item with its envelopes (ciphertext only) in one answer: a Vault of thousands of logins hands over in one request.
  app.get(route("/item-records"), routeOptions, async (request) => ({ items: await repository().listItemRecords(await deps.owner(request)) }));

  app.get(route("/items/:id"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    return { item: (await repository().getItem(owner, parseQuery(itemParams, request.params).id)) ?? itemNotFound() };
  });

  app.put(route("/items/:id"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(itemParams, request.params);
    const item = parseBody(vaultItemRecordSchema, request.body);
    if (item.metadata.id !== id) throw new GitControlError("VAULT_ITEM_MISMATCH", "The item id does not match the address.", 422);
    await vaultOf(owner);
    return { item: (await repository().saveItem(owner, item)) ?? itemNotFound() };
  });

  // Many items in one transaction (a Chrome import): one request per batch instead of one per login.
  app.put(route("/items"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { items } = parseBody(vaultItemBatchRequestSchema, request.body);
    await vaultOf(owner);
    const saved = await repository().saveItems(owner, items);
    return { saved: saved?.filter(Boolean).length ?? 0, refused: saved?.filter((item) => !item).length ?? items.length };
  });

  // The only delete (one item or the dead-site list): signed by the unlocked dock.
  app.post(route("/items/delete"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { ids } = await signedByOperator(owner, await vaultOf(owner), "item-delete", parseBody(vaultItemDeleteRequestSchema, request.body), "ITEM_DELETE");
    return { deleted: await repository().deleteItems(owner, ids) };
  });

  // Which login sites still exist; only origins of the owner's own items are looked up, page content is never read.
  app.post(route("/site-check"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { origins } = parseBody(vaultSiteCheckRequestSchema, request.body);
    const own = new Set((await repository().listItems(owner)).flatMap((item) => item.origins));
    return { results: await (deps.siteCheck ?? checkVaultSites)([...new Set(origins)].filter((origin) => own.has(origin))) };
  });

  app.post(route("/password"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    const body = parseBody(vaultPasswordRotateRequestSchema, request.body);
    const vault = await vaultOf(owner);
    const action = body.recovery ? "RECOVERY_USE" : "PASSWORD_ROTATE";
    const { expectedEpoch, recovery: _recovery, ...next } = await signedByOperator(owner, vault, "password", body, action);
    const rotated = await repository().rotateUnlock(owner, expectedEpoch, { ...next, serverShareEnvelope: vault.serverShareEnvelope }, action).catch(conflict);
    return { epoch: (rotated ?? notEnrolled()).epoch };
  });

  // The recovery envelope (ciphertext under the recovery key) for the dock's recovery: the browser opens it, unlocks with the
  // broker like a password unlock and sets a new master password (hardening plan step 14).
  app.get(route("/recovery"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    return { recovery: (await vaultOf(owner)).recovery };
  });

  app.put(route("/recovery"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    const { epoch: _epoch, ...recovery } = await signedByOperator(owner, await vaultOf(owner), "recovery", parseBody(vaultRecoverySetRequestSchema, request.body), "RECOVERY_SET");
    if (!await repository().setRecovery(owner, recovery)) notEnrolled();
    return { recovery: true };
  });

  // Delegate items to agents and Nous (the dock does it whenever agent access is on: after each unlock and item change). The
  // broker signs the certificate; the API checks that signature against the broker's key and that it names exactly the
  // requested items that are not hidden from agents, their stored origins and fields, before anything is stored.
  // Every login's fill envelopes in one body: a technical bound sized for VAULT_DELEGATION_TECHNICAL_MAX_ITEMS, not a policy limit.
  app.post(route("/delegations"), { ...strictRouteOptions, bodyLimit: 4 * VAULT_BROKER_API_MAX_BYTES }, async (request) => {
    const owner = await deps.owner(request);
    const body = parseBody(vaultDelegateRequestSchema, request.body);
    const vault = await vaultOf(owner);
    const refuse = async (reason: string) => {
      await repository().appendAudit(owner, { actor: "OPERATOR", action: "DELEGATE", result: "BLOCKED", reason });
      return new GitControlError("VAULT_DELEGATION_REFUSED", "The delegation was refused; nothing changed.", 409);
    };
    const items: Parameters<VaultBroker["delegate"]>[0]["items"] = [];
    for (const requested of body.items) {
      const stored = await repository().getItem(owner, requested.handle);
      const metadata = stored?.metadata;
      if (!metadata || !metadata.policy.agentUse || metadata.status !== "ACTIVE" || requested.fields.some((field) => !metadata.fieldRoles.includes(field))) {
        throw await refuse("ITEM_NOT_DELEGABLE");
      }
      if (Object.keys(body.fillEnvelopes[requested.handle] ?? {}).sort().join() !== [...requested.fields].sort().join()) throw await refuse("ENVELOPES_MISMATCH");
      // The operator signs the item's own exact origins; any other set never reaches the broker.
      if ([...requested.origins].sort().join("\n") !== [...metadata.origins].sort().join("\n")) throw await refuse("ORIGINS_MISMATCH");
      items.push({ handle: requested.handle, origins: metadata.origins, fields: requested.fields, approvalMode: requested.approvalMode, submit: requested.submit });
    }
    if (Object.keys(body.fillEnvelopes).some((handle) => !body.items.some((item) => item.handle === handle))) throw await refuse("ENVELOPES_MISMATCH");
    // Generation, epoch and expiry are part of what the operator signed; they must also be this vault's next ones. A standing
    // delegation has no expiry cap: the agent-access switch and Revoke agent access end it (operator decision 2026-10-18).
    if (body.generation !== vault.delegationGeneration + 1 || body.unlockEpoch !== vault.epoch || !(Date.parse(body.expiresAt) > Date.now())) {
      throw await refuse("DELEGATION_STALE");
    }
    const asked = { generation: body.generation, unlockEpoch: body.unlockEpoch, envelopeDigest: await vaultDigest(body.fillEnvelopes), expiresAt: body.expiresAt };
    const delegate = (sealedInboxKey?: typeof body.sealedInboxKey) => broker.delegate({ ownerUserId: owner, vaultId: vault.vaultId, ...asked, items, sealedFillKey: body.sealedFillKey,
      operatorSignature: body.operatorSignature, unlockPublicKey: vault.unlockPublicKey, serverShareEnvelope: vault.serverShareEnvelope, ...(sealedInboxKey ? { sealedInboxKey } : {}) });
    // A broker installed before 2026-10-20 refuses the inbox key as an unknown field: delegate without it, as before.
    const signed = await delegate(body.sealedInboxKey)
      .catch((error) => body.sealedInboxKey && error instanceof VaultBrokerRefusedError && error.reason === "BAD_REQUEST" ? delegate() : Promise.reject(error))
      .catch(async (error) => { if (error instanceof VaultBrokerUnavailableError) throw error; throw await refuse("BROKER_REFUSED"); });
    const brokerKey = await broker.delegationKey();
    let claims;
    try { claims = await verifyVaultCertificate(vaultBase64url.decode(brokerKey.publicKey), signed.certificate, vaultDelegationCertificateSchema); } catch { throw await refuse("CERTIFICATE_INVALID"); }
    if (vaultCanonicalJson(claims.items) !== vaultCanonicalJson(items) || claims.generation !== asked.generation || claims.envelopeDigest !== asked.envelopeDigest
      || claims.unlockEpoch !== asked.unlockEpoch || claims.expiresAt !== asked.expiresAt) throw await refuse("CERTIFICATE_MISMATCH");
    const stored = await repository().createDelegation(owner, { certificate: signed.certificate, keyEnvelope: signed.keyEnvelope, fillEnvelopes: body.fillEnvelopes,
      ...(signed.inboxKeyEnvelope ? { inboxKeyEnvelope: signed.inboxKeyEnvelope } : {}) })
      .catch(async (error) => { if (error instanceof VaultConflictError) throw await refuse("CERTIFICATE_MISMATCH"); throw error; });
    // Logins agents saved that the dock has not added yet stay fillable under the new generation.
    for (const handle of new Set((await repository().listPending(owner)).map((entry) => entry.handle))) await handOverPendingLogin(repository(), broker, owner, handle);
    return stored ?? notEnrolled();
  });

  // Revoke agent access: no password needed, effective at once (the switch goes off, new generation and epoch, delegated
  // envelopes deleted).
  const revoke = async (owner: string) => {
    const vault = await vaultOf(owner);
    const revoked = (await repository().revokeAgentAccess(owner, "OPERATOR")) ?? notEnrolled();
    // The broker raises its own floor too; revocation never waits for it (the stored delegation is already gone).
    await broker.revoke({ ownerUserId: owner, vaultId: vault.vaultId, generation: revoked.generation }).catch(() => undefined);
    return revoked;
  };
  app.post(route("/revoke"), routeOptions, async (request) => revoke(await deps.owner(request)));
  // The dock's one switch: on lets agents and Nous use the Vault (the dock then delegates every item); off revokes.
  app.put(route("/agent-access"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    if (!parseBody(vaultAgentAccessRequestSchema, request.body).enabled) return { agentAccess: false, ...await revoke(owner) };
    if (!await repository().enableAgentAccess(owner)) notEnrolled();
    return { agentAccess: true };
  });

  // Sign-up grants (NEW_ACCOUNT option B, operator decision 2026-10-18): the dock's unlock key signs exact https sites, a
  // daily cap and an expiry; the broker certifies them and enforces each use. Listing never returns the certificate.
  app.get(route("/signup-grants"), routeOptions, async (request) => ({
    grants: (await repository().listSignupGrants(await deps.owner(request))).map(({ certificate: _certificate, ...grant }) => grant)
  }));
  app.post(route("/signup-grants"), strictRouteOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const body = parseBody(vaultSignupGrantRequestSchema, request.body);
    const vault = await vaultOf(owner);
    const refuse = async (reason: string) => {
      await repository().appendAudit(owner, { actor: "OPERATOR", action: "SIGNUP_GRANT", result: "BLOCKED", reason });
      return new GitControlError("VAULT_GRANT_REFUSED", "The sign-up grant was refused; nothing changed.", 409);
    };
    const expires = Date.parse(body.expiresAt);
    if (body.unlockEpoch !== vault.epoch || !(expires > Date.now() && expires <= Date.now() + VAULT_SIGNUP_GRANT_LIMITS.maxDays * 86_400_000)) throw await refuse("GRANT_STALE");
    const signed = await broker.signupGrant({ ownerUserId: owner, vaultId: vault.vaultId, ...body, unlockPublicKey: vault.unlockPublicKey, serverShareEnvelope: vault.serverShareEnvelope })
      .catch(async (error) => { if (error instanceof VaultBrokerUnavailableError) throw error; throw await refuse("BROKER_REFUSED"); });
    const brokerKey = await broker.delegationKey();
    let claims;
    try { claims = await verifyVaultCertificate(vaultBase64url.decode(brokerKey.publicKey), signed.certificate, vaultSignupGrantCertificateSchema); } catch { throw await refuse("CERTIFICATE_INVALID"); }
    if (claims.grantId !== body.grantId || claims.ownerUserId !== owner || claims.vaultId !== vault.vaultId || claims.dailyCap !== body.dailyCap || claims.expiresAt !== body.expiresAt
      || claims.unlockEpoch !== body.unlockEpoch || vaultCanonicalJson(claims.sites) !== vaultCanonicalJson([...body.sites].sort())) throw await refuse("CERTIFICATE_MISMATCH");
    if (!await repository().addSignupGrant(owner, signed.certificate).catch(() => false)) throw await refuse("GRANT_NOT_STORED");
    return reply.code(201).send({ grant: { id: claims.grantId, sites: claims.sites, dailyCap: claims.dailyCap, createdAt: claims.issuedAt, expiresAt: claims.expiresAt, revokedAt: null } });
  });
  app.delete(route("/signup-grants/:id"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(z.object({ id: vaultSignupGrantIdSchema }).strict(), request.params);
    const vault = await vaultOf(owner);
    if (!await repository().revokeSignupGrant(owner, id)) throw new GitControlError("VAULT_GRANT_NOT_FOUND", "This sign-up grant was not found or is already revoked.", 404);
    // The fill path uses only grants the store still lists, so revocation never waits for the broker.
    await broker.signupRevoke({ ownerUserId: owner, vaultId: vault.vaultId, grantId: id }).catch(() => undefined);
    return { revoked: true };
  });

  app.get(route("/audit"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const query = parseQuery(vaultAuditQuerySchema, request.query);
    const entries = await repository().listAudit(owner, query);
    return { entries, nextBeforeSeq: entries.length === query.limit ? entries.at(-1)!.seq : null };
  });

  // The inbox key (public half for fills and saves, private half sealed under the VRK) and the logins waiting in it.
  app.get(route("/inbox"), routeOptions, async (request) => ({ inbox: await repository().getInbox(await deps.owner(request)) }));
  // Every password agents generate or save is sealed to this key, so only the unlocked dock may set it (audited as INBOX_SET).
  app.put(route("/inbox"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    const { epoch: _epoch, ...inbox } = await signedByOperator(owner, await vaultOf(owner), "inbox", parseBody(vaultInboxKeySetRequestSchema, request.body), "INBOX_SET");
    if (!await repository().setInbox(owner, inbox)) notEnrolled();
    await repository().appendAudit(owner, { actor: "OPERATOR", action: "INBOX_SET", result: "OK" });
    return { inbox: true };
  });
  app.get(route("/pending"), routeOptions, async (request) => ({ pending: await repository().listPending(await deps.owner(request)) }));
  app.delete(route("/pending/:id"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(z.object({ id: vaultPendingIdSchema }).strict(), request.params);
    if (!await repository().deletePending(owner, id)) throw new GitControlError("VAULT_PENDING_NOT_FOUND", "This waiting password was not found.", 404);
    return { deleted: true };
  });

  // API keys for agents (operator request 2026-10-22, plan clipboard:-qvpC_Q0rAVg): the value goes in sealed with the API's key
  // and comes out once, to the owner's pane whose space_vault_key_install writes it (agent.ts key-take, key-used); the dock
  // lists ids and states, never a value.
  app.post(route("/keys"), strictRouteOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const body = parseBody(vaultHandoffKeyCreateRequestSchema, request.body);
    const id = newVaultHandle("vault_key");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + body.expiresInHours * 3_600_000).toISOString();
    const stored = await repository().addHandoffKey(owner, { id, label: body.label, valueSealed: deps.crypto.seal(body.value, connectorSealContext("vault-handoff-key", owner, id)), expiresAt });
    if (!stored) throw new GitControlError("VAULT_KEY_NOT_STORED", "The key could not be stored.", 409);
    await repository().appendAudit(owner, { actor: "OPERATOR", action: "KEY_HANDOFF", result: "OK", reason: "ADDED" });
    return reply.code(201).send({ key: { id, label: body.label, createdAt: createdAt.toISOString(), expiresAt, takenAt: null, takenByPaneId: null, usedAt: null, usedByPaneId: null, hasValue: true } });
  });
  app.get(route("/keys"), routeOptions, async (request) => ({ keys: await repository().listHandoffKeys(await deps.owner(request)) }));
  app.delete(route("/keys/:id"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(z.object({ id: vaultHandoffKeyIdSchema }).strict(), request.params);
    if (!await repository().deleteHandoffKey(owner, id)) throw new GitControlError("VAULT_KEY_NOT_FOUND", "This key was not found.", 404);
    return { deleted: true };
  });

  app.get(route("/audit/verify"), routeOptions, async (request) => repository().verifyAudit(await deps.owner(request)));
}
