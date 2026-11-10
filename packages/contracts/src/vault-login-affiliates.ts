/** Reviewed, directional login origins signed into delegations; a broker older than vaultOriginCovers (2026-10-30) fills only signed origins. */
export const VAULT_LOGIN_AFFILIATES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  // TAXISnet redirects its imported Chrome origin to the GSIS Oracle OAM login (operator request 2026-10-29).
  "https://www1.gsis.gr": Object.freeze(["https://login.gsis.gr"])
});

/** Expand only the exact stored origins, before the unlocked client signs the delegation. Stored items stay unchanged. */
export function vaultDelegationOrigins(origins: readonly string[]): string[] {
  return [...new Set(origins.flatMap(origin => [origin,
    ...(Object.hasOwn(VAULT_LOGIN_AFFILIATES, origin) ? VAULT_LOGIN_AFFILIATES[origin]! : [])]))];
}
