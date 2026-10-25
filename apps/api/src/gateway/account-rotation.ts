import type { GatewayAccountRecord } from "@space/db";

/**
 * Accounts Space Gateway sends no requests to: paused, deactivated, or signed out (the provider rejected the sign-in,
 * so its token is stored as expired). Their quota is not capacity, so the quota views leave them out; Space Gateway ›
 * Accounts still lists them with "Sign in again".
 */
export function outOfRotation(account: Pick<GatewayAccountRecord, "status" | "credentialsExpiresAt">, nowMs: number): boolean {
  if (account.status === "PAUSED" || account.status === "DEACTIVATED") return true;
  return account.status === "REAUTH_REQUIRED" && account.credentialsExpiresAt !== null && Date.parse(account.credentialsExpiresAt) <= nowMs;
}

/**
 * Emails of a provider's accounts that Space Gateway keeps out of rotation, for quota views that read the same
 * Google or Claude account from elsewhere (the CLI profiles). An email that also has an account in rotation stays.
 */
export function emailsOutOfRotation(accounts: GatewayAccountRecord[], provider: GatewayAccountRecord["provider"], nowMs: number): Set<string> {
  const out = new Set<string>();
  const used = new Set<string>();
  for (const account of accounts) {
    const email = account.email?.trim().toLowerCase();
    if (account.provider !== provider || !email) continue;
    (outOfRotation(account, nowMs) ? out : used).add(email);
  }
  for (const email of used) out.delete(email);
  return out;
}
