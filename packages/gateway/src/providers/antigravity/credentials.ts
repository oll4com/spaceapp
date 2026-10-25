import type { CredentialRefresher } from "../../accounts/account-pool.js";
import { refreshGoogleAccessToken } from "./oauth.js";

/** Google access tokens live an hour; refresh two minutes before expiry. The refresh token stays the same. */
const EXPIRY_MARGIN_MS = 2 * 60_000;

export function createAntigravityRefresher(options: { fetchImpl?: typeof fetch; now?: () => number } = {}): CredentialRefresher {
  return {
    needsRefresh(_account, credentials, nowMs) {
      return Boolean(credentials.refreshToken) && (!credentials.accessToken || credentials.accessExpiresAtMs === null
        || credentials.accessExpiresAtMs - nowMs < EXPIRY_MARGIN_MS);
    },
    async refresh(credentials) {
      const refreshed = await refreshGoogleAccessToken(credentials.refreshToken!, options);
      return { ...credentials, accessToken: refreshed.accessToken, accessExpiresAtMs: refreshed.expiresAtMs };
    }
  };
}
