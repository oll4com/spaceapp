import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  type VaultAadContext, type VaultKdfParams, type VaultSymmetricEnvelope, type VaultTransportEnvelope,
  vaultAad, vaultCanonicalJson, vaultSymmetricEnvelopeSchema, vaultTransportEnvelopeSchema
} from "./vault.js";

// Vault crypto (plan clipboard:vEYtT6-bEN0J step 2, ADR-012): AES-GCM, HKDF and SHA-256 on WebCrypto, Ed25519 and X25519
// on @noble/curves (browsers without WebCrypto Ed25519/X25519 failed "Unrecognized name", 2026-10-18), so the operator's
// browser and the root-owned broker run the same code with the same key formats (PKCS8 private, SPKI or raw public). The browser holds the password share and item keys; only the broker holds the ARK.
// shortcut: JavaScript cannot guarantee zeroization; wipeVaultBytes() clears the buffers we own and process isolation does the rest.

export class VaultCryptoError extends Error {
  constructor(readonly code: "OPEN_FAILED" | "BAD_KEY" | "BAD_SIGNATURE" | "EXPIRED") { super(`Vault crypto: ${code}`); }
}

const subtle = () => globalThis.crypto.subtle;
const utf8 = new TextEncoder();
// WebCrypto wants ArrayBuffer-backed views; copying also detaches callers' buffers from what we wipe.
const bytes = (value: Uint8Array) => new Uint8Array(value);

export const vaultBase64url = {
  encode(value: Uint8Array): string {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text: string): Uint8Array {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
};
const b64 = vaultBase64url;

export const vaultRandomBytes = (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length));
export const wipeVaultBytes = (...buffers: (Uint8Array | null | undefined)[]) => { for (const buffer of buffers) buffer?.fill(0); };
export const newVaultHandle = (prefix: "vault" | "vault_item" | "vault_delegation" | "vault_audit" | "vault_pending" | "vault_approval" | "vault_grant" | "vault_key") => `${prefix}:${b64.encode(vaultRandomBytes(16))}`;

/** HKDF-SHA256 to a 32-byte key; `info` names the key's single use. */
export async function deriveVaultKey(inputKey: Uint8Array, info: string, salt: Uint8Array = new Uint8Array(32)): Promise<Uint8Array> {
  if (inputKey.length < 32) throw new VaultCryptoError("BAD_KEY");
  const base = await subtle().importKey("raw", bytes(inputKey), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: bytes(salt), info: utf8.encode(info) }, base, 256));
}

const aesKey = (key: Uint8Array, usage: KeyUsage) => {
  if (key.length !== 32) throw new VaultCryptoError("BAD_KEY");
  return subtle().importKey("raw", bytes(key), "AES-GCM", false, [usage]);
};

export async function sealVaultEnvelope(key: Uint8Array, plaintext: Uint8Array, context: VaultAadContext): Promise<VaultSymmetricEnvelope> {
  const nonce = vaultRandomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: bytes(vaultAad(context)) },
    await aesKey(key, "encrypt"), bytes(plaintext)));
  return { v: 1, alg: "A256GCM", purpose: context.purpose, keyVersion: context.keyVersion, nonce: b64.encode(nonce), ct: b64.encode(ct) };
}

/** Fails closed (OPEN_FAILED) on a wrong key, another context, a tampered field or an unknown version. */
export async function openVaultEnvelope(key: Uint8Array, envelope: unknown, context: VaultAadContext): Promise<Uint8Array> {
  const parsed = vaultSymmetricEnvelopeSchema.safeParse(envelope);
  if (!parsed.success || parsed.data.purpose !== context.purpose || parsed.data.keyVersion !== context.keyVersion) throw new VaultCryptoError("OPEN_FAILED");
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: bytes(b64.decode(parsed.data.nonce)), additionalData: bytes(vaultAad(context)) },
      await aesKey(key, "decrypt"), bytes(b64.decode(parsed.data.ct))));
  } catch {
    throw new VaultCryptoError("OPEN_FAILED");
  }
}

/** VRK = passwordShare XOR serverShare; either share alone is uniformly random. */
export function splitVaultRootKey(vrk: Uint8Array): { passwordShare: Uint8Array; serverShare: Uint8Array } {
  if (vrk.length !== 32) throw new VaultCryptoError("BAD_KEY");
  const serverShare = vaultRandomBytes(32);
  return { passwordShare: vrk.map((byte, index) => byte ^ serverShare[index]!), serverShare };
}
export function joinVaultRootKey(passwordShare: Uint8Array, serverShare: Uint8Array): Uint8Array {
  if (passwordShare.length !== 32 || serverShare.length !== 32) throw new VaultCryptoError("BAD_KEY");
  return passwordShare.map((byte, index) => byte ^ serverShare[index]!);
}

/** Argon2id in the browser; injected so the server never runs the password KDF. */
export type VaultPasswordKdf = (password: string, params: VaultKdfParams) => Promise<Uint8Array>;

/** What the password (or recovery) envelope protects: the password share and the unlock signing key. */
export interface VaultUnlockSecrets { passwordShare: Uint8Array; unlockPrivateKey: Uint8Array }
const packSecrets = (secrets: VaultUnlockSecrets) => utf8.encode(JSON.stringify({ s: b64.encode(secrets.passwordShare), k: b64.encode(secrets.unlockPrivateKey) }));
const unpackSecrets = (plain: Uint8Array): VaultUnlockSecrets => {
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as { s: string; k: string };
  wipeVaultBytes(plain);
  return { passwordShare: b64.decode(parsed.s), unlockPrivateKey: b64.decode(parsed.k) };
};
type VaultScope = Pick<VaultAadContext, "ownerUserId" | "vaultId" | "keyVersion">;

export async function sealPasswordEnvelope(kdf: VaultPasswordKdf, password: string, params: VaultKdfParams, secrets: VaultUnlockSecrets, scope: VaultScope) {
  const kek = await kdf(password, params);
  try { return await sealVaultEnvelope(kek, packSecrets(secrets), { ...scope, purpose: "PASSWORD_SHARE" }); } finally { wipeVaultBytes(kek); }
}
export async function openPasswordEnvelope(kdf: VaultPasswordKdf, password: string, params: VaultKdfParams, envelope: unknown, scope: VaultScope) {
  const kek = await kdf(password, params);
  try { return unpackSecrets(await openVaultEnvelope(kek, envelope, { ...scope, purpose: "PASSWORD_SHARE" })); } finally { wipeVaultBytes(kek); }
}

/** Recovery key: a client-generated 32-byte key shown once; it stands in for the password, never for the broker. */
const recoveryKek = (recoveryKey: Uint8Array, scope: VaultScope) => deriveVaultKey(recoveryKey, `space-vault/recovery/v1|${scope.ownerUserId}|${scope.vaultId}`);
export async function sealRecoveryEnvelope(recoveryKey: Uint8Array, secrets: VaultUnlockSecrets, scope: VaultScope) {
  const kek = await recoveryKek(recoveryKey, scope);
  try { return await sealVaultEnvelope(kek, packSecrets(secrets), { ...scope, purpose: "RECOVERY_SHARE" }); } finally { wipeVaultBytes(kek); }
}
export async function openRecoveryEnvelope(recoveryKey: Uint8Array, envelope: unknown, scope: VaultScope) {
  const kek = await recoveryKek(recoveryKey, scope);
  try { return unpackSecrets(await openVaultEnvelope(kek, envelope, { ...scope, purpose: "RECOVERY_SHARE" })); } finally { wipeVaultBytes(kek); }
}

/** Broker only: S_srv under a key derived from the ARK for this owner and vault. */
const serverShareKey = (ark: Uint8Array, scope: VaultScope) => deriveVaultKey(ark, `space-vault/server-share/v1|${scope.ownerUserId}|${scope.vaultId}`);
export async function sealServerShare(ark: Uint8Array, serverShare: Uint8Array, scope: VaultScope) {
  const key = await serverShareKey(ark, scope);
  try { return await sealVaultEnvelope(key, serverShare, { ...scope, purpose: "SERVER_SHARE" }); } finally { wipeVaultBytes(key); }
}
export async function openServerShare(ark: Uint8Array, envelope: unknown, scope: VaultScope) {
  const key = await serverShareKey(ark, scope);
  try { return await openVaultEnvelope(key, envelope, { ...scope, purpose: "SERVER_SHARE" }); } finally { wipeVaultBytes(key); }
}

/** Broker only: the per-generation key that wraps a delegation's fill key; a new generation retires the old one. */
export const deriveDelegationKey = (ark: Uint8Array, scope: Pick<VaultScope, "ownerUserId" | "vaultId">, generation: number) =>
  deriveVaultKey(ark, `space-vault/delegation/v1|${scope.ownerUserId}|${scope.vaultId}|${generation}`);

/** Ed25519 key pair for unlock challenges and broker certificates (PKCS8 private, SPKI public). */
export async function generateVaultSigningKey(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const seed = ed25519.utils.randomSecretKey();
  try { return await vaultKeyFromSeed("Ed25519", seed); } finally { wipeVaultBytes(seed); }
}
export async function signVaultMessage(privateKey: Uint8Array, message: Uint8Array): Promise<string> {
  const seed = seedOf("Ed25519", privateKey);
  try { return b64.encode(ed25519.sign(bytes(message), seed)); } finally { wipeVaultBytes(seed); }
}
export async function verifyVaultMessage(publicKey: Uint8Array, message: Uint8Array, signature: string): Promise<boolean> {
  try {
    if (publicKey.length !== 44 || SPKI_ED25519.some((byte, index) => publicKey[index] !== byte)) return false;
    // RFC 8032 (strict) verification, as WebCrypto does.
    return ed25519.verify(b64.decode(signature), bytes(message), publicKey.slice(12), { zip215: false });
  } catch {
    return false;
  }
}

/** The bytes the browser signs to unlock: bound to the owner, vault, epoch, one challenge and its reply key. */
export const vaultUnlockChallengeMessage = (input: { ownerUserId: string; vaultId: string; epoch: number; challenge: string; replyPublicKey: string }) =>
  utf8.encode(vaultCanonicalJson({ v: 1, kind: "space-vault-unlock", ...input }));

/** Broker certificates (delegation, use): canonical claims plus an Ed25519 signature; parsed, verified and unexpired. */
export async function signVaultCertificate<T extends object>(privateKey: Uint8Array, claims: T, keyVersion: number) {
  return { claims, sig: await signVaultMessage(privateKey, utf8.encode(vaultCanonicalJson(claims))), keyVersion };
}
export async function verifyVaultCertificate<T extends { expiresAt: string; issuedAt: string }>(
  publicKey: Uint8Array, certificate: unknown, schema: { safeParse(value: unknown): { success: true; data: { claims: T; sig: string; keyVersion: number } } | { success: false } },
  now = new Date()
): Promise<T> {
  const parsed = schema.safeParse(certificate);
  if (!parsed.success || !(await verifyVaultMessage(publicKey, utf8.encode(vaultCanonicalJson(parsed.data.claims)), parsed.data.sig))) {
    throw new VaultCryptoError("BAD_SIGNATURE");
  }
  const { issuedAt, expiresAt } = parsed.data.claims;
  if (Date.parse(issuedAt) > now.getTime() || Date.parse(expiresAt) <= now.getTime()) throw new VaultCryptoError("EXPIRED");
  return parsed.data.claims;
}

/** SHA-256 over canonical JSON, base64url: binds a delegation certificate to its exact fill envelopes. */
export async function vaultDigest(value: unknown): Promise<string> {
  return b64.encode(new Uint8Array(await subtle().digest("SHA-256", utf8.encode(vaultCanonicalJson(value)))));
}

/** X25519 key pair (PKCS8 private, raw public) for sealing to a browser's ephemeral key or the broker. */
export async function generateVaultTransportKey(): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const seed = x25519.utils.randomSecretKey();
  try { return await vaultKeyFromSeed("X25519", seed); } finally { wipeVaultBytes(seed); }
}
async function transportKey(privateSeed: Uint8Array, peerPublic: Uint8Array, ephemeralPublic: Uint8Array, recipientPublic: Uint8Array) {
  if (peerPublic.length !== 32) throw new VaultCryptoError("BAD_KEY");
  // Throws on a small-order peer key (all-zero shared secret), like WebCrypto's deriveBits.
  const shared = x25519.getSharedSecret(privateSeed, bytes(peerPublic));
  const salt = new Uint8Array([...ephemeralPublic, ...recipientPublic]);
  try { return await deriveVaultKey(shared, "space-vault/transport/v1", salt); } finally { wipeVaultBytes(shared); }
}

/** Seals so only the holder of the recipient's private key opens it; whoever relays it sees ciphertext only. */
export async function sealToVaultPublicKey(recipientPublic: Uint8Array, plaintext: Uint8Array, scope: VaultScope): Promise<VaultTransportEnvelope> {
  const ephemeral = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(ephemeral);
  let key: Uint8Array;
  try { key = await transportKey(ephemeral, recipientPublic, epk, recipientPublic); } finally { wipeVaultBytes(ephemeral); }
  try {
    const sealed = await sealVaultEnvelope(key, plaintext, { ...scope, purpose: "TRANSPORT" });
    return { v: 1, alg: "X25519-HKDF-A256GCM", purpose: "TRANSPORT", keyVersion: sealed.keyVersion, epk: b64.encode(epk), nonce: sealed.nonce, ct: sealed.ct };
  } finally { wipeVaultBytes(key); }
}
export async function openWithVaultPrivateKey(recipientPrivate: Uint8Array, recipientPublic: Uint8Array, envelope: unknown, scope: VaultScope): Promise<Uint8Array> {
  const parsed = vaultTransportEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new VaultCryptoError("OPEN_FAILED");
  let key: Uint8Array;
  try {
    const seed = seedOf("X25519", recipientPrivate);
    try { key = await transportKey(seed, b64.decode(parsed.data.epk), b64.decode(parsed.data.epk), recipientPublic); } finally { wipeVaultBytes(seed); }
  } catch {
    throw new VaultCryptoError("OPEN_FAILED");
  }
  const { epk: _epk, ...rest } = parsed.data;
  try { return await openVaultEnvelope(key, { ...rest, alg: "A256GCM" }, { ...scope, purpose: "TRANSPORT" }); } finally { wipeVaultBytes(key); }
}

// Deterministic keys from a 32-byte seed (the broker derives its own keys from the ARK, so it keeps no key files).
const PKCS8_PREFIX = { Ed25519: [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20],
  X25519: [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20] } as const;
const SPKI_ED25519 = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00] as const;
/** The 32-byte seed inside one of our PKCS8 keys (a copy the caller wipes). */
function seedOf(algorithm: "Ed25519" | "X25519", pkcs8: Uint8Array): Uint8Array {
  if (pkcs8.length !== 48 || PKCS8_PREFIX[algorithm].some((byte, index) => pkcs8[index] !== byte)) throw new VaultCryptoError("BAD_KEY");
  return pkcs8.slice(16);
}
/** PKCS8 private key and public key (Ed25519: SPKI; X25519: raw) for a 32-byte seed. */
export async function vaultKeyFromSeed(algorithm: "Ed25519" | "X25519", seed: Uint8Array): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  if (seed.length !== 32) throw new VaultCryptoError("BAD_KEY");
  const privateKey = new Uint8Array([...PKCS8_PREFIX[algorithm], ...seed]);
  const publicKey = algorithm === "Ed25519" ? new Uint8Array([...SPKI_ED25519, ...ed25519.getPublicKey(seed)]) : x25519.getPublicKey(seed);
  return { privateKey, publicKey };
}
/** The public key of one of our PKCS8 private keys (Ed25519: SPKI; X25519: raw). */
export async function vaultPublicKeyOf(algorithm: "Ed25519" | "X25519", privateKey: Uint8Array): Promise<Uint8Array> {
  const seed = seedOf(algorithm, privateKey);
  try { return (await vaultKeyFromSeed(algorithm, seed)).publicKey; } finally { wipeVaultBytes(seed); }
}
