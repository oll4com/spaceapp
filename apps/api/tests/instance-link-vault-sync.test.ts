import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { generateVaultSigningKey, generateVaultTransportKey, signVaultMessage, vaultBase64url as b64, vaultOperatorRequestMessage } from "@space/contracts";
import { InMemoryInstanceLinkRepository } from "@space/db";
import { registerLinkVaultSync } from "../src/instance-link/vault-sync.js";

// B's side of Vault→Vault over a Space Link (plan clipboard:TcX66vjNuZDv step 2): what it refuses before its broker or storage is touched.
const owner = "user:operator";

async function linked(scopes: string[], local: { vaultId: string; agentAccess: boolean; delegationGeneration: number } | null, linkPin: (linkId: string) => Promise<unknown> = async () => ({ pinned: false })) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    Object.assign(request, { user: { id: owner }, mobileDevice: { id: "appdev:synthetic-device", scopes } });
  });
  const brokerKey = b64.encode((await generateVaultTransportKey()).publicKey);
  const broker = { transportKey: async () => ({ publicKey: brokerKey, keyVersion: 1 }), revoke: vi.fn(async () => ({ generation: 2 })), sealServerShare: vi.fn(async () => ({})), linkPin: vi.fn(linkPin) };
  const repository = { getVault: async () => local, revokeAgentAccess: vi.fn(), applyLinkSync: vi.fn(async () => ({ items: 0 })) };
  registerLinkVaultSync(app, { vault: () => ({ broker, repository }) as never, repository: new InMemoryInstanceLinkRepository(), call: vi.fn(), routeOptions: {},
    person: () => owner, audit: vi.fn() });
  return { app, brokerKey, broker, repository };
}

async function consent(vaultId: string, transportKey: string, key?: Uint8Array) {
  const unlock = await generateVaultSigningKey();
  const claims = { linkId: "link:synthetic-link-1", transportKey, signingKey: b64.encode((await generateVaultSigningKey()).publicKey), issuedAt: new Date().toISOString() };
  const operatorSignature = await signVaultMessage(key ?? unlock.privateKey, vaultOperatorRequestMessage("link-sync", { ownerUserId: owner, vaultId, ...claims }));
  return { consent: { ...claims, operatorSignature }, unlockPublicKey: b64.encode(unlock.publicKey) };
}
const sealedShare = { v: 1, alg: "X25519-HKDF-A256GCM", purpose: "TRANSPORT", keyVersion: 1, epk: "a".repeat(43), nonce: "b".repeat(16), ct: "c".repeat(43) };
const vaultFields = (vaultId: string, unlockPublicKey: string) => ({ vaultId, kdf: {}, passwordEnvelope: {}, unlockPublicKey, unlockKeyVersion: 1, recovery: null, epoch: 1, inbox: null, sealedServerShare: sealedShare });

describe("Vault sync over a Space Link, the receiving side", () => {
  it("refuses a link its person did not grant Vault, a consent for another broker, a forged one and another vault; storage stays untouched", async () => {
    const ungranted = await linked(["manage"], null);
    expect((await ungranted.app.inject({ method: "GET", url: "/api/instance-link/vault" })).statusCode).toBe(403);

    const { app, brokerKey, broker, repository } = await linked(["vault"], { vaultId: "vault:local", agentAccess: false, delegationGeneration: 1 });
    expect((await app.inject({ method: "GET", url: "/api/instance-link/vault" })).json()).toEqual({ ownerUserId: owner, vaultId: "vault:local", transportKey: brokerKey });
    const push = async (body: unknown) => (await app.inject({ method: "POST", url: "/api/instance-link/vault", payload: body as object })).json().error?.code;

    const elsewhere = await consent("vault:remote", b64.encode((await generateVaultTransportKey()).publicKey));
    expect(await push({ consent: elsewhere.consent, vault: vaultFields("vault:remote", elsewhere.unlockPublicKey) })).toBe("LINK_NOT_THIS_BROKER");
    const forged = await consent("vault:remote", brokerKey, (await generateVaultSigningKey()).privateKey);
    expect(await push({ consent: forged.consent, vault: vaultFields("vault:remote", forged.unlockPublicKey) })).toBe("LINK_SIGNATURE_REFUSED");
    const other = await consent("vault:remote", brokerKey);
    expect(await push({ consent: other.consent, vault: vaultFields("vault:remote", other.unlockPublicKey) })).toBe("VAULT_DIFFERS");
    expect(broker.sealServerShare).not.toHaveBeenCalled();
    expect(repository.applyLinkSync).not.toHaveBeenCalled();
  });

  it("a stop turns agent access off here and raises the broker's floor past the landed generation", async () => {
    const { app, brokerKey, broker, repository } = await linked(["vault"], { vaultId: "vault:local", agentAccess: true, delegationGeneration: 4 });
    const { consent: signed } = await consent("vault:local", brokerKey);
    const answer = await app.inject({ method: "POST", url: "/api/instance-link/vault", payload: { consent: signed, stop: true } });
    expect(answer.json()).toEqual({ stopped: true });
    expect(broker.revoke).toHaveBeenCalledWith({ ownerUserId: owner, vaultId: "vault:local", generation: 5 });
    expect(repository.revokeAgentAccess).toHaveBeenCalledWith(owner, "SYSTEM");
  });

  it("an unsigned consent lands only from the device and keys root pinned for the link; revoking the device's Vault scope stops the next push", async () => {
    const signingKey = b64.encode((await generateVaultSigningKey()).publicKey);
    const pin = { pinned: true, linkId: "link:synthetic-link-1", ownerUserId: owner, transportKey: "t".repeat(43), signingKey, deviceId: "appdev:synthetic-device" };
    let current: Record<string, unknown> = { pinned: false };
    const scopes = ["vault"];
    const { app, brokerKey, broker, repository } = await linked(scopes, null, async () => current);
    const push = async (body: object) => (await app.inject({ method: "POST", url: "/api/instance-link/vault", payload: body })).json();
    const unsigned = { linkId: "link:synthetic-link-1", transportKey: brokerKey, signingKey, issuedAt: new Date().toISOString() };
    const body = { consent: unsigned, vault: vaultFields("vault:remote", b64.encode((await generateVaultSigningKey()).publicKey)) };
    expect((await push(body)).error.code).toBe("LINK_NOT_PINNED");
    for (const bad of [{ ...pin, deviceId: "appdev:other-device" }, { ...pin, ownerUserId: "user:someone-else" }, { ...pin, signingKey: b64.encode((await generateVaultSigningKey()).publicKey) }, { ...pin, deviceId: undefined }]) {
      current = bad;
      expect((await push(body)).error.code).toBe("LINK_NOT_PINNED");
    }
    expect(broker.sealServerShare).not.toHaveBeenCalled();
    current = pin;
    expect(await push(body)).toEqual({ items: 0, delegation: false });
    expect(broker.sealServerShare).toHaveBeenCalledTimes(1);
    expect(repository.applyLinkSync).toHaveBeenCalledTimes(1);
    scopes.length = 0;
    expect((await push(body)).error.code).toBe("LINK_VAULT_NOT_GRANTED");
    expect(broker.sealServerShare).toHaveBeenCalledTimes(1);
  });
});

describe("Vault sync over a Space Link, replacing an empty receiving Vault (operator 23/11, nous_msg:931c907c)", () => {
  it("a pinned push asks the repository to replace another Vault, audits a replace, and is refused at once while agent access is on there", async () => {
    const signingKey = b64.encode((await generateVaultSigningKey()).publicKey);
    const local = { vaultId: "vault:local", agentAccess: false, delegationGeneration: 1 };
    const app = Fastify();
    app.addHook("onRequest", async (request) => { Object.assign(request, { user: { id: owner }, mobileDevice: { id: "appdev:synthetic-device", scopes: ["vault"] } }); });
    const brokerKey = b64.encode((await generateVaultTransportKey()).publicKey);
    const broker = { transportKey: async () => ({ publicKey: brokerKey, keyVersion: 1 }), sealServerShare: vi.fn(async () => ({})),
      linkPin: async () => ({ pinned: true, linkId: "link:synthetic-link-1", ownerUserId: owner, transportKey: brokerKey, signingKey, deviceId: "appdev:synthetic-device" }) };
    const repository = { getVault: async () => local, applyLinkSync: vi.fn(async () => ({ items: 0, delegation: false, replaced: "vault:local" })) };
    const audit = vi.fn(async () => undefined);
    registerLinkVaultSync(app, { vault: () => ({ broker, repository }) as never, repository: new InMemoryInstanceLinkRepository(), call: vi.fn(), routeOptions: {}, person: () => owner, audit });
    const body = { consent: { linkId: "link:synthetic-link-1", transportKey: brokerKey, signingKey, issuedAt: new Date().toISOString() },
      vault: vaultFields("vault:remote", b64.encode((await generateVaultSigningKey()).publicKey)) };
    const push = async () => (await app.inject({ method: "POST", url: "/api/instance-link/vault", payload: body })).json();

    expect(await push()).toEqual({ items: 0, delegation: false });
    expect(repository.applyLinkSync).toHaveBeenCalledWith(owner, expect.objectContaining({ replaceEmpty: true }));
    expect(audit).toHaveBeenCalledWith(expect.anything(), "instance_link.vault_replaced", "link:synthetic-link-1", { replacedVaultId: "vault:local", vaultId: "vault:remote" });

    local.agentAccess = true;
    expect((await push()).error.code).toBe("VAULT_DIFFERS");
    expect(repository.applyLinkSync).toHaveBeenCalledTimes(1);
  });
});

describe("Vault sync over a Space Link, the sending side without an unlock (operator rule 4d47dcab)", () => {
  it("turns sync on without a consent only on a pinned link whose peer grants Vault and answers with the pinned broker", async () => {
    const transportKey = b64.encode((await generateVaultTransportKey()).publicKey);
    const signingKey = b64.encode((await generateVaultSigningKey()).publicKey);
    let pin: Record<string, unknown> = { pinned: false };
    let peer: { status: number; body: unknown } = { status: 200, body: { ownerUserId: owner, vaultId: "vault:local", transportKey } };
    const broker = { linkPin: vi.fn(async () => pin), delegationKey: async () => ({ publicKey: signingKey, keyVersion: 1 }) };
    const repository = { getVault: async () => ({ vaultId: "vault:local", unlockPublicKey: signingKey }), linkMark: async () => null };
    const links = new InMemoryInstanceLinkRepository();
    const link = await links.create({ id: "link:synthetic-link-1", ownerUserId: owner, label: "B", origins: ["https://b.example"], noisePublic: "n", identityPublic: "i",
      deviceId: "appdev:synthetic-device", sealedDevicePrivate: "s", scopes: ["vault"], accessKeys: null });
    const audit = vi.fn(async () => undefined);
    const app = Fastify();
    registerLinkVaultSync(app, { vault: () => ({ broker, repository }) as never, repository: links, call: vi.fn(async () => peer) as never, routeOptions: {}, person: () => owner, audit });
    const on = async () => (await app.inject({ method: "POST", url: `/api/instance-links/${link.id}/vault`, payload: { on: true } })).json();
    expect((await on()).error.code).toBe("LINK_NOT_PINNED");
    pin = { pinned: true, linkId: link.id, ownerUserId: "user:someone-else", transportKey, signingKey: "x".repeat(43) };
    expect((await on()).error.code).toBe("LINK_NOT_PINNED");
    pin = { pinned: true, linkId: link.id, ownerUserId: owner, transportKey, signingKey: "x".repeat(43), deviceId: "appdev:synthetic-device" };
    expect((await on()).error.code).toBe("LINK_NOT_PINNED");
    pin = { pinned: true, linkId: link.id, ownerUserId: owner, transportKey, signingKey: "x".repeat(43) };
    expect((await app.inject({ method: "GET", url: `/api/instance-links/${link.id}/vault` })).json()).toMatchObject({ pinned: true, signingKey });
    peer = { status: 403, body: { error: { code: "LINK_VAULT_NOT_GRANTED" } } };
    expect((await on()).error.code).toBe("LINK_VAULT_NOT_GRANTED");
    peer = { status: 200, body: { ownerUserId: owner, vaultId: "vault:local", transportKey: b64.encode((await generateVaultTransportKey()).publicKey) } };
    expect((await on()).error.code).toBe("LINK_PIN_MISMATCH");
    expect((await links.get(owner, link.id))!.vaultSync).toBeNull();
    peer = { status: 200, body: { ownerUserId: owner, vaultId: "vault:local", transportKey } };
    expect(await on()).toEqual({ on: true, error: null });
    expect((await links.get(owner, link.id))!.vaultSync!.consent).toMatchObject({ linkId: link.id, transportKey, signingKey });
    expect((await links.get(owner, link.id))!.vaultSync!.consent.operatorSignature).toBeUndefined();
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), "instance_link.vault_sync", link.id, expect.objectContaining({ on: true, pinned: true,
      transportKeyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), signingKeyFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    // A consent still needs the unlocked Vault's signature.
    const { consent: unsignedish } = await consent("vault:local", transportKey);
    expect((await app.inject({ method: "POST", url: `/api/instance-links/${link.id}/vault`, payload: { on: true, consent: { ...unsignedish, operatorSignature: undefined } } })).json().error.code).toBe("VAULT_SIGNATURE_REFUSED");
    await app.close();
  });
});
