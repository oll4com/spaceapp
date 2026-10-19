import { describe, expect, it } from "vitest";
import {
  VAULT_KDF_DEFAULTS, type VaultKdfParams, VaultCryptoError, canonicalVaultOrigin, deriveDelegationKey, generateVaultSigningKey,
  generateVaultTransportKey, joinVaultRootKey, newVaultHandle, openPasswordEnvelope, openRecoveryEnvelope, openServerShare,
  openVaultEnvelope, openWithVaultPrivateKey, sealPasswordEnvelope, sealRecoveryEnvelope, sealServerShare, sealToVaultPublicKey,
  sealVaultEnvelope, signVaultCertificate, signVaultMessage, splitVaultRootKey, vaultAgentResultSchema, vaultAgentSaveRequestSchema, vaultAgentSaveSite, vaultAuditEventSchema,
  vaultBase64url, vaultDelegationCertificateSchema, vaultDigest, vaultEnvelopeSchema, vaultItemMetadataSchema, vaultKdfParamsSchema,
  vaultRandomBytes, vaultUnlockChallengeMessage, verifyVaultCertificate, verifyVaultMessage
} from "../src/index.js";

// Synthetic values only. The test KDF stands in for the browser's Argon2id (PBKDF2 keeps the suite fast).
const SENTINEL = "SYNTHETIC-vault-sentinel-7f3c";
const kdf = async (password: string, params: VaultKdfParams) => {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: vaultBase64url.decode(params.salt), iterations: 1000 }, base, 256));
};
const params: VaultKdfParams = { ...VAULT_KDF_DEFAULTS, salt: vaultBase64url.encode(vaultRandomBytes(16)) };
const scope = { ownerUserId: "user:alice", vaultId: newVaultHandle("vault"), keyVersion: 1 };
const ark = vaultRandomBytes(32);
const text = (value: Uint8Array) => new TextDecoder().decode(value);

async function enroll() {
  const vrk = vaultRandomBytes(32);
  const { passwordShare, serverShare } = splitVaultRootKey(vrk);
  const signing = await generateVaultSigningKey();
  const passwordEnvelope = await sealPasswordEnvelope(kdf, "correct horse", params, { passwordShare, unlockPrivateKey: signing.privateKey }, scope);
  const serverShareEnvelope = await sealServerShare(ark, serverShare, scope);
  return { vrk, passwordShare, serverShare, signing, passwordEnvelope, serverShareEnvelope };
}

describe("Vault two-factor root key", () => {
  it("rebuilds the VRK only from the password share and the broker's server share", async () => {
    const vault = await enroll();
    const unlocked = await openPasswordEnvelope(kdf, "correct horse", params, vault.passwordEnvelope, scope);
    const serverShare = await openServerShare(ark, vault.serverShareEnvelope, scope);
    expect(joinVaultRootKey(unlocked.passwordShare, serverShare)).toEqual(vault.vrk);
    // Either share alone is not the VRK.
    expect(unlocked.passwordShare).not.toEqual(vault.vrk);
    expect(serverShare).not.toEqual(vault.vrk);
    expect(unlocked.unlockPrivateKey).toEqual(vault.signing.privateKey);
  });

  it("fails closed on a wrong password, a wrong ARK, another vault or owner, and tampering", async () => {
    const vault = await enroll();
    await expect(openPasswordEnvelope(kdf, "wrong horse", params, vault.passwordEnvelope, scope)).rejects.toThrow(VaultCryptoError);
    await expect(openServerShare(vaultRandomBytes(32), vault.serverShareEnvelope, scope)).rejects.toThrow(VaultCryptoError);
    await expect(openServerShare(ark, vault.serverShareEnvelope, { ...scope, ownerUserId: "user:bob" })).rejects.toThrow(VaultCryptoError);
    await expect(openServerShare(ark, vault.serverShareEnvelope, { ...scope, vaultId: newVaultHandle("vault") })).rejects.toThrow(VaultCryptoError);
    await expect(openServerShare(ark, vault.serverShareEnvelope, { ...scope, keyVersion: 2 })).rejects.toThrow(VaultCryptoError);
    const ct = vaultBase64url.decode(vault.serverShareEnvelope.ct);
    ct[0] = ct[0]! ^ 1;
    await expect(openServerShare(ark, { ...vault.serverShareEnvelope, ct: vaultBase64url.encode(ct) }, scope)).rejects.toThrow(VaultCryptoError);
    await expect(openServerShare(ark, { ...vault.serverShareEnvelope, v: 2 }, scope)).rejects.toThrow(VaultCryptoError);
    // A server-share envelope never opens as a password envelope (purpose is in the AAD).
    await expect(openVaultEnvelope(ark, vault.serverShareEnvelope, { ...scope, purpose: "PASSWORD_SHARE" })).rejects.toThrow(VaultCryptoError);
  });

  it("recovery replaces the password, never the broker share", async () => {
    const vault = await enroll();
    const recoveryKey = vaultRandomBytes(32);
    const envelope = await sealRecoveryEnvelope(recoveryKey, { passwordShare: vault.passwordShare, unlockPrivateKey: vault.signing.privateKey }, scope);
    const recovered = await openRecoveryEnvelope(recoveryKey, envelope, scope);
    expect(joinVaultRootKey(recovered.passwordShare, await openServerShare(ark, vault.serverShareEnvelope, scope))).toEqual(vault.vrk);
    await expect(openRecoveryEnvelope(vaultRandomBytes(32), envelope, scope)).rejects.toThrow(VaultCryptoError);
  });
});

describe("Vault item envelopes", () => {
  it("binds each field to its owner, vault, item, field and key version", async () => {
    const { vrk } = await enroll();
    const itemId = newVaultHandle("vault_item");
    const dek = vaultRandomBytes(32);
    const dekEnvelope = await sealVaultEnvelope(vrk, dek, { ...scope, purpose: "ITEM_KEY", itemId });
    const field = { ...scope, purpose: "ITEM_FIELD" as const, itemId, field: "PASSWORD" as const };
    const password = await sealVaultEnvelope(dek, new TextEncoder().encode(SENTINEL), field);
    expect(JSON.stringify([dekEnvelope, password])).not.toContain(SENTINEL);
    expect(vaultEnvelopeSchema.safeParse(password).success).toBe(true);
    const opened = await openVaultEnvelope(await openVaultEnvelope(vrk, dekEnvelope, { ...scope, purpose: "ITEM_KEY", itemId }), password, field);
    expect(text(opened)).toBe(SENTINEL);
    for (const moved of [{ field: "USERNAME" as const }, { itemId: newVaultHandle("vault_item") }, { ownerUserId: "user:bob" }]) {
      await expect(openVaultEnvelope(dek, password, { ...field, ...moved })).rejects.toThrow(VaultCryptoError);
    }
  });

  it("schemas have no room for plaintext", () => {
    const envelope = { v: 1, alg: "A256GCM", purpose: "ITEM_FIELD", keyVersion: 1, nonce: "A".repeat(16), ct: "B".repeat(40) };
    expect(vaultEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(vaultEnvelopeSchema.safeParse({ ...envelope, plaintext: SENTINEL }).success).toBe(false);
    expect(vaultAgentResultSchema.safeParse({ status: "FILLED", auditId: newVaultHandle("vault_audit"), value: SENTINEL }).success).toBe(false);
    expect(vaultAuditEventSchema.safeParse({ actor: "AGENT", action: "FILL", result: "BLOCKED", reason: SENTINEL }).success).toBe(false);
    expect(vaultAuditEventSchema.parse({ actor: "AGENT", action: "FILL", result: "BLOCKED", reason: "ORIGIN_CHANGED" }).fields).toEqual([]);
  });

  it("keeps Argon2id parameters within safe bounds", () => {
    expect(vaultKdfParamsSchema.safeParse(params).success).toBe(true);
    expect(vaultKdfParamsSchema.safeParse({ ...params, memoryKiB: 1024 }).success).toBe(false);
    expect(vaultKdfParamsSchema.safeParse({ ...params, iterations: 1 }).success).toBe(false);
    expect(vaultKdfParamsSchema.safeParse({ ...params, alg: "argon2i" }).success).toBe(false);
  });
});

describe("Vault exact origins", () => {
  it("canonicalizes scheme, host and port and refuses wildcards and credentials", () => {
    expect(canonicalVaultOrigin("https://Login.Example.COM:443/path?q=1#x")).toEqual({ origin: "https://login.example.com", warnings: [] });
    expect(canonicalVaultOrigin("https://example.com:8443")?.origin).toBe("https://example.com:8443");
    expect(canonicalVaultOrigin("http://example.com")?.warnings).toEqual(["INSECURE_HTTP"]);
    expect(canonicalVaultOrigin("https://10.0.0.1")?.warnings).toEqual(["IP_LITERAL"]);
    expect(canonicalVaultOrigin("https://exаmple.com")?.warnings).toEqual(["PUNYCODE"]);
    for (const refused of ["https://*.example.com", "https://user:pw@example.com", "ftp://example.com", "javascript:alert(1)", "https://example.com.", "not a url"]) {
      expect(canonicalVaultOrigin(refused)).toBeNull();
    }
  });

  it("stores only exact origins and needs explicit acceptance of a risky one", () => {
    const item = {
      id: newVaultHandle("vault_item"), label: "Synthetic login", origins: ["https://example.com"], fieldRoles: ["USERNAME", "PASSWORD"],
      policy: { agentUse: false, approvalMode: "ASSIST", submitAllowed: false, maxFillsPerHour: 6, acceptedOriginRisks: [] }
    };
    expect(vaultItemMetadataSchema.safeParse(item).success).toBe(true);
    expect(vaultItemMetadataSchema.safeParse({ ...item, origins: ["https://example.com/login"] }).success).toBe(false);
    expect(vaultItemMetadataSchema.safeParse({ ...item, origins: ["http://example.com"] }).success).toBe(false);
    expect(vaultItemMetadataSchema.safeParse({ ...item, origins: ["http://example.com"], policy: { ...item.policy, acceptedOriginRisks: ["http://example.com"] } }).success).toBe(true);
    expect(vaultItemMetadataSchema.safeParse({ ...item, fieldRoles: ["PASSWORD", "PASSWORD"] }).success).toBe(false);
  });
});

describe("Vault unlock challenge, certificates and transport", () => {
  it("verifies an unlock challenge only with the enrolled key and the exact epoch", async () => {
    const signing = await generateVaultSigningKey();
    const reply = await generateVaultTransportKey();
    const message = { ownerUserId: scope.ownerUserId, vaultId: scope.vaultId, epoch: 3, challenge: "c".repeat(32), replyPublicKey: vaultBase64url.encode(reply.publicKey) };
    const signature = await signVaultMessage(signing.privateKey, vaultUnlockChallengeMessage(message));
    expect(await verifyVaultMessage(signing.publicKey, vaultUnlockChallengeMessage(message), signature)).toBe(true);
    expect(await verifyVaultMessage(signing.publicKey, vaultUnlockChallengeMessage({ ...message, epoch: 4 }), signature)).toBe(false);
    expect(await verifyVaultMessage((await generateVaultSigningKey()).publicKey, vaultUnlockChallengeMessage(message), signature)).toBe(false);
  });

  it("seals the server share to the browser's reply key so a relay sees ciphertext only", async () => {
    const reply = await generateVaultTransportKey();
    const serverShare = vaultRandomBytes(32);
    const sealed = await sealToVaultPublicKey(reply.publicKey, serverShare, scope);
    expect(await openWithVaultPrivateKey(reply.privateKey, reply.publicKey, sealed, scope)).toEqual(serverShare);
    const other = await generateVaultTransportKey();
    await expect(openWithVaultPrivateKey(other.privateKey, other.publicKey, sealed, scope)).rejects.toThrow(VaultCryptoError);
    await expect(openWithVaultPrivateKey(reply.privateKey, reply.publicKey, sealed, { ...scope, vaultId: newVaultHandle("vault") })).rejects.toThrow(VaultCryptoError);
  });

  it("accepts only an unexpired, untampered broker delegation certificate", async () => {
    const broker = await generateVaultSigningKey();
    const now = new Date("2026-10-17T12:00:00Z");
    const claims = {
      v: 1 as const, kind: "DELEGATION" as const, certId: newVaultHandle("vault_delegation"), ownerUserId: scope.ownerUserId, vaultId: scope.vaultId,
      generation: 2, unlockEpoch: 5, items: [{ handle: newVaultHandle("vault_item"), origins: ["https://example.com"], fields: ["PASSWORD" as const], approvalMode: "ASSIST" as const, submit: false }],
      envelopeDigest: await vaultDigest({ any: "envelopes" }), issuedAt: "2026-10-17T11:00:00.000Z", expiresAt: "2026-10-18T11:00:00.000Z"
    };
    const certificate = await signVaultCertificate(broker.privateKey, claims, 1);
    expect(await verifyVaultCertificate(broker.publicKey, certificate, vaultDelegationCertificateSchema, now)).toEqual(claims);
    const widened = { ...certificate, claims: { ...claims, items: [{ ...claims.items[0]!, submit: true }] } };
    await expect(verifyVaultCertificate(broker.publicKey, widened, vaultDelegationCertificateSchema, now)).rejects.toThrow("BAD_SIGNATURE");
    await expect(verifyVaultCertificate(broker.publicKey, certificate, vaultDelegationCertificateSchema, new Date("2026-10-19T00:00:00Z"))).rejects.toThrow("EXPIRED");
  });

  it("derives a different delegation key per generation, so revocation retires old envelopes", async () => {
    const first = await deriveDelegationKey(ark, scope, 1);
    const second = await deriveDelegationKey(ark, scope, 2);
    const fill = await sealVaultEnvelope(first, new TextEncoder().encode(SENTINEL), { ...scope, purpose: "FILL_KEY", generation: 1 });
    await expect(openVaultEnvelope(second, fill, { ...scope, purpose: "FILL_KEY", generation: 2 })).rejects.toThrow(VaultCryptoError);
    expect(text(await openVaultEnvelope(first, fill, { ...scope, purpose: "FILL_KEY", generation: 1 }))).toBe(SENTINEL);
  });
});

describe("Vault logins agents save (operator decision 2026-10-18)", () => {
  it("saves at a plain web origin only, with the login the agent created and nothing else", () => {
    expect(vaultAgentSaveSite("https://Shop.Example/register?step=2")).toBe("https://shop.example");
    for (const risky of ["http://shop.example", "https://10.0.0.1", "https://xn--shp-qqa.example", "https://*.example", "ftp://shop.example"]) expect(vaultAgentSaveSite(risky), risky).toBeNull();
    const login = { site: "https://shop.example", username: "synthetic@example.com", password: SENTINEL, label: "Shop" };
    expect(vaultAgentSaveRequestSchema.parse(login)).toEqual(login);
    const { password: _password, ...usernameOnly } = login;
    expect(vaultAgentSaveRequestSchema.safeParse(usernameOnly).success).toBe(true);
    for (const bad of [{ ...login, site: "http://shop.example" }, { ...login, password: "" }, { ...login, otp: "123456" }, { ...login, label: "" }]) {
      expect(vaultAgentSaveRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("Vault sign-up grants (NEW_ACCOUNT option B)", () => {
  it("accepts only exact https hosts on the default port and signs the same bytes whatever the site order", async () => {
    const { vaultSignupSite, vaultSignupGrantOperatorMessage, vaultSignupGrantRequestSchema, VAULT_SIGNUP_GRANT_LIMITS } = await import("../src/vault.js");
    expect(vaultSignupSite("https://Shop.Example/signup?x=1")).toBe("https://shop.example");
    for (const bad of ["http://shop.example", "https://*.shop.example", "https://shop.example:8443", "https://127.0.0.1", "https://xn--80ak6aa92e.com", "shop.example", "https://u:p@shop.example"]) {
      expect(vaultSignupSite(bad)).toBeNull();
    }
    const base = { ownerUserId: "user:alice", vaultId: "vault:AAAAAAAAAAAAAAAAAAAAAA", grantId: "vault_grant:AAAAAAAAAAAAAAAAAAAAAA", dailyCap: 3, unlockEpoch: 1, expiresAt: "2026-11-17T00:00:00.000Z" };
    expect(vaultSignupGrantOperatorMessage({ ...base, sites: ["https://b.example", "https://a.example"] }))
      .toEqual(vaultSignupGrantOperatorMessage({ ...base, sites: ["https://a.example", "https://b.example"] }));
    expect(vaultSignupGrantOperatorMessage({ ...base, sites: ["https://a.example"] })).not.toEqual(vaultSignupGrantOperatorMessage({ ...base, sites: ["https://a.example"], dailyCap: 4 }));
    const request = { grantId: base.grantId, sites: ["https://a.example"], dailyCap: 3, unlockEpoch: 1, expiresAt: base.expiresAt, operatorSignature: "s".repeat(86) };
    expect(vaultSignupGrantRequestSchema.safeParse(request).success).toBe(true);
    expect(vaultSignupGrantRequestSchema.safeParse({ ...request, dailyCap: VAULT_SIGNUP_GRANT_LIMITS.maxDailyCap + 1 }).success).toBe(false);
    expect(vaultSignupGrantRequestSchema.safeParse({ ...request, sites: ["https://a.example", "https://a.example"] }).success).toBe(false);
    expect(vaultSignupGrantRequestSchema.safeParse({ ...request, sites: [] }).success).toBe(false);
  });
});

describe("Vault Ed25519/X25519 on @noble/curves interoperate with WebCrypto (the installed broker)", () => {
  it("signs, verifies and agrees on X25519 secrets in the same key formats WebCrypto uses", async () => {
    const { generateVaultSigningKey, generateVaultTransportKey, signVaultMessage, verifyVaultMessage, vaultPublicKeyOf, vaultBase64url: b64 } = await import("../src/vault-crypto.js");
    const message = new TextEncoder().encode("SYNTHETIC interop message");
    const ours = await generateVaultSigningKey();
    const webPrivate = await crypto.subtle.importKey("pkcs8", new Uint8Array(ours.privateKey), { name: "Ed25519" }, false, ["sign"]);
    const webPublic = await crypto.subtle.importKey("spki", new Uint8Array(ours.publicKey), { name: "Ed25519" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "Ed25519" }, webPublic, b64.decode(await signVaultMessage(ours.privateKey, message)), message)).toBe(true);
    const webSignature = b64.encode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, webPrivate, message)));
    expect(await verifyVaultMessage(ours.publicKey, message, webSignature)).toBe(true);
    expect(await verifyVaultMessage(ours.publicKey, new TextEncoder().encode("other"), webSignature)).toBe(false);
    expect(await vaultPublicKeyOf("Ed25519", ours.privateKey)).toEqual(ours.publicKey);
    const web = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const webPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", web.privateKey));
    expect(await vaultPublicKeyOf("Ed25519", webPkcs8)).toEqual(new Uint8Array(await crypto.subtle.exportKey("spki", web.publicKey)));

    const a = await generateVaultTransportKey();
    const b = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
    const bRaw = new Uint8Array(await crypto.subtle.exportKey("raw", b.publicKey));
    const aWeb = await crypto.subtle.importKey("pkcs8", new Uint8Array(a.privateKey), { name: "X25519" }, false, ["deriveBits"]);
    const aPublicWeb = await crypto.subtle.importKey("raw", new Uint8Array(a.publicKey), { name: "X25519" }, false, []);
    const left = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: await crypto.subtle.importKey("raw", bRaw, { name: "X25519" }, false, []) }, aWeb, 256));
    const right = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: aPublicWeb }, b.privateKey, 256));
    expect(left).toEqual(right);
    expect(await vaultPublicKeyOf("X25519", new Uint8Array(await crypto.subtle.exportKey("pkcs8", b.privateKey)))).toEqual(bRaw);
  });
});
