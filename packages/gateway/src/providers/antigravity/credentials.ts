import type { CredentialRefresher } from "../../accounts/account-pool.js";
import { loadCodeAssist } from "./code-assist.js";
import { refreshGoogleAccessToken } from "./oauth.js";

/** Google access tokens live an hour; refresh two minutes before expiry. The refresh token stays the same. */
const EXPIRY_MARGIN_MS = 2 * 60_000;

export function createAntigravityRefresher(options: { fetchImpl?: typeof fetch; now?: () => number; codeAssistBaseUrl?: string } = {}): CredentialRefresher {
  return {
    needsRefresh(_account, credentials, nowMs) {
      return Boolean(credentials.refreshToken) && (!credentials.accessToken || credentials.accessExpiresAtMs === null
        || credentials.accessExpiresAtMs - nowMs < EXPIRY_MARGIN_MS);
    },
    async refresh(credentials) {
      const refreshed = await refreshGoogleAccessToken(credentials.refreshToken!, options);
      // A Google AI Pro that is not renewed lapses to free with no new sign-in (31/10: three accounts): re-read the tier with every
      // token refresh, so the pool pauses a free account; a failed read keeps the stored plan.
      const planType = await loadCodeAssist(refreshed.accessToken, { fetchImpl: options.fetchImpl, baseUrl: options.codeAssistBaseUrl })
        .then((info) => info.planType, () => undefined);
      return { ...credentials, accessToken: refreshed.accessToken, accessExpiresAtMs: refreshed.expiresAtMs, ...(planType ? { planType } : {}) };
    }
  };
}
