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
        entry: { handle, origin: entry.origin, sealedUsername: entry.sealedUsername, sealedPassword: entry.sealedPassword } });
      if (await repository.extendDelegation(owner, { basedOn: delegation.certificate.claims.certId, certificate: answer.certificate, handle, fieldEnvelopes: answer.fieldEnvelopes }) === "OK") return;
    }
  } catch { /* retried by the next agent call (joinMissing) or the dock's next delegation */ }
}
