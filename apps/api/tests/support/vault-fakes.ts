import {
  VAULT_KDF_DEFAULTS, generateVaultSigningKey, generateVaultTransportKey, newVaultHandle, sealToVaultPublicKey, sealVaultEnvelope,
  vaultBase64url, vaultRandomBytes, type VaultAuditEvent, type VaultItemRecord
} from "@space/contracts";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpaceStore } from "@space/runtime";
import type { AuthUser } from "@space/contracts";
import { createApp } from "../../src/app.js";
import { cookieName, csrfHeaderName, signSession } from "../../src/auth.js";
import { getApiConfig } from "../../src/config.js";
import type { VaultBroker } from "../../src/vault/broker-client.js";
import type { VaultStore } from "../../src/vault/routes.js";
import { VaultConflictError } from "@space/db";
import { newVaultHandle as newHandle, signVaultCertificate } from "@space/contracts";

// Synthetic values only. The fake store keeps what the Postgres repository keeps (its own tests cover storage).
export const SENTINEL = "SYNTHETIC-vault-route-sentinel";
const sessionSecret = "vault-routes-test-session-secret";

export function fakeRepository(): VaultStore & { delegations: unknown[] } {
  const vaults = new Map<string, any>();
  const items = new Map<string, { owner: string; record: VaultItemRecord }>();
  const nonces = new Map<string, { owner: string; purpose: string; epoch: number; used: boolean }>();
  const delegations: unknown[] = [];
  const protectedPanes = new Map<string, { owner: string; fill: any }>();
  const pending: any[] = [];
  const grants: Array<{ owner: string; certificate: any; revokedAt: string | null }> = [];
  const handoffs: any[] = [];
  const audit = new Map<string, Array<{ id: string; seq: number; event: any; prevHash: string; hash: string; createdAt: string }>>();
  const append = async (owner: string, event: VaultAuditEvent) => {
    if (!vaults.has(owner)) return null;
    const rows = audit.get(owner) ?? [];
    const entry = { id: newVaultHandle("vault_audit"), seq: rows.length + 1, event: { reason: null, itemId: null, origin: null, fields: [], paneId: null, ...event }, prevHash: "", hash: "", createdAt: new Date().toISOString() };
    audit.set(owner, [...rows, entry]);
    return { id: entry.id, seq: entry.seq };
  };
  return {
    delegations,
    getVault: async (owner) => vaults.get(owner) ?? null,
    enroll: async (owner, input) => { const vault = { ...input, ownerUserId: owner, formatVersion: 1, recovery: null, epoch: 1, delegationGeneration: 0, auditSeq: 0, createdAt: "", updatedAt: "", agentAccess: false }; vaults.set(owner, vault); await append(owner, { actor: "OPERATOR", action: "ENROLL", result: "OK" }); return vault; },
    rotateUnlock: async (owner, epoch, input, action = "PASSWORD_ROTATE") => {
      const vault = vaults.get(owner); if (!vault) return null; Object.assign(vault, input, { epoch: vault.epoch + 1 });
      await append(owner, { actor: "OPERATOR", action, result: "OK" }); return vault;
    },
    setRecovery: async (owner, recovery) => { const vault = vaults.get(owner); if (!vault) return false; vault.recovery = recovery; return true; },
    bumpEpoch: async (owner) => { const vault = vaults.get(owner); if (!vault) return null; return (vault.epoch += 1); },
    saveItems: async (owner, records) => vaults.has(owner) ? records.map((record) => { const known = items.get(record.metadata.id); if (known && known.owner !== owner) return null; items.set(record.metadata.id, { owner, record: record as VaultItemRecord }); return record as VaultItemRecord; }) : null,
    saveItem: async (owner, record) => { const known = items.get(record.metadata.id); if (known && known.owner !== owner) return null; items.set(record.metadata.id, { owner, record }); return record; },
    getItem: async (owner, id) => { const known = items.get(id); return known?.owner === owner ? known.record : null; },
    listItems: async (owner) => [...items.values()].filter((item) => item.owner === owner).map((item) => item.record.metadata),
    listItemRecords: async (owner) => [...items.values()].filter((item) => item.owner === owner).map((item) => item.record),
    itemsByLoginKey: async (owner, loginKey) => [...items.values()].filter((item) => item.owner === owner && item.record.metadata.loginKey === loginKey).map((item) => item.record.metadata),
    itemStats: async (owner) => Object.fromEntries([...items.values()].filter((item) => item.owner === owner).map((item) => {
      const fills = (audit.get(owner) ?? []).filter((entry) => entry.event.itemId === item.record.metadata.id && entry.event.action === "FILL" && ["FILLED", "SUBMITTED"].includes(entry.event.result));
      return [item.record.metadata.id, { addedAt: "2026-10-19T00:00:00.000Z", changedAt: "2026-10-19T00:00:00.000Z", uses: fills.length, lastUsedAt: fills.at(-1)?.createdAt ?? null }];
    })),
    deleteItem: async (owner, id) => items.get(id)?.owner === owner && items.delete(id),
    deleteItems: async (owner, ids) => [...new Set(ids)].filter((id) => items.get(id)?.owner === owner && items.delete(id)).length,
    enableAgentAccess: async (owner) => { const vault = vaults.get(owner); if (!vault) return false; vault.agentAccess = true; return true; },
    revokeAgentAccess: async (owner) => {
      const vault = vaults.get(owner); if (!vault) return null;
      for (const grant of grants) if (grant.owner === owner) grant.revokedAt ??= new Date().toISOString();
      for (let index = delegations.length - 1; index >= 0; index -= 1) if ((delegations[index] as { owner: string }).owner === owner) delegations.splice(index, 1);
      vault.agentAccess = false; vault.delegationGeneration += 1; vault.epoch += 1; return { generation: vault.delegationGeneration, epoch: vault.epoch };
    },
    issueNonce: async (owner, purpose) => { const vault = vaults.get(owner); if (!vault) return null; const nonce = vaultBase64url.encode(vaultRandomBytes(32)); nonces.set(nonce, { owner, purpose, epoch: vault.epoch, used: false }); return { nonce, epoch: vault.epoch, generation: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    consumeNonce: async (owner, nonce, purpose) => { const entry = nonces.get(nonce); if (!entry || entry.used || entry.owner !== owner || entry.purpose !== purpose || entry.epoch !== vaults.get(owner)?.epoch) return false; entry.used = true; return true; },
    appendAudit: append,
    listAudit: async (owner, { limit = 50 } = {}) => [...(audit.get(owner) ?? [])].reverse().slice(0, limit),
    verifyAudit: async () => ({ ok: true, brokenAtSeq: null }),
    protectPane: async (owner: string, paneId: string, fill: any) => { if (protectedPanes.has(paneId) && protectedPanes.get(paneId)!.owner !== owner) return false; protectedPanes.set(paneId, { owner, fill }); return true; },
    unprotectPane: async (owner: string, paneId: string) => protectedPanes.get(paneId)?.owner === owner && protectedPanes.delete(paneId),
    protectedPane: async (paneId: string) => protectedPanes.get(paneId) ?? null,
    getActiveDelegation: async (owner: string) => (delegations as Array<{ owner: string; certificate: any; keyEnvelope: unknown; fillEnvelopes: unknown; inboxKeyEnvelope?: unknown }>).filter((entry) => entry.owner === owner)
      .map((entry) => ({ generation: entry.certificate.claims.generation, certificate: entry.certificate, keyEnvelope: entry.keyEnvelope, fillEnvelopes: entry.fillEnvelopes, inboxKeyEnvelope: entry.inboxKeyEnvelope ?? null })).at(-1) ?? null,
    extendDelegation: async (owner: string, input: any) => {
      const entry = (delegations as Array<{ owner: string; certificate: any; fillEnvelopes: any }>).filter((candidate) => candidate.owner === owner).at(-1);
      if (!entry || entry.certificate.claims.certId !== input.basedOn) return "STALE";
      entry.certificate = input.certificate;
      entry.fillEnvelopes = { ...entry.fillEnvelopes, [input.handle]: { ...entry.fillEnvelopes[input.handle], ...input.fieldEnvelopes } };
      return "OK";
    },
    setInbox: async (owner: string, input: any) => { const vault = vaults.get(owner); if (!vault) return false; vault.inbox = input; return true; },
    getInbox: async (owner: string) => vaults.get(owner)?.inbox ?? null,
    addPending: async (owner: string, input: any) => { pending.push({ owner, ...input }); return true; },
    listPending: async (owner: string) => pending.filter((entry) => entry.owner === owner).map(({ owner: _owner, ...entry }) => entry),
    deletePending: async (owner: string, id: string) => { const index = pending.findIndex((entry) => entry.owner === owner && entry.id === id); if (index < 0) return false; pending.splice(index, 1); return true; },
    addSignupGrant: async (owner: string, certificate: any) => { if (!vaults.has(owner) || certificate.claims.ownerUserId !== owner) return false; grants.push({ owner, certificate, revokedAt: null }); return true; },
    listSignupGrants: async (owner: string) => grants.filter((grant) => grant.owner === owner && !grant.revokedAt && Date.parse(grant.certificate.claims.expiresAt) > Date.now()).reverse()
      .map(({ certificate }) => ({ id: certificate.claims.grantId, sites: certificate.claims.sites, dailyCap: certificate.claims.dailyCap, createdAt: certificate.claims.issuedAt, expiresAt: certificate.claims.expiresAt, revokedAt: null, certificate })),
    revokeSignupGrant: async (owner: string, id: string) => { const grant = grants.find((entry) => entry.owner === owner && entry.certificate.claims.grantId === id && !entry.revokedAt); if (!grant) return false; grant.revokedAt = new Date().toISOString(); return true; },
    // API keys handed to agents (plan clipboard:-qvpC_Q0rAVg): what the Postgres repository keeps, in memory.
    addHandoffKey: async (owner: string, input: any) => { handoffs.push({ owner, ...input, createdAt: new Date().toISOString(), takenAt: null, takenByPaneId: null, usedAt: null, usedByPaneId: null }); return true; },
    listHandoffKeys: async (owner: string) => handoffs.filter((key) => key.owner === owner).map(({ owner: _owner, valueSealed, ...key }) => ({ ...key, hasValue: valueSealed !== null && Date.parse(key.expiresAt) > Date.now() })).reverse(),
    takeHandoffKey: async (owner: string, id: string, paneId: string) => {
      const key = handoffs.find((entry) => entry.owner === owner && entry.id === id);
      if (!key || key.usedAt || !key.valueSealed || Date.parse(key.expiresAt) <= Date.now() || (key.takenByPaneId && key.takenByPaneId !== paneId)) return null;
      key.takenAt = new Date().toISOString(); key.takenByPaneId = paneId;
      return { label: key.label, valueSealed: key.valueSealed };
    },
    useHandoffKey: async (owner: string, id: string, paneId: string) => {
      const key = handoffs.find((entry) => entry.owner === owner && entry.id === id);
      if (!key || key.usedAt || key.takenByPaneId !== paneId) return false;
      key.usedAt = new Date().toISOString(); key.usedByPaneId = paneId; key.valueSealed = null;
      return true;
    },
    deleteHandoffKey: async (owner: string, id: string) => { const index = handoffs.findIndex((entry) => entry.owner === owner && entry.id === id); if (index < 0) return false; handoffs.splice(index, 1); return true; },
    // The Postgres repository's own claim checks are covered by its tests; here the next generation is enough.
    createDelegation: async (owner, input: any) => {
      const vault = vaults.get(owner);
      if (!vault) return null;
      if (input.certificate.claims.generation !== vault.delegationGeneration + 1) throw new VaultConflictError("BAD_DELEGATION");
      vault.delegationGeneration += 1;
      delegations.push({ owner, ...input });
      await append(owner, { actor: "OPERATOR", action: "DELEGATE", result: "OK" });
      return { generation: vault.delegationGeneration };
    }
  } as VaultStore;
}

export async function fixture(options: { broker?: VaultBroker } = {}) {
  // The test's own connector key: a clean checkout (public CI) has no host key file to seal API keys with.
  const connectorKeyFile = join(mkdtempSync(join(tmpdir(), "vault-connector-")), "space-connector.key");
  writeFileSync(connectorKeyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const config = getApiConfig({ SPACE_LOG_LEVEL: "silent", SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true", SPACE_INTERNAL_API_TOKEN: "vault-routes-internal-token",
    SPACE_CONNECTOR_KEY_FILE: connectorKeyFile });
  const store = new InMemorySpaceStore();
  const brokerKey = await generateVaultTransportKey();
  const brokerSigning = await generateVaultSigningKey();
  // Tests make the broker misbehave: sign with another key, or sign wider claims than asked.
  const tamper: { signWith?: Uint8Array; widen?: (claims: any) => any } = {};
  const brokerCalls: string[] = [];
  const broker: VaultBroker = options.broker ?? {
    transportKey: async () => ({ publicKey: vaultBase64url.encode(brokerKey.publicKey), keyVersion: 1 }),
    delegationKey: async () => ({ publicKey: vaultBase64url.encode(brokerSigning.publicKey), keyVersion: 1 }),
    // Signs exactly what was asked, like the real broker (unless a test tampers with it).
    revoke: async ({ generation }) => ({ generation }),
    delegate: async ({ sealedFillKey: _sealed, sealedInboxKey: _inbox, operatorSignature: _signature, unlockPublicKey: _key, serverShareEnvelope: _share, ...input }) => ({
      certificate: await signVaultCertificate(tamper.signWith ?? brokerSigning.privateKey,
        (tamper.widen ?? ((claims) => claims))({ v: 1, kind: "DELEGATION", certId: newHandle("vault_delegation"), ...input, issuedAt: new Date(Date.now() - 1000).toISOString() }), 1),
      keyEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ownerUserId: input.ownerUserId, vaultId: input.vaultId, keyVersion: 1, purpose: "FILL_KEY", generation: input.generation })
    }),
    signupGrant: async ({ operatorSignature: _signature, unlockPublicKey: _key, serverShareEnvelope: _share, ...input }) => ({
      certificate: await signVaultCertificate(tamper.signWith ?? brokerSigning.privateKey, (tamper.widen ?? ((claims) => claims))({ v: 1, kind: "SIGNUP_GRANT", ...input, sites: [...input.sites].sort(), issuedAt: new Date(Date.now() - 1000).toISOString() }), 1)
    }),
    signup: async () => { throw new Error("The fake broker does not sign up; vault-e2e uses the real one."); },
    signupRevoke: async (input) => { brokerCalls.push(`signup-revoke:${input.grantId}`); return { revoked: true as const }; },
    signupAutoGrant: async () => { throw new Error("The fake broker mints no grants; vault-e2e uses the real one."); },
    delegatePending: async () => { throw new Error("The fake broker extends no delegation; vault-e2e uses the real one."); },
    sealServerShare: async (input) => { brokerCalls.push(`seal:${input.ownerUserId}`); return sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ...input, purpose: "SERVER_SHARE" }); },
    unlock: async (input) => { brokerCalls.push(`unlock:${input.epoch}`); return sealToVaultPublicKey(vaultBase64url.decode(input.replyPublicKey), vaultRandomBytes(32), { ownerUserId: input.ownerUserId, vaultId: input.vaultId, keyVersion: 1 }); }
  };
  const repository = fakeRepository();
  const app = await createApp({
    store, config, auth: { sessionSecret, devLogin: true, secureCookies: false },
    vault: { repository, broker }
  });
  const session = async (user: AuthUser) => {
    await store.upsertUser(user);
    const cookie = `${cookieName}=${signSession(user, sessionSecret)}`;
    const csrf = (await app.inject({ url: "/api/auth/csrf", headers: { cookie } })).json().csrfToken as string;
    return { cookie, headers: { cookie, [csrfHeaderName]: csrf } };
  };
  return { app, store, config, brokerKey, brokerSigning, brokerCalls, tamper, session, repository };
}

export async function enrollment(brokerPublicKey: Uint8Array, owner: string) {
  const vaultId = newVaultHandle("vault");
  const scope = { ownerUserId: owner, vaultId, keyVersion: 1 };
  const signing = await generateVaultSigningKey();
  return {
    signing,
    body: {
      vaultId, kdf: { ...VAULT_KDF_DEFAULTS, salt: vaultBase64url.encode(vaultRandomBytes(16)) },
      passwordEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), vaultRandomBytes(32), { ...scope, purpose: "PASSWORD_SHARE" }),
      sealedServerShare: await sealToVaultPublicKey(brokerPublicKey, vaultRandomBytes(32), scope),
      unlockPublicKey: vaultBase64url.encode(signing.publicKey), unlockKeyVersion: 1
    }
  };
}

export async function itemRecord(owner: string, vaultId: string, id = newVaultHandle("vault_item")): Promise<VaultItemRecord> {
  const scope = { ownerUserId: owner, vaultId, keyVersion: 1, itemId: id };
  const dek = vaultRandomBytes(32);
  return {
    metadata: { id, label: "Synthetic", origins: ["https://example.com"], fieldRoles: ["PASSWORD"], policy: { agentUse: true, approvalMode: "FULL", submitAllowed: true, maxFillsPerHour: 6, acceptedOriginRisks: [] }, status: "ACTIVE", googleAccountId: null, loginKey: null },
    keyVersion: 1, history: [], dekEnvelope: await sealVaultEnvelope(vaultRandomBytes(32), dek, { ...scope, purpose: "ITEM_KEY" }),
    fields: { PASSWORD: await sealVaultEnvelope(dek, new TextEncoder().encode(SENTINEL), { ...scope, purpose: "ITEM_FIELD", field: "PASSWORD" }) }
  };
}

