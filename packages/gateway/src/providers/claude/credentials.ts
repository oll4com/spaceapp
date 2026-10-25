import type { CredentialRefresher, StoredCredentials } from "../../accounts/account-pool.js";
import { refreshClaudeToken, type ClaudeTokens } from "./oauth.js";

/** Claude access tokens live about 8 hours; refresh a few minutes before they expire. */
const EXPIRY_MARGIN_MS = 5 * 60_000;

export function claudeCredentialsFromTokens(tokens: ClaudeTokens): StoredCredentials {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: null,
    upstreamAccountId: tokens.accountUuid,
    accessExpiresAtMs: tokens.expiresAtMs
  };
}

export function createClaudeRefresher(options: { fetchImpl?: typeof fetch; now?: () => number } = {}): CredentialRefresher {
  return {
    needsRefresh(_account, credentials, nowMs) {
      return Boolean(credentials.refreshToken) && credentials.accessExpiresAtMs !== null && credentials.accessExpiresAtMs - nowMs < EXPIRY_MARGIN_MS;
    },
    async refresh(credentials) {
      const refreshed = await refreshClaudeToken({
        accessToken: credentials.accessToken, refreshToken: credentials.refreshToken!, expiresAtMs: credentials.accessExpiresAtMs, scopes: [],
        accountUuid: credentials.upstreamAccountId, email: null, organizationUuid: null, organizationName: null
      }, options);
      return { ...claudeCredentialsFromTokens(refreshed), email: refreshed.email };
    }
  };
}
