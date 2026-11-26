import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  VAULT_BROKER_API_MAX_BYTES, vaultBase64url as b64, vaultLinkSyncSchema, vaultOperatorRequestMessage, vaultTransportEnvelopeSchema, verifyVaultMessage,
  type VaultItemRecordInput, type VaultLinkSync
} from "@space/contracts";
import { VaultConflictError, type InstanceLinkRecord, type InstanceLinkRepository } from "@space/db";
import { sendApiError } from "../http-errors.js";
import { VaultBrokerRefusedError } from "../vault/broker-client.js";
import type { VaultModule } from "../vault/wiring.js";
import type { InstanceLinkReply } from "./client.js";

// Vault→Vault over a Space Link (plan clipboard:TcX66vjNuZDv step 2, operator nous_msg:549e67fc). The managing SpaceApp (A) keeps its
// Vault; a link its person enabled ("Sync Vault", signed with the unlocked Vault's key) gets the same Vault: the ciphertext envelopes and
// items as stored, the server share and the delegation's keys sealed by A's broker to the linked broker named in that consent, which
// rewraps them under its own ARK. No secret is ever in the clear on either API, the link, a log, Nous or a pane.
// shortcut: deletes on A do not reach B, B's waiting logins and kept keys do not flow back; add them when the operator asks.
// shortcut: B revoking agent access raises its broker's floor, so A's next delegation lands only after A's next delegate (a new generation).

/** Technical bound: one item page stays well under the receiving route's body limit (VAULT_BROKER_API_MAX_BYTES). */
const PAGE_BYTES = 4 * 1024 * 1024;
/** Technical: how often A looks for a change to push (its mark is one indexed read per synced link). */
const KEEP_MS = 30_000;

const sealed = vaultTransportEnvelopeSchema;
const pushSchema = z.object({
  consent: vaultLinkSyncSchema,
  // Each field is parsed again by applyLinkSync (vaultEnrollmentSchema, vaultRecoverySchema, ...) before anything is stored.
  vault: z.object({ vaultId: z.string(), kdf: z.unknown(), passwordEnvelope: z.unknown(), unlockPublicKey: z.string(), unlockKeyVersion: z.number().int().min(1),
    recovery: z.unknown(), epoch: z.number().int().min(0), inbox: z.object({ publicKey: z.string(), privateKeyEnvelope: z.unknown() }).nullable(), sealedServerShare: sealed }).strict().optional(),
  items: z.array(z.unknown()).optional(),
  delegation: z.object({ certificate: z.unknown(), sealedFillKey: sealed, sealedInboxKey: sealed.optional(), fillEnvelopes: z.unknown() }).nullable().optional(),
  stop: z.literal(true).optional()
});

type Call = (link: InstanceLinkRecord, method: "GET" | "POST", path: string, body?: unknown) => Promise<InstanceLinkReply>;
const said = (answer: InstanceLinkReply) => `it answered ${answer.status}${(answer.body as { error?: { code?: string } } | null)?.error?.code ? ` ${(answer.body as { error: { code: string } }).error.code}` : ""}`;
/** The same fingerprint space-transfer.mjs audits for a pin, so both records name one key alike. */
const fingerprint = (publicKey: string) => createHash("sha256").update(publicKey, "utf8").digest("hex");
const message = (error: unknown) => error instanceof Error ? (error as { reason?: string }).reason ?? error.message : String(error);

export function registerLinkVaultSync(app: FastifyInstance, options: {
  vault: () => Pick<VaultModule, "repository" | "broker">; repository: InstanceLinkRepository; call: Call;
  routeOptions: Pick<RouteShorthandOptions, "config">; person: (request: FastifyRequest) => string;
  audit: (request: FastifyRequest, action: string, linkId: string, metadata: Record<string, unknown>) => Promise<void>;
}) {
  const store = () => {
    const repository = options.vault().repository;
    if (!repository) throw Object.assign(new Error("This SpaceApp has no Vault storage."), { statusCode: 409 });
    return repository;
  };

  // B's side: what A needs for the consent, and A's pushes. Only a link this SpaceApp's person granted "Vault" (scope vault).
  const linked = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.mobileDevice?.scopes.includes("vault")) return request.user!.id;
    sendApiError(reply, 403, "LINK_VAULT_NOT_GRANTED", "Only a linked SpaceApp this SpaceApp's person let sync the Vault (Settings > Account > Devices).");
    return null;
  };
  app.get("/api/instance-link/vault", options.routeOptions, async (request, reply) => {
    const owner = linked(request, reply);
    if (!owner) return reply;
    return { ownerUserId: owner, vaultId: (await store().getVault(owner))?.vaultId ?? null, transportKey: (await options.vault().broker.transportKey()).publicKey };
  });
  app.post("/api/instance-link/vault", { ...options.routeOptions, bodyLimit: 2 * VAULT_BROKER_API_MAX_BYTES }, (request, reply) => land(request, reply).catch((error: unknown) => {
    // Codes only (upper-case words, never a value): the sending side shows them in Settings > Linked SpaceApps.
    if (error instanceof VaultConflictError) return sendApiError(reply, 409, error.code, "This Vault did not take the push.");
    if (error instanceof VaultBrokerRefusedError) return sendApiError(reply, 409, error.reason, "This Vault broker refused the push.");
    throw error;
  }));
  async function land(request: FastifyRequest, reply: FastifyReply) {
    const owner = linked(request, reply);
    if (!owner) return reply;
    const input = pushSchema.safeParse(request.body);
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "Not a Vault sync push.");
    const { consent, vault, items, delegation, stop } = input.data;
    const { broker } = options.vault();
    const repository = store();
    const local = await repository.getVault(owner);
    // A stop (A's sync off, the link removed) or A's agent access off: agents here stop filling at once (B's broker floor rises).
    if (stop || delegation === null) {
      if (local?.agentAccess) {
        await broker.revoke({ ownerUserId: owner, vaultId: local.vaultId, generation: local.delegationGeneration + 1 });
        await repository.revokeAgentAccess(owner, "SYSTEM");
      }
      if (stop) return { stopped: true };
    }
    if (consent.transportKey !== (await broker.transportKey()).publicKey) return sendApiError(reply, 409, "LINK_NOT_THIS_BROKER", "The consent names another Vault broker.");
    // An unsigned consent (operator rule 4d47dcab: sync never needs an unlock) lands only from the device and sender keys root pinned
    // for this link here; the broker checks the pin again for every key, and revoking the device's Vault scope stops it above.
    if (!consent.operatorSignature) {
      const pin = await broker.linkPin(consent.linkId);
      if (!pin.pinned || pin.deviceId !== request.mobileDevice?.id || pin.ownerUserId !== owner || pin.signingKey !== consent.signingKey) {
        return sendApiError(reply, 409, "LINK_NOT_PINNED", "Root did not pin this link and its keys on this SpaceApp (space-transfer.mjs vault-link-pin).");
      }
      // Another Vault here is replaced only while it holds nothing (operator 23/11, nous_msg:931c907c): the repository checks items and waiting logins in its lock.
      if (vault && local && local.vaultId !== vault.vaultId && local.agentAccess) return sendApiError(reply, 409, "VAULT_DIFFERS", `This SpaceApp has another Vault (${local.vaultId}); its person decides what to do with it.`);
    } else if (vault) {
      // The consent is checked with the key the pushed vault carries (a password change on A changes it); the broker checks it again for every key.
      const { operatorSignature, ...body } = consent;
      if (!await verifyVaultMessage(b64.decode(vault.unlockPublicKey), vaultOperatorRequestMessage("link-sync", { ownerUserId: owner, vaultId: vault.vaultId, ...body }), operatorSignature!)) {
        return sendApiError(reply, 409, "LINK_SIGNATURE_REFUSED", "The consent is not signed by that Vault's key.");
      }
      if (local && local.vaultId !== vault.vaultId) return sendApiError(reply, 409, "VAULT_DIFFERS", `This SpaceApp has another Vault (${local.vaultId}); its person decides what to do with it.`);
    }
    const target = vault?.vaultId ?? local?.vaultId;
    if (!target) return sendApiError(reply, 409, "NO_VAULT", "No Vault here yet: the first push carries it.");
    let landing: Parameters<typeof repository.applyLinkSync>[1]["vault"];
    if (vault) {
      const { sealedServerShare, ...fields } = vault;
      const serverShareEnvelope = await broker.sealServerShare({ ownerUserId: owner, vaultId: target, keyVersion: 1, sealedServerShare, unlockPublicKey: vault.unlockPublicKey });
      landing = { ...fields, serverShareEnvelope } as typeof landing;
    }
    const applied = await repository.applyLinkSync(owner, { items: (items ?? []) as VaultItemRecordInput[], ...(landing ? { vault: landing } : {}), replaceEmpty: !consent.operatorSignature });
    if (applied.replaced) await options.audit(request, "instance_link.vault_replaced", consent.linkId, { replacedVaultId: applied.replaced, vaultId: target });
    if (delegation) {
      const here = (await repository.getVault(owner))!;
      const moved = await broker.moveIn({ ownerUserId: owner, vaultId: target, certificate: delegation.certificate, sealedFillKey: delegation.sealedFillKey,
        ...(delegation.sealedInboxKey ? { sealedInboxKey: delegation.sealedInboxKey } : {}), link: consent, unlockPublicKey: here.unlockPublicKey, serverShareEnvelope: here.serverShareEnvelope });
      await repository.applyLinkSync(owner, { delegation: { certificate: moved.certificate, keyEnvelope: moved.keyEnvelope, fillEnvelopes: delegation.fillEnvelopes,
        ...(moved.inboxKeyEnvelope ? { inboxKeyEnvelope: moved.inboxKeyEnvelope } : {}) } });
    }
    return { items: applied.items, delegation: Boolean(delegation) };
  }

  // A's side.
  const errors = new Map<string, string | null>();
  async function push(link: InstanceLinkRecord, consent: VaultLinkSync, now = false) {
    const sync = link.vaultSync!;
    const repository = store();
    const owner = link.ownerUserId;
    const mark = await repository.linkMark(owner);
    if (!mark || (!now && mark === sync.mark && !sync.error)) return;
    const snap = (await repository.linkSnapshot(owner, sync.itemsAt))!;
    const active = snap.vault.agentAccess ? await repository.getActiveDelegation(owner) : null;
    const moved = await options.vault().broker.moveOut({ ownerUserId: owner, vaultId: snap.vault.vaultId, unlockPublicKey: snap.vault.unlockPublicKey,
      serverShareEnvelope: snap.serverShareEnvelope, link: consent, ...(active ? { delegation: { certificate: active.certificate, keyEnvelope: active.keyEnvelope,
        ...(active.inboxKeyEnvelope ? { inboxKeyEnvelope: active.inboxKeyEnvelope } : {}) } } : {}) });
    const send = async (body: object) => {
      const answer = await options.call(link, "POST", "/api/instance-link/vault", { consent, ...body });
      if (answer.status !== 200) throw new Error(said(answer));
    };
    const pages: unknown[][] = [[]];
    let size = 0;
    for (const item of snap.items) {
      const bytes = JSON.stringify(item).length;
      if (size + bytes > PAGE_BYTES && pages.at(-1)!.length) { pages.push([]); size = 0; }
      pages.at(-1)!.push(item);
      size += bytes;
    }
    // agentAccess stays here (undefined drops out of the JSON): B's strict push schema has no such field, B keeps its own.
    for (const [index, items] of pages.entries()) await send(index ? { items } : { vault: { ...snap.vault, agentAccess: undefined, sealedServerShare: moved.sealedServerShare }, items });
    await send({ delegation: active && moved.sealedFillKey ? { certificate: active.certificate, sealedFillKey: moved.sealedFillKey,
      ...(moved.sealedInboxKey ? { sealedInboxKey: moved.sealedInboxKey } : {}), fillEnvelopes: active.fillEnvelopes } : null });
    await options.repository.setVaultSync(owner, link.id, { ...sync, mark, itemsAt: snap.itemsAt, syncedAt: new Date().toISOString(), error: null });
  }
  async function keep(link: InstanceLinkRecord, now = false) {
    if (!link.vaultSync) return;
    try { await push(link, link.vaultSync.consent, now); errors.set(link.id, null); } catch (error) {
      const text = message(error);
      if (link.vaultSync.error !== text) await options.repository.setVaultSync(link.ownerUserId, link.id, { ...link.vaultSync, error: text });
      errors.set(link.id, text);
    }
  }
  let keeping: Promise<void> | null = null;
  const pass = () => keeping ??= (async () => { for (const link of await options.repository.listAll()) await keep(link); })().catch(() => undefined).finally(() => { keeping = null; });
  const timer = setInterval(() => void pass(), KEEP_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  /** Best effort: the linked SpaceApp's agents stop filling with this Vault (sync off, link removed). */
  const stop = async (link: InstanceLinkRecord) => {
    if (!link.vaultSync) return null;
    try {
      const answer = await options.call(link, "POST", "/api/instance-link/vault", { consent: link.vaultSync.consent, stop: true });
      return answer.status === 200 ? null : said(answer);
    } catch (error) { return message(error); }
  };

  // Settings > Linked SpaceApps: what the browser signs for "Sync Vault" (the linked broker's key, this broker's key), and the state.
  app.get<{ Params: { id: string } }>("/api/instance-links/:id/vault", options.routeOptions, async (request, reply) => {
    const link = await options.repository.get(options.person(request), request.params.id);
    if (!link) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    const now = state(link);
    let peer: { ownerUserId: string; vaultId: string | null; transportKey: string } | null = null, peerError: string | null = null;
    try {
      const answer = await options.call(link, "GET", "/api/instance-link/vault");
      if (answer.status === 200) peer = answer.body as typeof peer;
      else peerError = answer.status === 403 ? "It does not let this SpaceApp sync the Vault: its person grants Vault in Settings > Account > Devices." : said(answer);
    } catch (error) { peerError = message(error); }
    const signingKey = await options.vault().broker.delegationKey().then((key) => key.publicKey, () => null);
    const pinned = Boolean(await sendingPin(link));
    return { linkId: link.id, on: Boolean(now), syncedAt: now?.syncedAt ?? null, error: now?.error ?? null, peer, peerError, signingKey, pinned };
  });

  app.post<{ Params: { id: string } }>("/api/instance-links/:id/vault", options.routeOptions, async (request, reply) => {
    const owner = options.person(request);
    const input = z.union([z.object({ on: z.literal(true), consent: vaultLinkSyncSchema.optional() }).strict(), z.object({ on: z.literal(false) }).strict()]).safeParse(request.body);
    if (!input.success) return sendApiError(reply, 400, "INVALID_INPUT", "on: true with the signed consent (or none on a pinned link), or on: false.");
    const link = await options.repository.get(owner, request.params.id);
    if (!link) return sendApiError(reply, 404, "NOT_FOUND", "No such linked SpaceApp.");
    if (!input.data.on) {
      const error = await stop(link);
      await options.repository.setVaultSync(owner, link.id, null);
      errors.delete(link.id);
      await options.audit(request, "instance_link.vault_sync", link.id, { on: false, stopError: error });
      return { on: false, error };
    }
    const vault = await store().getVault(owner);
    if (!vault) return sendApiError(reply, 409, "NO_VAULT", "Set up the Vault first.");
    let consent = input.data.consent;
    if (!consent) {
      // Pinned (operator rule 4d47dcab): root named the linked broker for this link and person; it must still be the one that answers.
      const pin = await sendingPin(link);
      if (!pin) return sendApiError(reply, 409, "LINK_NOT_PINNED", "Root has not pinned this link's Vault broker here (space-transfer.mjs vault-link-pin).");
      const answer = await options.call(link, "GET", "/api/instance-link/vault").catch(() => null);
      if (answer?.status !== 200) return sendApiError(reply, 409, "LINK_VAULT_NOT_GRANTED", "The linked SpaceApp does not let this SpaceApp sync the Vault.");
      if ((answer.body as { transportKey?: unknown } | null)?.transportKey !== pin.transportKey) return sendApiError(reply, 409, "LINK_PIN_MISMATCH", "The linked SpaceApp's Vault broker is not the one root pinned.");
      consent = { linkId: link.id, transportKey: pin.transportKey, signingKey: (await options.vault().broker.delegationKey()).publicKey, issuedAt: new Date().toISOString() };
    } else {
      const { operatorSignature, ...body } = consent;
      if (consent.linkId !== link.id || !operatorSignature || !await verifyVaultMessage(b64.decode(vault.unlockPublicKey),
        vaultOperatorRequestMessage("link-sync", { ownerUserId: owner, vaultId: vault.vaultId, ...body }), operatorSignature)) {
        return sendApiError(reply, 409, "VAULT_SIGNATURE_REFUSED", "This needs the unlocked Vault's signature for this link.");
      }
    }
    const sync = { consent, mark: null, itemsAt: null, syncedAt: null, error: null };
    await options.repository.setVaultSync(owner, link.id, sync);
    await options.audit(request, "instance_link.vault_sync", link.id, { on: true, ...(consent.operatorSignature ? {} : { pinned: true,
      transportKeyFingerprint: fingerprint(consent.transportKey), signingKeyFingerprint: fingerprint(consent.signingKey) }) });
    await keep({ ...link, vaultSync: sync }, true);
    return { on: true, error: errors.get(link.id) ?? null };
  });

  /** Root's sending-side pin for this link and its person (public keys only), or null. */
  async function sendingPin(link: InstanceLinkRecord) {
    const pin = await options.vault().broker.linkPin(link.id).catch(() => null);
    return pin?.pinned && !pin.deviceId && pin.ownerUserId === link.ownerUserId ? pin : null;
  }

  /** What Settings lists per link (never the consent): null while sync is off. */
  const state = (link: InstanceLinkRecord) => link.vaultSync && { syncedAt: link.vaultSync.syncedAt, error: errors.get(link.id) ?? link.vaultSync.error };
  /** One link's push at once (Sync now, space_link_parity), then its state. */
  const now = async (link: InstanceLinkRecord) => { await keep(link, true); return state((await options.repository.get(link.ownerUserId, link.id)) ?? link); };
  return { stop, state, now };
}
