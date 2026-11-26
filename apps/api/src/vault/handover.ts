import { newVaultHandle, openVaultEnvelope, sealToVaultPublicKey, vaultBase64url, wipeVaultBytes, type VaultFieldRole } from "@space/contracts";
import type { PostgresVaultRepository } from "@space/db";
import type { VaultBroker } from "./broker-client.js";

/**
 * A login agents saved, created or changed joins the active delegation at once, so agents never wait for the operator's
 * unlock (operator request 2026-10-20); the dock files the inbox entry as an item when it is next unlocked. A failed attempt
 * is retried on the next agent call that needs the login (agent.ts joinMissing). Never throws.
 */
export async function handOverPendingLogin(repository: Pick<PostgresVaultRepository, "listPending" | "getActiveDelegation" | "extendDelegation" | "getItem">,
  broker: Pick<VaultBroker, "delegatePending">, owner: string, handle: string): Promise<void> {
  try {
    // A new password of a login the operator hid from agents never joins: agents never fill it anyway.
    const item = await repository.getItem(owner, handle);
    if (item && (item.metadata.status !== "ACTIVE" || !item.metadata.policy.agentUse)) return;
    // Another hand-over may land between reading and storing; the next attempt starts from the newer certificate.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entry = (await repository.listPending(owner)).findLast((pending) => pending.handle === handle);
      const delegation = await repository.getActiveDelegation(owner);
      if (!entry || !delegation?.inboxKeyEnvelope) return;
      const answer = await broker.delegatePending({ ownerUserId: owner, vaultId: delegation.certificate.claims.vaultId, certificate: delegation.certificate,
        keyEnvelope: delegation.keyEnvelope, inboxKeyEnvelope: delegation.inboxKeyEnvelope,
        // sealedOtp only when set: an older broker's strict schema refuses the key.
        entry: { handle, origin: entry.origin, sealedUsername: entry.sealedUsername, sealedPassword: entry.sealedPassword, ...(entry.sealedOtp ? { sealedOtp: entry.sealedOtp } : {}) } });
      if (await repository.extendDelegation(owner, { basedOn: delegation.certificate.claims.certId, certificate: answer.certificate, handle, fieldEnvelopes: answer.fieldEnvelopes }) === "OK") return;
    }
  } catch { /* retried by the next agent call (joinMissing) or the dock's next delegation */ }
}

/**
 * Logins whose item key was sealed under the wiped (all-zero) VRK (14/11 14:14Z: a LOCK during the inbox import; 33 skipped on
 * 23/11) open without the VRK, so they reach agents with no unlock (operator rule 31/10): their fields are sealed to the inbox key
 * as a waiting login on the same handle, which joins the delegation like any saved login. The dock seals the item under the VRK
 * again at its next unlock (repairWipedKeyItems) and files the waiting row into it. Anyone holding the database could read these
 * values already; every other item fails the zero key and is left alone. Each handle is tried once per `checked` set.
 */
export async function queueWipedKeyItems(repository: Pick<PostgresVaultRepository, "getVault" | "getInbox" | "listItems" | "getItem" | "listPending" | "addPending">,
  owner: string, held: { has(handle: string): boolean }, checked: Set<string>): Promise<number> {
  const vault = await repository.getVault(owner);
  const inbox = vault && await repository.getInbox(owner);
  if (!vault || !inbox) return 0;
  const waiting = new Set((await repository.listPending(owner)).map((entry) => entry.handle));
  const scope = { ownerUserId: owner, vaultId: vault.vaultId, keyVersion: 1 };
  let queued = 0;
  for (const metadata of await repository.listItems(owner)) {
    const origin = metadata.origins[0];
    if (held.has(metadata.id) || checked.has(metadata.id) || waiting.has(metadata.id) || metadata.status !== "ACTIVE" || !metadata.policy.agentUse || metadata.card || !origin) continue;
    checked.add(metadata.id);
    const item = await repository.getItem(owner, metadata.id);
    const itemScope = { ...scope, itemId: metadata.id };
    const dek = item && await openVaultEnvelope(new Uint8Array(32), item.dekEnvelope, { ...itemScope, purpose: "ITEM_KEY" }).catch(() => null);
    if (!item || !dek) continue;
    try {
      const seal = async (role: VaultFieldRole) => {
        const envelope = item.fields[role];
        if (!envelope) return null;
        const plain = await openVaultEnvelope(dek, envelope, { ...itemScope, purpose: "ITEM_FIELD", field: role });
        try { return await sealToVaultPublicKey(vaultBase64url.decode(inbox.publicKey), plain, scope); } finally { wipeVaultBytes(plain); }
      };
      if (await repository.addPending(owner, { id: newVaultHandle("vault_pending"), kind: "NEW_ACCOUNT", handle: metadata.id, label: metadata.label.slice(0, 80), origin,
        sealedUsername: await seal("USERNAME"), sealedPassword: await seal("PASSWORD"), sealedOtp: await seal("OTP"), paneId: null, createdAt: new Date().toISOString(),
        loginPage: metadata.loginPage })) queued += 1;
    } finally { wipeVaultBytes(dek); }
  }
  return queued;
}
