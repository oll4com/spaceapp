import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VAULT_BROKER_HOST_SOCKET_PATH } from "./broker-client.js";
import { z } from "zod";
import {
  deriveDelegationKey, deriveVaultKey, newVaultHandle, openVaultEnvelope, openWithVaultPrivateKey, sealToVaultPublicKey, sealVaultEnvelope,
  signVaultCertificate, vaultBase64url, vaultCanonicalJson, vaultDelegationCertificateSchema, vaultDelegationOperatorMessage,
  vaultKeyFromSeed, vaultPublicKeyOf, vaultRandomBytes, vaultSymmetricEnvelopeSchema, vaultTransportEnvelopeSchema, generateVaultPassword,
  vaultSignupGrantCertificateSchema, vaultSignupGrantOperatorMessage, vaultSignupGrantRequestSchema, VAULT_SIGNUP_GRANT_LIMITS,
  vaultSignupSite, vaultUnlockChallengeMessage, vaultUseCapabilitySchema, verifyVaultCertificate, verifyVaultMessage, wipeVaultBytes, VAULT_FIELD_ROLES,
  VAULT_BROKER_API_MAX_BYTES, VAULT_DELEGATION_TECHNICAL_MAX_ITEMS,
  VaultCryptoError, canonicalVaultOrigin, type VaultUseClaims
} from "@space/contracts";

// The Vault fill broker (ADR-012), the only process that holds the ARK. It runs as the space-vault user from a root-owned
// copy, behind the space-vault-client socket. Its keys derive from the ARK (no key files); a use capability lives only in
// this process's memory, so a restart voids every outstanding one; the lowest valid delegation generation per vault and a
// hash-chained audit of ids and results are its only state. It never returns a value except sealed to a key the request
// proves: the operator browser's signed reply key, or the Browser Host's reply key behind a one-time capability it signed.

const b64 = vaultBase64url;
const owner = z.string().min(1).max(200);
const vaultId = z.string().regex(/^vault:[A-Za-z0-9_-]{16,64}$/);
const key = z.string().regex(/^[A-Za-z0-9_-]{40,120}$/);
const KEY_VERSION = 1;
const USE_TTL_MS = 60_000;

export const VAULT_BROKER_SOCKET = "/run/space-vault-broker/broker.sock";
export const VAULT_CLIENT_GROUP = "space-vault-client";

/**
 * M1, operator decision Option B (2026-10-18): the broker socket's own posture is the access control, so the broker checks it
 * itself at start: a socket owned by the broker user, group space-vault-client, mode 0660, in a root-owned directory nobody
 * else may write to (so the socket cannot be swapped). No in-process peer check exists.
 */
export function vaultSocketPosture(options: {
  path?: string; ownerUid?: number; group?: string; dirOwnerUid?: number; groupFile?: () => string;
} = {}): { ok: boolean; reason: string | null } {
  const path = options.path ?? VAULT_BROKER_SOCKET;
  try {
    const socket = lstatSync(path);
    if (!socket.isSocket()) return { ok: false, reason: "NOT_A_SOCKET" };
    if (socket.uid !== (options.ownerUid ?? process.getuid?.())) return { ok: false, reason: "SOCKET_OWNER" };
    if ((socket.mode & 0o777) !== 0o660) return { ok: false, reason: "SOCKET_MODE" };
    const groupName = (options.groupFile ?? (() => readFileSync("/etc/group", "utf8")))().split("\n")
      .map((line) => line.split(":")).find((fields) => Number(fields[2]) === socket.gid)?.[0];
    if (groupName !== (options.group ?? VAULT_CLIENT_GROUP)) return { ok: false, reason: "SOCKET_GROUP" };
    const dir = statSync(dirname(path));
    if (dir.uid !== (options.dirOwnerUid ?? 0) || (dir.mode & 0o022) !== 0) return { ok: false, reason: "SOCKET_DIR" };
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: "SOCKET_MISSING" };
  }
}

/** Both broker sockets: the API's (space-vault-client) and the Browser Host's own (space-vault-host, H2 Option A). */
export function vaultBrokerSocketsPosture(): { ok: boolean; reason: string | null } {
  const api = vaultSocketPosture();
  return api.ok ? vaultSocketPosture({ path: VAULT_BROKER_HOST_SOCKET_PATH, group: VAULT_HOST_GROUP }) : api;
}

export class VaultBrokerRefusal extends Error {
  constructor(readonly reason: string) { super(reason); }
}

const schemas = {
  serverShare: z.object({ ownerUserId: owner, vaultId, keyVersion: z.literal(1), sealedServerShare: vaultTransportEnvelopeSchema, unlockPublicKey: key }).strict(),
  unlock: z.object({
    ownerUserId: owner, vaultId, epoch: z.number().int().min(1), challenge: z.string().min(22).max(64), replyPublicKey: key, signature: z.string().length(86),
    unlockPublicKey: key, serverShareEnvelope: vaultSymmetricEnvelopeSchema
  }).strict(),
  delegate: z.object({
    ownerUserId: owner, vaultId, generation: z.number().int().min(1), unlockEpoch: z.number().int().min(1), envelopeDigest: z.string().length(43), expiresAt: z.string().datetime(),
    items: z.array(z.object({ handle: z.string(), origins: z.array(z.string()).min(1), fields: z.array(z.enum(VAULT_FIELD_ROLES)).min(1), approvalMode: z.string(), submit: z.boolean() }).strict()).min(1).max(VAULT_DELEGATION_TECHNICAL_MAX_ITEMS),
    sealedFillKey: vaultTransportEnvelopeSchema, operatorSignature: z.string().length(86), unlockPublicKey: key, serverShareEnvelope: vaultSymmetricEnvelopeSchema,
    /** The inbox's private key sealed to the transport key, so logins agents save join this delegation without an unlock. */
    sealedInboxKey: vaultTransportEnvelopeSchema.optional()
  }).strict(),
  use: z.object({
    ownerUserId: owner, vaultId, certificate: vaultDelegationCertificateSchema, epoch: z.number().int().min(1), handle: z.string(), fields: z.array(z.enum(VAULT_FIELD_ROLES)).min(1).max(3),
    submit: z.boolean(), paneId: z.string().min(1).max(200), targetId: z.string().min(1).max(128), pageId: z.string().min(1).max(128), frameId: z.string().min(1).max(128),
    origin: z.string().max(300), generate: z.object({ roles: z.array(z.enum(["NEW_PASSWORD", "CONFIRM_PASSWORD"])).min(1).max(2), inboxPublicKey: key }).strict().optional()
  }).strict(),
  fill: z.object({ capability: vaultUseCapabilitySchema, keyEnvelope: vaultSymmetricEnvelopeSchema, fieldEnvelopes: z.record(z.string(), vaultSymmetricEnvelopeSchema), replyPublicKey: key }).strict(),
  revoke: z.object({ ownerUserId: owner, vaultId, generation: z.number().int().min(1) }).strict(),
  signupGrant: vaultSignupGrantRequestSchema.extend({ ownerUserId: owner, vaultId, unlockPublicKey: key, serverShareEnvelope: vaultSymmetricEnvelopeSchema }).strict(),
  signup: z.object({
    ownerUserId: owner, vaultId, certificate: vaultSignupGrantCertificateSchema, origin: z.string().max(300), paneId: z.string().min(1).max(200),
    roles: z.array(z.enum(["NEW_PASSWORD", "CONFIRM_PASSWORD"])).min(1).max(2), inboxPublicKey: key, replyPublicKey: key,
    /** The page field's length limits, so the generated password fits it (numbers only: no page pattern runs here). */
    field: z.object({ minLength: z.number().int().min(1).max(128).nullable(), maxLength: z.number().int().min(1).max(512).nullable() }).strict().optional()
  }).strict(),
  signupRevoke: z.object({ ownerUserId: owner, vaultId, grantId: z.string().regex(/^vault_grant:[A-Za-z0-9_-]{16,64}$/) }).strict(),
  autoGrant: z.object({ ownerUserId: owner, vaultId, certificate: vaultDelegationCertificateSchema, origin: z.string().max(300) }).strict(),
  delegatePending: z.object({
    ownerUserId: owner, vaultId, certificate: vaultDelegationCertificateSchema, keyEnvelope: vaultSymmetricEnvelopeSchema, inboxKeyEnvelope: vaultSymmetricEnvelopeSchema,
    entry: z.object({ handle: z.string().regex(/^vault_item:[A-Za-z0-9_-]{16,64}$/), origin: z.string().max(300),
      sealedUsername: vaultTransportEnvelopeSchema.nullable(), sealedPassword: vaultTransportEnvelopeSchema.nullable() }).strict()
  }).strict()
};
/** Grants minted under the delegation: one site, one use, short-lived; no daily cap (operator request 2026-10-20). */
export const VAULT_AUTO_GRANT = { ttlMs: 10 * 60_000 } as const;

// The operator-signed delegation (and sign-up grant) is the whole authorization for a fill (operator decision 2026-10-18,
// plan clipboard:Ml8zElMcc4Ac): no custody report is consulted any more.
export async function createVaultBroker(options: { ark: Uint8Array; stateDir: string; now?: () => Date }) {
  const { ark, stateDir } = options;
  const now = options.now ?? (() => new Date());
  if (ark.length !== 32) throw new Error("The ARK must be 32 bytes.");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const transport = await vaultKeyFromSeed("X25519", await deriveVaultKey(ark, `space-vault/broker-transport/v${KEY_VERSION}`));
  const signing = await vaultKeyFromSeed("Ed25519", await deriveVaultKey(ark, `space-vault/broker-signing/v${KEY_VERSION}`));
  const outstanding = new Map<string, VaultUseClaims>();
  const floorsPath = join(stateDir, "generations.json");
  const auditPath = join(stateDir, "audit.jsonl");
  let floors: Record<string, number> = {};
  try { floors = JSON.parse(readFileSync(floorsPath, "utf8")); } catch { /* first start */ }
  // Sign-up grants: revoked grant ids, the time before which a vault's grants are void (revoke-all), uses per grant and UTC day.
  const signupsPath = join(stateDir, "signups.json");
  let signups: { revoked: string[]; voidBefore: Record<string, string>; uses: Record<string, number> } = { revoked: [], voidBefore: {}, uses: {} };
  try { signups = { ...signups, ...JSON.parse(readFileSync(signupsPath, "utf8")) }; } catch { /* first start */ }
  const saveSignups = (next: typeof signups) => {
    signups = next;
    writeFileSync(`${signupsPath}.tmp`, JSON.stringify(next), { mode: 0o600 });
    renameSync(`${signupsPath}.tmp`, signupsPath);
  };
  let auditHead = "0".repeat(64);
  try { auditHead = (JSON.parse(readFileSync(auditPath, "utf8").trim().split("\n").at(-1) ?? "{}") as { hash?: string }).hash ?? auditHead; } catch { /* first start */ }

  const scope = (input: { ownerUserId: string; vaultId: string }) => ({ ownerUserId: input.ownerUserId, vaultId: input.vaultId, keyVersion: KEY_VERSION });
  // The server share key also binds the enrolled unlock key: a swapped key cannot open it, so it is pinned without state.
  const shareKey = (input: { ownerUserId: string; vaultId: string; unlockPublicKey: string }) => deriveVaultKey(ark,
    `space-vault/server-share/v1|${input.ownerUserId}|${input.vaultId}|${createHash("sha256").update(input.unlockPublicKey).digest("base64url")}`);
  const openShare = async (input: { ownerUserId: string; vaultId: string; unlockPublicKey: string; serverShareEnvelope: unknown }) => {
    const share = await shareKey(input);
    try { return await openVaultEnvelope(share, input.serverShareEnvelope, { ...scope(input), purpose: "SERVER_SHARE" }); }
    catch { throw new VaultBrokerRefusal("SHARE_REFUSED"); }
    finally { wipeVaultBytes(share); }
  };
  const floorKey = (input: { ownerUserId: string; vaultId: string }) => `${input.ownerUserId}|${input.vaultId}`;
  const raiseFloor = (input: { ownerUserId: string; vaultId: string }, generation: number) => {
    if ((floors[floorKey(input)] ?? 0) >= generation) return;
    floors = { ...floors, [floorKey(input)]: generation };
    writeFileSync(`${floorsPath}.tmp`, JSON.stringify(floors), { mode: 0o600 });
    renameSync(`${floorsPath}.tmp`, floorsPath);
  };
  const audit = (op: string, input: { ownerUserId?: string; vaultId?: string }, result: string) => {
    const entry = { at: now().toISOString(), op, ownerUserId: input.ownerUserId ?? null, vaultId: input.vaultId ?? null, result, prev: auditHead };
    auditHead = createHash("sha256").update(vaultCanonicalJson(entry)).digest("hex");
    appendFileSync(auditPath, `${JSON.stringify({ ...entry, hash: auditHead })}\n`, { mode: 0o600 });
  };
  const verifyDelegation = async (certificate: unknown) => {
    try { return await verifyVaultCertificate(signing.publicKey, certificate, vaultDelegationCertificateSchema, now()); } catch { throw new VaultBrokerRefusal("CERTIFICATE_REFUSED"); }
  };
  const verifyCapability = async (capability: unknown) => {
    try { return await verifyVaultCertificate(signing.publicKey, capability, vaultUseCapabilitySchema, now()); } catch { throw new VaultBrokerRefusal("CAPABILITY_REFUSED"); }
  };

  const handlers: Record<string, (body: unknown) => Promise<unknown>> = {
    async "GET /v1/transport-key"() { return { publicKey: b64.encode(transport.publicKey), keyVersion: KEY_VERSION }; },
    async "GET /v1/delegation-key"() { return { publicKey: b64.encode(signing.publicKey), keyVersion: KEY_VERSION }; },
    // Read only, on the API's socket (hardening plan step 16): the newest audit entries' times, ops, results and hashes,
    // never an owner, vault or value. shortcut: reads the whole file; rotate it if it ever grows past a few MB.
    async "GET /v1/audit"() {
      let lines: string[] = [];
      try { lines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean); } catch { /* no entries yet */ }
      const entries = lines.slice(-200).map((line) => { const entry = JSON.parse(line) as { at: string; op: string; result: string; hash: string };
        return { at: entry.at, op: entry.op, result: entry.result, hash: entry.hash }; });
      return { head: auditHead, total: lines.length, entries };
    },

    async "POST /v1/server-share"(raw) {
      const input = schemas.serverShare.parse(raw);
      const share = await openWithVaultPrivateKey(transport.privateKey, transport.publicKey, input.sealedServerShare, scope(input)).catch(() => { throw new VaultBrokerRefusal("SEALED_SHARE_REFUSED"); });
      const sealing = await shareKey(input);
      try { return { serverShareEnvelope: await sealVaultEnvelope(sealing, share, { ...scope(input), purpose: "SERVER_SHARE" }) }; }
      finally { wipeVaultBytes(share, sealing); }
    },

    async "POST /v1/unlock"(raw) {
      const input = schemas.unlock.parse(raw);
      const message = vaultUnlockChallengeMessage({ ownerUserId: input.ownerUserId, vaultId: input.vaultId, epoch: input.epoch, challenge: input.challenge, replyPublicKey: input.replyPublicKey });
      if (!await verifyVaultMessage(b64.decode(input.unlockPublicKey), message, input.signature)) throw new VaultBrokerRefusal("SIGNATURE_REFUSED");
      const share = await openShare(input);
      try { return { sealedServerShare: await sealToVaultPublicKey(b64.decode(input.replyPublicKey), share, scope(input)) }; }
      finally { wipeVaultBytes(share); }
    },

    async "POST /v1/delegate"(raw) {
      const input = schemas.delegate.parse(raw);
      // The operator's unlock key (pinned through the server share) must have signed exactly these items.
      await openShare(input).then((share) => wipeVaultBytes(share));
      // The signature covers the items with their origins, the generation, the unlock epoch and the expiry: none can be swapped.
      const message = vaultDelegationOperatorMessage({ ownerUserId: input.ownerUserId, vaultId: input.vaultId, envelopeDigest: input.envelopeDigest,
        generation: input.generation, unlockEpoch: input.unlockEpoch, expiresAt: input.expiresAt, items: input.items });
      if (!await verifyVaultMessage(b64.decode(input.unlockPublicKey), message, input.operatorSignature)) throw new VaultBrokerRefusal("OPERATOR_SIGNATURE_REFUSED");
      if (input.generation <= (floors[floorKey(input)] ?? 0)) throw new VaultBrokerRefusal("GENERATION_RETIRED");
      if (Date.parse(input.expiresAt) <= now().getTime()) throw new VaultBrokerRefusal("EXPIRED");
      const fillKey = await openWithVaultPrivateKey(transport.privateKey, transport.publicKey, input.sealedFillKey, scope(input)).catch(() => { throw new VaultBrokerRefusal("SEALED_KEY_REFUSED"); });
      const inboxKey = input.sealedInboxKey ? await openWithVaultPrivateKey(transport.privateKey, transport.publicKey, input.sealedInboxKey, scope(input))
        .catch(() => { wipeVaultBytes(fillKey); throw new VaultBrokerRefusal("SEALED_KEY_REFUSED"); }) : null;
      const generationKey = await deriveDelegationKey(ark, input, input.generation);
      try {
        const keyEnvelope = await sealVaultEnvelope(generationKey, fillKey, { ...scope(input), purpose: "FILL_KEY", generation: input.generation });
        const inboxKeyEnvelope = inboxKey ? await sealVaultEnvelope(generationKey, inboxKey, { ...scope(input), purpose: "INBOX_KEY", generation: input.generation }) : undefined;
        const claims = { v: 1 as const, kind: "DELEGATION" as const, certId: newVaultHandle("vault_delegation"), ownerUserId: input.ownerUserId, vaultId: input.vaultId,
          generation: input.generation, unlockEpoch: input.unlockEpoch, items: input.items, envelopeDigest: input.envelopeDigest,
          issuedAt: new Date(now().getTime() - 1000).toISOString(), expiresAt: input.expiresAt };
        // Older generations of this vault stop working from here on.
        raiseFloor(input, input.generation);
        return { certificate: await signVaultCertificate(signing.privateKey, claims, KEY_VERSION), keyEnvelope, ...(inboxKeyEnvelope ? { inboxKeyEnvelope } : {}) };
      } finally { wipeVaultBytes(fillKey, generationKey, ...(inboxKey ? [inboxKey] : [])); }
    },

    // A login an agent saved, created or changed joins the standing delegation at once (operator request 2026-10-20: agents
    // never wait for an unlock). Its values come only from the inbox entry and go only under this delegation's fill key. A new
    // login gets exactly its own site; a changed one keeps the sites the operator signed, so no stored value is ever typed
    // anywhere new. The entry stays in the inbox for the dock's next unlock.
    async "POST /v1/delegate-pending"(raw) {
      const input = schemas.delegatePending.parse(raw);
      const delegation = await verifyDelegation(input.certificate);
      if (delegation.ownerUserId !== input.ownerUserId || delegation.vaultId !== input.vaultId) throw new VaultBrokerRefusal("CERTIFICATE_REFUSED");
      if (delegation.generation < (floors[floorKey(input)] ?? 0)) throw new VaultBrokerRefusal("GENERATION_RETIRED");
      const { entry } = input;
      const existing = delegation.items.find((item) => item.handle === entry.handle);
      if (existing ? Boolean(entry.sealedUsername) || !entry.sealedPassword : canonicalVaultOrigin(entry.origin)?.origin !== entry.origin || !entry.sealedPassword && !entry.sealedUsername) {
        throw new VaultBrokerRefusal("BAD_ENTRY");
      }
      if (!existing && delegation.items.length >= VAULT_DELEGATION_TECHNICAL_MAX_ITEMS) throw new VaultBrokerRefusal("DELEGATION_FULL");
      const generationKey = await deriveDelegationKey(ark, input, delegation.generation);
      const keys: Uint8Array[] = [generationKey];
      try {
        const context = { ...scope(input), generation: delegation.generation };
        const fillKey = await openVaultEnvelope(generationKey, input.keyEnvelope, { ...context, purpose: "FILL_KEY" }).catch(() => { throw new VaultBrokerRefusal("KEY_REFUSED"); });
        keys.push(fillKey);
        const inboxKey = await openVaultEnvelope(generationKey, input.inboxKeyEnvelope, { ...context, purpose: "INBOX_KEY" }).catch(() => { throw new VaultBrokerRefusal("KEY_REFUSED"); });
        keys.push(inboxKey);
        const inboxPublicKey = await vaultPublicKeyOf("X25519", inboxKey);
        const fieldEnvelopes: Partial<Record<"USERNAME" | "PASSWORD", unknown>> = {};
        for (const [role, sealed] of [["USERNAME", entry.sealedUsername], ["PASSWORD", entry.sealedPassword]] as const) {
          if (!sealed) continue;
          const plain = await openWithVaultPrivateKey(inboxKey, inboxPublicKey, sealed, scope(input)).catch(() => { throw new VaultBrokerRefusal("ENTRY_REFUSED"); });
          keys.push(plain);
          fieldEnvelopes[role] = await sealVaultEnvelope(fillKey, plain, { ...context, purpose: "FILL_FIELD", itemId: entry.handle, field: role });
        }
        const roles = Object.keys(fieldEnvelopes) as Array<"USERNAME" | "PASSWORD">;
        const items = existing
          ? delegation.items.map((item) => item.handle === entry.handle ? { ...item, fields: [...new Set([...item.fields, ...roles])] } : item)
          : [...delegation.items, { handle: entry.handle, origins: [entry.origin], fields: roles, approvalMode: "FULL" as const, submit: true }];
        // Same generation, epoch, expiry and issue time: a revoke voids it exactly like the delegation it extends.
        const claims = { ...delegation, certId: newVaultHandle("vault_delegation"), items };
        return { certificate: await signVaultCertificate(signing.privateKey, claims, KEY_VERSION), fieldEnvelopes };
      } finally { wipeVaultBytes(...keys); }
    },

    async "POST /v1/use"(raw) {
      const input = schemas.use.parse(raw);
      const delegation = await verifyDelegation(input.certificate);
      if (delegation.ownerUserId !== input.ownerUserId || delegation.vaultId !== input.vaultId) throw new VaultBrokerRefusal("CERTIFICATE_REFUSED");
      if (delegation.generation < (floors[floorKey(input)] ?? 0)) throw new VaultBrokerRefusal("GENERATION_RETIRED");
      const item = delegation.items.find((entry) => entry.handle === input.handle);
      if (!item || input.fields.some((field) => !item.fields.includes(field)) || !item.origins.includes(input.origin) || (input.submit && !item.submit)) {
        throw new VaultBrokerRefusal("NOT_DELEGATED");
      }
      const issuedAt = now();
      const claims: VaultUseClaims = {
        v: 1, kind: "USE", certId: delegation.certId, ownerUserId: input.ownerUserId, vaultId: input.vaultId, generation: delegation.generation, epoch: input.epoch,
        handle: input.handle, origin: input.origin, fields: input.fields, submit: input.submit, paneId: input.paneId, targetId: input.targetId, pageId: input.pageId,
        frameId: input.frameId, nonce: b64.encode(vaultRandomBytes(32)), issuedAt: new Date(issuedAt.getTime() - 1000).toISOString(),
        expiresAt: new Date(issuedAt.getTime() + USE_TTL_MS).toISOString(), ...(input.generate ? { generate: input.generate } : {})
      };
      for (const [nonce, open] of outstanding) if (Date.parse(open.expiresAt) <= issuedAt.getTime()) outstanding.delete(nonce);
      outstanding.set(claims.nonce, claims);
      return { capability: await signVaultCertificate(signing.privateKey, claims, KEY_VERSION) };
    },

    async "POST /v1/fill"(raw) {
      const input = schemas.fill.parse(raw);
      const claims = await verifyCapability(input.capability);
      // One use, by this process: a nonce that is unknown (another process, a restart) or already used is refused.
      const known = outstanding.get(claims.nonce);
      outstanding.delete(claims.nonce);
      if (!known || vaultCanonicalJson(known) !== vaultCanonicalJson(claims)) throw new VaultBrokerRefusal("CAPABILITY_USED");
      if (claims.generation < (floors[floorKey(claims)] ?? 0)) throw new VaultBrokerRefusal("GENERATION_RETIRED");
      const generationKey = await deriveDelegationKey(ark, claims, claims.generation);
      let fillKey: Uint8Array | null = null;
      try {
        fillKey = await openVaultEnvelope(generationKey, input.keyEnvelope, { ...scope(claims), purpose: "FILL_KEY", generation: claims.generation }).catch(() => { throw new VaultBrokerRefusal("KEY_REFUSED"); });
        const fields: Record<string, string> = {};
        // Only the fields this capability names leave, whatever else the request carries. A generating fill (a password
        // change) types a fresh password and needs no stored field, so none leaves (hardening plan step 15).
        for (const role of claims.generate ? [] : claims.fields) {
          const envelope = input.fieldEnvelopes[role];
          if (!envelope) continue;
          const plain = await openVaultEnvelope(fillKey, envelope, { ...scope(claims), purpose: "FILL_FIELD", itemId: claims.handle, field: role, generation: claims.generation })
            .catch(() => { throw new VaultBrokerRefusal("FIELD_REFUSED"); });
          fields[role] = new TextDecoder().decode(plain);
          wipeVaultBytes(plain);
        }
        return { sealedFields: await sealToVaultPublicKey(b64.decode(input.replyPublicKey), new TextEncoder().encode(JSON.stringify(fields)), scope(claims)) };
      } finally { wipeVaultBytes(generationKey, fillKey); }
    },

    async "POST /v1/signup-grant"(raw) {
      const input = schemas.signupGrant.parse(raw);
      // The operator's unlock key (pinned through the server share) must have signed exactly these sites, cap and expiry.
      await openShare(input).then((share) => wipeVaultBytes(share));
      if (!await verifyVaultMessage(b64.decode(input.unlockPublicKey), vaultSignupGrantOperatorMessage(input), input.operatorSignature)) throw new VaultBrokerRefusal("OPERATOR_SIGNATURE_REFUSED");
      const expires = Date.parse(input.expiresAt);
      if (!(expires > now().getTime() && expires <= now().getTime() + VAULT_SIGNUP_GRANT_LIMITS.maxDays * 86_400_000)) throw new VaultBrokerRefusal("EXPIRED");
      if (signups.revoked.includes(input.grantId)) throw new VaultBrokerRefusal("REVOKED");
      const claims = { v: 1 as const, kind: "SIGNUP_GRANT" as const, grantId: input.grantId, ownerUserId: input.ownerUserId, vaultId: input.vaultId,
        sites: [...input.sites].sort(), dailyCap: input.dailyCap, unlockEpoch: input.unlockEpoch, issuedAt: now().toISOString(), expiresAt: input.expiresAt };
      return { certificate: await signVaultCertificate(signing.privateKey, claims, KEY_VERSION) };
    },

    // NEW_ACCOUNT: a fresh password, generated here, for a site the operator's grant names; sealed to the inbox key (it becomes
    // a PENDING item for Keep or Discard) and to the caller's reply key for the fill. Nothing else leaves.
    async "POST /v1/signup"(raw) {
      const input = schemas.signup.parse(raw);
      let grant;
      try { grant = await verifyVaultCertificate(signing.publicKey, input.certificate, vaultSignupGrantCertificateSchema, now()); }
      catch (error) { throw new VaultBrokerRefusal(error instanceof VaultCryptoError && error.code === "EXPIRED" ? "EXPIRED" : "CERTIFICATE_REFUSED"); }
      if (grant.ownerUserId !== input.ownerUserId || grant.vaultId !== input.vaultId) throw new VaultBrokerRefusal("CERTIFICATE_REFUSED");
      if (signups.revoked.includes(grant.grantId) || grant.issuedAt <= (signups.voidBefore[floorKey(input)] ?? "")) throw new VaultBrokerRefusal("REVOKED");
      if (!grant.sites.includes(input.origin)) throw new VaultBrokerRefusal("ORIGIN_MISMATCH");
      const day = now().toISOString().slice(0, 10);
      const count = `${grant.grantId}|${day}`;
      if ((signups.uses[count] ?? 0) >= grant.dailyCap) throw new VaultBrokerRefusal("DAILY_CAP");
      let generated: string;
      try { generated = generateVaultPassword(input.field ?? {}); } catch { throw new VaultBrokerRefusal("POLICY_UNSATISFIABLE"); }
      // The use counts before anything leaves, so a failure later never gives a free extra one; older days are dropped.
      saveSignups({ ...signups, uses: { ...Object.fromEntries(Object.entries(signups.uses).filter(([entry]) => entry.endsWith(`|${day}`))), [count]: (signups.uses[count] ?? 0) + 1 } });
      const password = new TextEncoder().encode(generated);
      const fields = new TextEncoder().encode(JSON.stringify(Object.fromEntries(input.roles.map((role) => [role, generated]))));
      try {
        return {
          sealedPassword: await sealToVaultPublicKey(b64.decode(input.inboxPublicKey), password, scope(input)),
          sealedFields: await sealToVaultPublicKey(b64.decode(input.replyPublicKey), fields, scope(input))
        };
      } finally { wipeVaultBytes(password, fields); }
    },

    // No grant the operator signed for this site (operator request 2026-10-18): the dock's delegation, signed while "Agents and
    // Nous can use my Vault" is on, is the authorization, so the broker mints a grant for exactly this site, used once by
    // /v1/signup above. Only a certificate leaves; the password is still generated there and never reaches the API.
    async "POST /v1/signup-auto-grant"(raw) {
      const input = schemas.autoGrant.parse(raw);
      const delegation = await verifyDelegation(input.certificate);
      if (delegation.ownerUserId !== input.ownerUserId || delegation.vaultId !== input.vaultId) throw new VaultBrokerRefusal("CERTIFICATE_REFUSED");
      if (delegation.generation < (floors[floorKey(input)] ?? 0) || delegation.issuedAt <= (signups.voidBefore[floorKey(input)] ?? "")) throw new VaultBrokerRefusal("REVOKED");
      if (vaultSignupSite(input.origin) !== input.origin) throw new VaultBrokerRefusal("ORIGIN_MISMATCH");
      const issued = now();
      const claims = { v: 1 as const, kind: "SIGNUP_GRANT" as const, grantId: newVaultHandle("vault_grant"), ownerUserId: input.ownerUserId, vaultId: input.vaultId,
        sites: [input.origin], dailyCap: 1, unlockEpoch: delegation.unlockEpoch, issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + VAULT_AUTO_GRANT.ttlMs).toISOString() };
      return { certificate: await signVaultCertificate(signing.privateKey, claims, KEY_VERSION) };
    },

    async "POST /v1/signup-revoke"(raw) {
      const input = schemas.signupRevoke.parse(raw);
      if (!signups.revoked.includes(input.grantId)) saveSignups({ ...signups, revoked: [...signups.revoked, input.grantId] });
      return { revoked: true };
    },

    async "POST /v1/revoke"(raw) {
      const input = schemas.revoke.parse(raw);
      raiseFloor(input, input.generation);
      // Revoking agent access voids every sign-up grant issued so far too.
      saveSignups({ ...signups, voidBefore: { ...signups.voidBefore, [floorKey(input)]: now().toISOString() } });
      for (const [nonce, claims] of outstanding) if (floorKey(claims) === floorKey(input)) outstanding.delete(nonce);
      return { generation: floors[floorKey(input)] };
    }
  };

  /**
   * One request: the answer, or a refusal that names only a reason code. H2, operator decision Option A (2026-10-18): fills
   * answer only on the Browser Host's own socket, whose only member is the Browser Host, so the reply key a fill is sealed to
   * is always the connecting caller's; the API socket (and everything else) never serves a fill.
   */
  async function handle(method: string, path: string, body: unknown, channel: VaultBrokerChannel = "api"): Promise<{ status: number; body: unknown }> {
    const route = `${method} ${path}`;
    // Plaintext leaves only sealed to the caller's reply key, so the calls that return it answer only the Browser Host (H2).
    const hostOnly = route === "POST /v1/fill" || route === "POST /v1/signup";
    if ((channel === "host") !== hostOnly && !(channel === "host" && route === "GET /v1/delegation-key")) {
      return { status: 404, body: { error: hostOnly ? "FILL_HOST_ONLY" : "NOT_FOUND" } };
    }
    const handler = handlers[route];
    if (!handler) return { status: 404, body: { error: "NOT_FOUND" } };
    const op = path.slice(4);
    try {
      const answer = await handler(body);
      if (method === "POST") audit(op, body as { ownerUserId?: string; vaultId?: string }, "OK");
      return { status: 200, body: answer };
    } catch (error) {
      const reason = error instanceof VaultBrokerRefusal ? error.reason : error instanceof z.ZodError ? "BAD_REQUEST" : "FAILED";
      const subject = (body ?? {}) as { ownerUserId?: unknown; vaultId?: unknown; capability?: { claims?: { ownerUserId?: unknown; vaultId?: unknown } } };
      const ids = { ownerUserId: String(subject.ownerUserId ?? subject.capability?.claims?.ownerUserId ?? "") || undefined, vaultId: String(subject.vaultId ?? subject.capability?.claims?.vaultId ?? "") || undefined };
      audit(op, ids, reason);
      return { status: reason === "BAD_REQUEST" ? 400 : 403, body: { error: reason } };
    }
  }

  return { handle, transportPublicKey: transport.publicKey, signingPublicKey: signing.publicKey, outstandingUses: () => outstanding.size };
}
export type VaultBrokerCore = Awaited<ReturnType<typeof createVaultBroker>>;
/** api: the API's socket (group space-vault-client); host: the Browser Host's socket (group space-vault-host). */
export type VaultBrokerChannel = "api" | "host";
export { VAULT_BROKER_HOST_SOCKET_PATH as VAULT_BROKER_HOST_SOCKET };
export const VAULT_HOST_GROUP = "space-vault-host";

/**
 * HTTP over the broker's socket (systemd hands it over); bodies are JSON. The API's carry whole delegation certificates, so they
 * may reach the technical bound VAULT_BROKER_API_MAX_BYTES; the Browser Host's stay at 64 KiB.
 */
export function createVaultBrokerHttpServer(core: VaultBrokerCore, channel: VaultBrokerChannel = "api"): Server {
  const maxBytes = channel === "api" ? VAULT_BROKER_API_MAX_BYTES : 65_536;
  return createServer((request, response) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) request.destroy(); else chunks.push(chunk); });
    request.on("end", () => {
      void (async () => {
        let body: unknown = undefined;
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; } catch { body = null; }
        const answer = await core.handle(request.method ?? "GET", (request.url ?? "/").split("?")[0]!, body, channel);
        response.writeHead(answer.status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer.body));
      })();
    });
  });
}
