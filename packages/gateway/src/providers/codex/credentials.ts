import type { CredentialRefresher, StoredCredentials } from "../../accounts/account-pool.js";
import { extractCodexClaims, refreshAccessToken, shouldRefresh, type CodexAccountClaims, type CodexTokens } from "./oauth.js";

/** Refresh shortly before the access token expires, and at least every 8 days (codex-lb). */
const EXPIRY_MARGIN_MS = 60_000;

export function codexCredentialsFromTokens(tokens: CodexTokens, claims: CodexAccountClaims): StoredCredentials {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    idToken: tokens.idToken,
    upstreamAccountId: claims.accountId,
    accessExpiresAtMs: extractCodexClaims(tokens.accessToken).expiresAtMs
  };
}

export function createCodexRefresher(options: { fetchImpl?: typeof fetch } = {}): CredentialRefresher {
  return {
    needsRefresh(account, credentials, nowMs) {
      if (!credentials.refreshToken) return false;
      const lastRefresh = account.lastRefreshAt ? Date.parse(account.lastRefreshAt) : 0;
      if (shouldRefresh(lastRefresh, nowMs)) return true;
      return credentials.accessExpiresAtMs !== null && credentials.accessExpiresAtMs - nowMs < EXPIRY_MARGIN_MS;
    },
    async refresh(credentials) {
      const result = await refreshAccessToken(credentials.refreshToken!, { fetchImpl: options.fetchImpl });
      return {
        ...codexCredentialsFromTokens(result, result.claims),
        upstreamAccountId: result.claims.accountId ?? credentials.upstreamAccountId,
        planType: result.claims.planType,
        email: result.claims.email
      };
    }
  };
}
