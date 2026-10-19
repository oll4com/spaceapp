import { newVaultHandle, sealToVaultPublicKey, vaultBase64url, type VaultAgentResult, type VaultHostFillResult, type VaultHostSignupRequest } from "@space/contracts";
import type { VaultStore } from "./routes.js";

// The broker's refusal codes as the agent's fixed statuses; anything else is BLOCKED.
const statusOf: Record<string, VaultAgentResult["status"]> = { DAILY_CAP: "RATE_LIMITED", EXPIRED: "EXPIRED", REVOKED: "REVOKED", ORIGIN_MISMATCH: "ORIGIN_MISMATCH" };

/**
 * NEW_ACCOUNT under the operator's sign-up grants (operator decision 2026-10-18, option B), for the agent route's fill path
 * (which checks the custody gate first and audits the outcome). The Browser Host fills on the live page; the broker, reached
 * only over the host's socket, checks the grant, site, day's count and expiry and generates the password. The password comes
 * back here only sealed to the inbox key and waits as a PENDING item for Keep or Discard. Never a value to the agent.
 */
export async function runVaultSignup(deps: {
  repository: Pick<VaultStore, "getVault" | "getInbox" | "listSignupGrants" | "addPending">;
  fill(request: Omit<VaultHostSignupRequest, "mode">): Promise<VaultHostFillResult>;
}, input: {
  owner: string; paneId: string; target: { targetId: string; frameId: string; origin: string }; label: string; username: string | null;
  roles: Array<"NEW_PASSWORD" | "CONFIRM_PASSWORD">; submit: boolean;
}): Promise<{ status: VaultAgentResult["status"]; reason: string | null }> {
  const { repository } = deps;
  const vault = await repository.getVault(input.owner);
  const inbox = vault && await repository.getInbox(input.owner);
  if (!vault || !inbox) return { status: "BLOCKED", reason: "INBOX_NOT_READY" };
  let reason = "NO_SIGNUP_GRANT";
  for (const grant of (await repository.listSignupGrants(input.owner)).filter((entry) => entry.sites.includes(input.target.origin))) {
    const result = await deps.fill({ certificate: grant.certificate, ownerUserId: input.owner, vaultId: vault.vaultId, paneId: input.paneId, ...input.target,
      roles: input.roles, inboxPublicKey: inbox.publicKey, submit: input.submit });
    if ((result.status === "FILLED" || result.status === "SUBMITTED") && result.sealedGenerated) {
      const scope = { ownerUserId: input.owner, vaultId: vault.vaultId, keyVersion: 1 };
      await repository.addPending(input.owner, { id: newVaultHandle("vault_pending"), kind: "NEW_ACCOUNT", handle: newVaultHandle("vault_item"), label: input.label,
        origin: input.target.origin, paneId: input.paneId, sealedPassword: result.sealedGenerated, createdAt: new Date().toISOString(),
        sealedUsername: input.username ? await sealToVaultPublicKey(vaultBase64url.decode(inbox.publicKey), new TextEncoder().encode(input.username), scope) : null });
      return { status: result.status, reason: result.reason };
    }
    if (result.status !== "BLOCKED") return { status: result.status, reason: result.reason };
    reason = result.reason ?? "BROKER_REFUSED";
    // Another grant for the same site may still have uses left today.
    if (reason !== "DAILY_CAP") break;
  }
  return { status: statusOf[reason] ?? "BLOCKED", reason };
}
