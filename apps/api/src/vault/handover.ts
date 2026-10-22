import type { PostgresVaultRepository } from "@space/db";
import type { VaultBroker } from "./broker-client.js";

/**
 * A login agents saved, created or changed joins the active delegation at once, so agents never wait for the operator's
 * unlock (operator request 2026-10-20); the inbox entry stays for the dock's next unlock. Without the inbox key (a delegation
 * signed before, or a broker installed before) it simply waits for that unlock, as before. Never throws.
 */
export async function handOverPendingLogin(repository: Pick<PostgresVaultRepository, "listPending" | "getActiveDelegation" | "extendDelegation">, broker: Pick<VaultBroker, "delegatePending">,
  owner: string, handle: string): Promise<void> {
  try {
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
  } catch { /* the entry waits for the dock's next unlock */ }
}
