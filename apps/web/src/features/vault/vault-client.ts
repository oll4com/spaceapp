import { argon2idAsync } from "@noble/hashes/argon2.js";
import {
  VAULT_KDF_DEFAULTS, generateVaultSigningKey, generateVaultTransportKey, joinVaultRootKey, newVaultHandle, openPasswordEnvelope,
  openVaultEnvelope, openWithVaultPrivateKey, sealPasswordEnvelope, sealRecoveryEnvelope, sealToVaultPublicKey, sealVaultEnvelope,
  signVaultMessage, splitVaultRootKey, vaultPublicKeyOf, vaultDelegationOperatorMessage, vaultDigest, vaultBase64url, vaultRandomBytes, vaultSignupGrantOperatorMessage, vaultUnlockChallengeMessage, wipeVaultBytes,
  type VaultSignupGrantRequest,
  type VaultFieldRole, type VaultItemMetadata, type VaultItemRecord, type VaultItemRecordInput, type VaultKdfParams, type VaultPasswordKdf
} from "@space/contracts";
import type { api as liveApi } from "../../live-api.js";

// The Vault's browser side (plan clipboard:vEYtT6-bEN0J step 5, ADR-012). The master password, the VRK and every
// decrypted field exist only here, in memory; the API receives ciphertext and public keys. The broker's server share
// arrives sealed to a one-time reply key, so the API relays it without being able to read it.

export type VaultApi = Pick<typeof liveApi, "vaultBroker" | "vaultEnroll" | "vaultUnlockChallenge" | "vaultUnlock" | "vaultSetRecovery" | "vaultRotatePassword">;
export type VaultInboxApi = Pick<typeof liveApi, "vaultInbox" | "vaultSetInbox" | "vaultPending" | "vaultDeletePending" | "vaultItem" | "vaultSaveItem">;

const b64 = vaultBase64url;
const utf8 = new TextEncoder();

/** Argon2id with the stored parameters (OWASP-sized defaults: 64 MiB, 3 passes). */
export const argon2idKdf: VaultPasswordKdf = (password, params) =>
  argon2idAsync(utf8.encode(password), b64.decode(params.salt), { t: params.iterations, m: params.memoryKiB, p: params.parallelism, dkLen: params.keyLength });

export interface UnlockedVault {
  ownerUserId: string;
  vaultId: string;
  epoch: number;
  vrk: Uint8Array;
  passwordShare: Uint8Array;
  /** The unlock signing key (PKCS8), kept to rewrap it on a master password change. */
  signingKey: Uint8Array;
}

const newKdfParams = (): VaultKdfParams => ({ ...VAULT_KDF_DEFAULTS, salt: b64.encode(vaultRandomBytes(16)) });
const scopeOf = (ownerUserId: string, vaultId: string) => ({ ownerUserId, vaultId, keyVersion: 1 });

/** Creates the Vault: the browser makes every key; the broker seals the server share. Returns the recovery key, shown once. */
export async function setUpVault(client: VaultApi, ownerUserId: string, password: string, kdf: VaultPasswordKdf = argon2idKdf) {
  const vaultId = newVaultHandle("vault");
  const scope = scopeOf(ownerUserId, vaultId);
  const vrk = vaultRandomBytes(32);
  const { passwordShare, serverShare } = splitVaultRootKey(vrk);
  const signing = await generateVaultSigningKey();
  const params = newKdfParams();
  const broker = await client.vaultBroker();
  const passwordEnvelope = await sealPasswordEnvelope(kdf, password, params, { passwordShare, unlockPrivateKey: signing.privateKey }, scope);
  const sealedServerShare = await sealToVaultPublicKey(b64.decode(broker.publicKey), serverShare, scope);
  wipeVaultBytes(serverShare);
  const enrolled = await client.vaultEnroll({ vaultId, kdf: params, passwordEnvelope, sealedServerShare, unlockPublicKey: b64.encode(signing.publicKey), unlockKeyVersion: 1 });
  const recoveryKey = vaultRandomBytes(32);
  const envelope = await sealRecoveryEnvelope(recoveryKey, { passwordShare, unlockPrivateKey: signing.privateKey }, scope);
  await client.vaultSetRecovery({ keyVersion: 1, envelope, createdAt: new Date().toISOString() });
  const unlocked: UnlockedVault = { ownerUserId, vaultId, epoch: enrolled.epoch, vrk, passwordShare, signingKey: signing.privateKey };
  return { unlocked, recoveryKey: b64.encode(recoveryKey) };
}

/** Unlock: the password opens the password share and signing key; the signed challenge gets the broker's share. */
export async function unlockVault(client: VaultApi, ownerUserId: string, password: string, kdf: VaultPasswordKdf = argon2idKdf): Promise<UnlockedVault> {
  const challenge = await client.vaultUnlockChallenge();
  const scope = scopeOf(ownerUserId, challenge.vaultId);
  // A wrong password fails here (VaultCryptoError), before anything is sent.
  const secrets = await openPasswordEnvelope(kdf, password, challenge.kdf, challenge.passwordEnvelope, scope);
  const reply = await generateVaultTransportKey();
  const replyPublicKey = b64.encode(reply.publicKey);
  const signature = await signVaultMessage(secrets.unlockPrivateKey,
    vaultUnlockChallengeMessage({ ownerUserId, vaultId: challenge.vaultId, epoch: challenge.epoch, challenge: challenge.challenge, replyPublicKey }));
  const answer = await client.vaultUnlock({ challenge: challenge.challenge, replyPublicKey, signature });
  const serverShare = await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, answer.sealedServerShare, scope);
  const vrk = joinVaultRootKey(secrets.passwordShare, serverShare);
  wipeVaultBytes(serverShare, reply.privateKey);
  return { ownerUserId, vaultId: challenge.vaultId, epoch: answer.epoch, vrk, passwordShare: secrets.passwordShare, signingKey: secrets.unlockPrivateKey };
}

export function lockVaultKeys(unlocked: UnlockedVault | null): void {
  if (unlocked) wipeVaultBytes(unlocked.vrk, unlocked.passwordShare, unlocked.signingKey);
}

/** New master password: the same shares and unlock key under a new Argon2id salt; the server starts a new epoch. */
export async function changeMasterPassword(client: VaultApi, unlocked: UnlockedVault, newPassword: string, kdf: VaultPasswordKdf = argon2idKdf): Promise<UnlockedVault> {
  const params = newKdfParams();
  const passwordEnvelope = await sealPasswordEnvelope(kdf, newPassword, params, { passwordShare: unlocked.passwordShare, unlockPrivateKey: unlocked.signingKey }, scopeOf(unlocked.ownerUserId, unlocked.vaultId));
  const { epoch } = await client.vaultRotatePassword({ expectedEpoch: unlocked.epoch, kdf: params, passwordEnvelope, unlockPublicKey: b64.encode(await vaultPublicKeyOf("Ed25519", unlocked.signingKey)), unlockKeyVersion: 1 });
  return { ...unlocked, epoch };
}

export interface VaultItemSecrets { USERNAME?: string; PASSWORD?: string; OTP?: string }
export interface VaultItemDraft extends Omit<VaultItemMetadata, "id" | "fieldRoles" | "status"> { id?: string; status?: VaultItemMetadata["status"]; secrets: VaultItemSecrets }

const itemScope = (unlocked: UnlockedVault, itemId: string) => ({ ownerUserId: unlocked.ownerUserId, vaultId: unlocked.vaultId, keyVersion: 1, itemId });

/**
 * Encrypts an item for saving. Editing keeps the item key; a changed password moves the earlier fields into history
 * (at most 5) until the operator confirms the new one.
 */
export async function encryptVaultItem(unlocked: UnlockedVault, draft: VaultItemDraft, previous?: VaultItemRecord): Promise<VaultItemRecordInput> {
  const id = previous?.metadata.id ?? draft.id ?? newVaultHandle("vault_item");
  const scope = itemScope(unlocked, id);
  const dek = previous ? await openVaultEnvelope(unlocked.vrk, previous.dekEnvelope, { ...scope, purpose: "ITEM_KEY" }) : vaultRandomBytes(32);
  try {
    const roles = (Object.keys(draft.secrets) as VaultFieldRole[]).filter((role) => draft.secrets[role]);
    const fields: VaultItemRecordInput["fields"] = {};
    for (const role of roles) fields[role] = await sealVaultEnvelope(dek, utf8.encode(draft.secrets[role]!), { ...scope, purpose: "ITEM_FIELD", field: role });
    let history = previous?.history ?? [];
    if (previous?.fields.PASSWORD && draft.secrets.PASSWORD) {
      const before = new TextDecoder().decode(await openVaultEnvelope(dek, previous.fields.PASSWORD, { ...scope, purpose: "ITEM_FIELD", field: "PASSWORD" }));
      if (before !== draft.secrets.PASSWORD) history = [...history, { fields: previous.fields, replacedAt: new Date().toISOString() }].slice(-5);
    }
    return {
      metadata: { id, label: draft.label, origins: draft.origins, fieldRoles: roles, policy: draft.policy, status: draft.status ?? "ACTIVE" },
      keyVersion: 1, dekEnvelope: previous?.dekEnvelope ?? await sealVaultEnvelope(unlocked.vrk, dek, { ...scope, purpose: "ITEM_KEY" }), fields, history
    };
  } finally {
    wipeVaultBytes(dek);
  }
}

/** Decrypts an item's fields (or one history entry's) for a local reveal or edit. */
export async function decryptVaultItem(unlocked: UnlockedVault, record: VaultItemRecord, fields = record.fields): Promise<VaultItemSecrets> {
  const scope = itemScope(unlocked, record.metadata.id);
  const dek = await openVaultEnvelope(unlocked.vrk, record.dekEnvelope, { ...scope, purpose: "ITEM_KEY" });
  try {
    const secrets: VaultItemSecrets = {};
    for (const [role, envelope] of Object.entries(fields) as Array<[VaultFieldRole, NonNullable<VaultItemRecord["fields"][VaultFieldRole]>]>) {
      secrets[role] = new TextDecoder().decode(await openVaultEnvelope(dek, envelope, { ...scope, purpose: "ITEM_FIELD", field: role }));
    }
    return secrets;
  } finally {
    wipeVaultBytes(dek);
  }
}

/** Keep a PENDING item, or confirm a changed password: the history is dropped. */
export const confirmVaultItem = (record: VaultItemRecord): VaultItemRecordInput => ({ ...record, metadata: { ...record.metadata, status: "ACTIVE" }, history: [] });
/** Back to the previous password (the last history entry). */
export function restorePreviousVaultItem(record: VaultItemRecord): VaultItemRecordInput | null {
  const last = record.history.at(-1);
  return last ? { ...record, metadata: { ...record.metadata, status: "ACTIVE", fieldRoles: Object.keys(last.fields) as VaultFieldRole[] }, fields: last.fields, history: record.history.slice(0, -1) } : null;
}

/**
 * The inbox key: fills seal generated passwords to its public half while the Vault is locked; its private half lives only
 * under the VRK. Made on the first unlock that finds none.
 */
export async function vaultInboxKey(client: Pick<VaultInboxApi, "vaultInbox" | "vaultSetInbox">, unlocked: UnlockedVault): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const context = { ownerUserId: unlocked.ownerUserId, vaultId: unlocked.vaultId, keyVersion: 1, purpose: "INBOX_KEY" as const };
  const stored = (await client.vaultInbox()).inbox;
  if (stored) return { privateKey: await openVaultEnvelope(unlocked.vrk, stored.privateKeyEnvelope, context), publicKey: b64.decode(stored.publicKey) };
  const pair = await generateVaultTransportKey();
  await client.vaultSetInbox({ publicKey: b64.encode(pair.publicKey), privateKeyEnvelope: await sealVaultEnvelope(unlocked.vrk, pair.privateKey, context) });
  return pair;
}

/** What a login starts with since agents and Nous share one switch (operator decision 2026-10-18); agentUse off hides it from them. */
export const VAULT_AGENT_POLICY = { agentUse: true, approvalMode: "FULL", submitAllowed: true, maxFillsPerHour: 60, acceptedOriginRisks: [] } as const;

/**
 * Logins agents saved and passwords they generated become ACTIVE items at once: a new login is added, a changed password is
 * applied and keeps the old one in history (Restore previous undoes it).
 */
export async function importVaultPending(client: VaultInboxApi, unlocked: UnlockedVault, inbox: { privateKey: Uint8Array; publicKey: Uint8Array }): Promise<number> {
  const scope = scopeOf(unlocked.ownerUserId, unlocked.vaultId);
  const open = async (envelope: unknown) => envelope ? new TextDecoder().decode(await openWithVaultPrivateKey(inbox.privateKey, inbox.publicKey, envelope, scope)) : undefined;
  let imported = 0;
  for (const entry of (await client.vaultPending()).pending) {
    const password = await open(entry.sealedPassword);
    if (entry.kind === "CHANGE_PASSWORD") {
      const previous = (await client.vaultItem(entry.handle)).item;
      const secrets = await decryptVaultItem(unlocked, previous);
      const { id: _id, fieldRoles: _roles, ...metadata } = previous.metadata;
      await client.vaultSaveItem(await encryptVaultItem(unlocked, { ...metadata, status: "ACTIVE", secrets: { ...secrets, PASSWORD: password } }, previous));
    } else {
      await client.vaultSaveItem(await encryptVaultItem(unlocked, { id: entry.handle, label: entry.label, origins: [entry.origin], status: "ACTIVE",
        secrets: { USERNAME: await open(entry.sealedUsername), PASSWORD: password }, policy: { ...VAULT_AGENT_POLICY, acceptedOriginRisks: [] } }));
    }
    await client.vaultDeletePending(entry.id);
    imported += 1;
  }
  return imported;
}

/**
 * A sign-up grant (NEW_ACCOUNT option B): the unlock key signs the exact sites, the daily cap and the expiry, so the broker
 * certifies only what the operator chose here, in the unlocked dock.
 */
export async function signVaultSignupGrant(unlocked: UnlockedVault, input: { sites: string[]; dailyCap: number; days: number }): Promise<VaultSignupGrantRequest> {
  const grant = { grantId: newVaultHandle("vault_grant"), sites: [...input.sites].sort(), dailyCap: input.dailyCap, unlockEpoch: unlocked.epoch,
    expiresAt: new Date(Date.now() + input.days * 86_400_000).toISOString() };
  const message = vaultSignupGrantOperatorMessage({ ownerUserId: unlocked.ownerUserId, vaultId: unlocked.vaultId, ...grant });
  return { ...grant, operatorSignature: await signVaultMessage(unlocked.signingKey, message) };
}

/**
 * Hands every ACTIVE login not hidden from agents to the Vault's broker while agent access is on (operator decision 2026-10-18;
 * the dock does it after each unlock and item change): their fields are sealed under a fresh fill key, the key is sealed to
 * the broker, and the unlock key signs exactly these items, their addresses and fields, the next generation, this unlock and a
 * standing expiry. The broker fills them only at those addresses; a new delegation replaces the previous one, and turning
 * agent access off ends it. Agents never get a value. Null when there is nothing to hand over.
 */
export async function delegateVaultItems(client: Pick<typeof liveApi, "vaultBroker" | "vaultDelegate">, unlocked: UnlockedVault,
  input: { records: VaultItemRecord[]; delegationGeneration: number; epoch?: number; days?: number }): Promise<{ generation: number; count: number } | null> {
  const records = input.records.filter((record) => record.metadata.policy.agentUse && record.metadata.status === "ACTIVE");
  if (records.length === 0) return null;
  const generation = input.delegationGeneration + 1;
  const scope = scopeOf(unlocked.ownerUserId, unlocked.vaultId);
  const fillKey = vaultRandomBytes(32);
  try {
    const fillEnvelopes: Record<string, Partial<Record<VaultFieldRole, Awaited<ReturnType<typeof sealVaultEnvelope>>>>> = {};
    const items = [];
    for (const record of records) {
      const handle = record.metadata.id;
      const secrets = await decryptVaultItem(unlocked, record);
      const fields = (Object.keys(secrets) as VaultFieldRole[]).filter((role) => secrets[role]);
      fillEnvelopes[handle] = {};
      for (const role of fields) {
        fillEnvelopes[handle]![role] = await sealVaultEnvelope(fillKey, utf8.encode(secrets[role]!), { ...scope, purpose: "FILL_FIELD", itemId: handle, field: role, generation });
      }
      // The broker's signed format still names an approval mode; every agent use is FULL now.
      items.push({ handle, origins: record.metadata.origins, fields, approvalMode: "FULL", submit: true });
    }
    const expiresAt = new Date(Date.now() + (input.days ?? 3650) * 86_400_000).toISOString();
    const envelopeDigest = await vaultDigest(fillEnvelopes);
    // The vault's current epoch (a revoke while unlocked moves it on); signing it proves the unlock key is held now.
    const unlockEpoch = input.epoch ?? unlocked.epoch;
    const operatorSignature = await signVaultMessage(unlocked.signingKey, vaultDelegationOperatorMessage({ ownerUserId: unlocked.ownerUserId, vaultId: unlocked.vaultId,
      envelopeDigest, generation, unlockEpoch, expiresAt, items }));
    const broker = await client.vaultBroker();
    const sealedFillKey = await sealToVaultPublicKey(b64.decode(broker.publicKey), fillKey, scope);
    const answer = await client.vaultDelegate({ items, fillEnvelopes, sealedFillKey, generation, unlockEpoch, expiresAt, operatorSignature });
    return { generation: answer.generation, count: items.length };
  } finally {
    wipeVaultBytes(fillKey);
  }
}
