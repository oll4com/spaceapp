import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  vaultAgentAccessRequestSchema, vaultAuditQuerySchema, vaultEnrollRequestSchema,
  vaultItemIdSchema, vaultItemRecordSchema, vaultPasswordRotateRequestSchema, vaultRecoverySchema, vaultUnlockRequestSchema,
  vaultBase64url, vaultCanonicalJson, vaultDelegateRequestSchema, vaultInboxKeyRequestSchema, vaultPendingIdSchema,
  vaultDelegationCertificateSchema, vaultDigest, verifyVaultCertificate,
  vaultSignupGrantCertificateSchema, vaultSignupGrantIdSchema, vaultSignupGrantRequestSchema, VAULT_SIGNUP_GRANT_LIMITS
} from "@space/contracts";
import { VaultConflictError, type PostgresVaultRepository } from "@space/db";
import { GitControlError } from "../source-control/errors.js";
import { VaultBrokerUnavailableError, type VaultBroker } from "./broker-client.js";

// Vault routes (plan clipboard:vEYtT6-bEN0J step 4, ADR-012). Operator routes under /api/space-vault/* move ciphertext,
// public keys and metadata only (the browser decrypts); session, CSRF and same-site checks are the API's global hook.
// Agent routes under /api/cli/space-vault/* (agent.ts) answer only the fixed agent shapes; while the operator's agent-access
// switch is off every call but status is BLOCKED, and every call is audited.

export const cliVaultPathPrefix = "/api/cli/space-vault/";
export type VaultStore = Pick<PostgresVaultRepository,
  "getVault" | "enroll" | "rotateUnlock" | "setRecovery" | "bumpEpoch" | "saveItem" | "getItem" | "listItems" | "deleteItem"
  | "enableAgentAccess" | "revokeAgentAccess" | "issueNonce" | "consumeNonce" | "appendAudit" | "listAudit" | "verifyAudit" | "createDelegation" | "getActiveDelegation"
  | "setInbox" | "getInbox" | "addPending" | "listPending" | "deletePending" | "addSignupGrant" | "listSignupGrants" | "revokeSignupGrant">;

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
}

export function registerVaultRoutes(app: FastifyInstance, deps: VaultRouteDependencies): void {
  const { routeOptions, strictRouteOptions, parseBody, parseQuery, broker } = deps;
  const route = (path: string) => `/api/space-vault${path}`;
  const repository = () => {
    if (!deps.repository) throw new GitControlError("VAULT_STORAGE_UNAVAILABLE", "The Vault needs the Space database.", 503);
    return deps.repository;
  };
  const vaultOf = async (owner: string) => (await repository().getVault(owner)) ?? notEnrolled();

  app.get(route("/state"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const vault = await repository().getVault(owner);
    const delegation = vault?.agentAccess ? await repository().getActiveDelegation(owner) : null;
    const brokerAvailable = await broker.transportKey().then(() => true, () => false);
    return {
      ownerUserId: owner, enrolled: vault !== null, brokerAvailable, agentAccess: vault?.agentAccess ?? false, delegatedItems: delegation?.certificate.claims.items.length ?? 0,
      vault: vault && { vaultId: vault.vaultId, epoch: vault.epoch, delegationGeneration: vault.delegationGeneration, kdf: vault.kdf,
        unlockKeyVersion: vault.unlockKeyVersion, hasRecovery: vault.recovery !== null, auditSeq: vault.auditSeq, createdAt: vault.createdAt, updatedAt: vault.updatedAt }
    };
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

  app.get(route("/items"), routeOptions, async (request) => ({ items: await repository().listItems(await deps.owner(request)) }));

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

  app.delete(route("/items/:id"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    if (!await repository().deleteItem(owner, parseQuery(itemParams, request.params).id)) itemNotFound();
    return { deleted: true };
  });

  app.post(route("/password"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    const { expectedEpoch, ...next } = parseBody(vaultPasswordRotateRequestSchema, request.body);
    const vault = await vaultOf(owner);
    const rotated = await repository().rotateUnlock(owner, expectedEpoch, { ...next, serverShareEnvelope: vault.serverShareEnvelope }).catch(conflict);
    return { epoch: (rotated ?? notEnrolled()).epoch };
  });

  app.put(route("/recovery"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    if (!await repository().setRecovery(owner, parseBody(vaultRecoverySchema, request.body))) notEnrolled();
    return { recovery: true };
  });

  // Delegate items to agents and Nous (the dock does it whenever agent access is on: after each unlock and item change). The
  // broker signs the certificate; the API checks that signature against the broker's key and that it names exactly the
  // requested items that are not hidden from agents, their stored origins and fields, before anything is stored.
  app.post(route("/delegations"), strictRouteOptions, async (request) => {
    const owner = await deps.owner(request);
    const body = parseBody(vaultDelegateRequestSchema, request.body);
    const vault = await vaultOf(owner);
    const refuse = async (reason: string) => {
      await repository().appendAudit(owner, { actor: "OPERATOR", action: "DELEGATE", result: "BLOCKED", reason });
      return new GitControlError("VAULT_DELEGATION_REFUSED", "The delegation was refused; nothing changed.", 409);
    };
    const items = [];
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
    const signed = await broker.delegate({ ownerUserId: owner, vaultId: vault.vaultId, ...asked, items, sealedFillKey: body.sealedFillKey,
      operatorSignature: body.operatorSignature, unlockPublicKey: vault.unlockPublicKey, serverShareEnvelope: vault.serverShareEnvelope })
      .catch(async (error) => { if (error instanceof VaultBrokerUnavailableError) throw error; throw await refuse("BROKER_REFUSED"); });
    const brokerKey = await broker.delegationKey();
    let claims;
    try { claims = await verifyVaultCertificate(vaultBase64url.decode(brokerKey.publicKey), signed.certificate, vaultDelegationCertificateSchema); } catch { throw await refuse("CERTIFICATE_INVALID"); }
    if (vaultCanonicalJson(claims.items) !== vaultCanonicalJson(items) || claims.generation !== asked.generation || claims.envelopeDigest !== asked.envelopeDigest
      || claims.unlockEpoch !== asked.unlockEpoch || claims.expiresAt !== asked.expiresAt) throw await refuse("CERTIFICATE_MISMATCH");
    const stored = await repository().createDelegation(owner, { certificate: signed.certificate, keyEnvelope: signed.keyEnvelope, fillEnvelopes: body.fillEnvelopes })
      .catch(async (error) => { if (error instanceof VaultConflictError) throw await refuse("CERTIFICATE_MISMATCH"); throw error; });
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
  app.put(route("/inbox"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    if (!await repository().setInbox(owner, parseBody(vaultInboxKeyRequestSchema, request.body))) notEnrolled();
    return { inbox: true };
  });
  app.get(route("/pending"), routeOptions, async (request) => ({ pending: await repository().listPending(await deps.owner(request)) }));
  app.delete(route("/pending/:id"), routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(z.object({ id: vaultPendingIdSchema }).strict(), request.params);
    if (!await repository().deletePending(owner, id)) throw new GitControlError("VAULT_PENDING_NOT_FOUND", "This waiting password was not found.", 404);
    return { deleted: true };
  });

  app.get(route("/audit/verify"), routeOptions, async (request) => repository().verifyAudit(await deps.owner(request)));
}
