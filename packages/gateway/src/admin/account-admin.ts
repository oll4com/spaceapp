import type { FastifyInstance } from "fastify";
import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { StoredCredentials } from "../accounts/account-pool.js";
import type { CredentialCipher } from "../credential-cipher.js";
import { extractCodexClaims } from "../providers/codex/oauth.js";
import { createAdminGuard } from "./codex-sign-in.js";

/**
 * Account sign-in details for the Space API, after codex-lb's account view (MIT, Soju06/codex-lb). Token status
 * reports only facts about the stored sign-in (expiry, whether a refresh token and a readable ID token are stored).
 * Export returns a Codex auth.json; the Space API asks the operator to confirm and audits it. Neither refreshes the
 * sign-in.
 */
export function registerAccountAdminRoutes(app: FastifyInstance, options: {
  repository: GatewayRepository;
  cipher: () => CredentialCipher | null;
  internalToken: string | null;
  /** Asks the supervisor for a zero-downtime reload; absent when the gateway runs without one. */
  reload?: () => boolean;
}) {
  const guard = createAdminGuard(options.internalToken);

  async function stored(accountId: string): Promise<{ account: GatewayAccountRecord; credentials: StoredCredentials } | { error: { status: number; code: string; message: string } }> {
    const account = (await options.repository.listAccounts()).find((item) => item.id === accountId);
    if (!account) return { error: { status: 404, code: "not_found", message: "Account not found." } };
    const cipher = options.cipher();
    if (!cipher) return { error: { status: 503, code: "credential_key_missing", message: "The Space Gateway encryption key is missing." } };
    try {
      return { account, credentials: JSON.parse(cipher.decrypt(account.credentialsEncrypted, account.id)) as StoredCredentials };
    } catch {
      return { error: { status: 422, code: "credentials_unreadable", message: "The stored sign-in could not be read." } };
    }
  }

  app.post("/__space-gateway/admin/accounts/:accountId/token-status", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const result = await stored((request.params as { accountId: string }).accountId);
    if ("error" in result) return reply.code(result.error.status).send({ error: { code: result.error.code, message: result.error.message } });
    const { account, credentials } = result;
    let idTokenParsed = false;
    if (credentials.idToken) {
      const claims = extractCodexClaims(credentials.idToken);
      idTokenParsed = Boolean(claims.email || claims.accountId || claims.chatgptUserId);
    }
    const storedMs = account.credentialsExpiresAt ? Date.parse(account.credentialsExpiresAt) : null;
    // A token the provider rejected is stored as expired at that moment, earlier than the expiry it was issued with.
    const rejected = account.status === "REAUTH_REQUIRED" && storedMs !== null && (credentials.accessExpiresAtMs === null || storedMs < credentials.accessExpiresAtMs);
    const expiresAtMs = rejected ? storedMs : credentials.accessExpiresAtMs ?? storedMs;
    return {
      accessExpiresAt: expiresAtMs !== null && Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
      refreshStored: Boolean(credentials.refreshToken),
      idTokenParsed
    };
  });

  app.post("/__space-gateway/admin/accounts/:accountId/export", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const result = await stored((request.params as { accountId: string }).accountId);
    if ("error" in result) return reply.code(result.error.status).send({ error: { code: result.error.code, message: result.error.message } });
    const { account, credentials } = result;
    if (account.provider !== "CODEX" || !credentials.idToken || !credentials.refreshToken) {
      return reply.code(422).send({ error: { code: "export_unsupported", message: "Only ChatGPT (Codex) sign-ins can be exported as auth.json." } });
    }
    const authJson = {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      // Never the refresh token (security addendum step 8): it is a lasting sign-in, so the file works until the access token expires.
      tokens: { id_token: credentials.idToken, access_token: credentials.accessToken, refresh_token: "", account_id: credentials.upstreamAccountId },
      last_refresh: account.lastRefreshAt ?? new Date().toISOString()
    };
    return reply.header("cache-control", "no-store").send({
      accountId: account.id, email: account.email, planType: account.planType, status: account.status, authJson: JSON.stringify(authJson, null, 2)
    });
  });

  /** Applies settings read at worker start (LAN access): a new worker takes over without dropping open streams. */
  app.post("/__space-gateway/admin/reload", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    if (!options.reload) return reply.code(409).send({ error: { code: "reload_unavailable", message: "Space Gateway is not running under its supervisor." } });
    options.reload();
    return reply.code(202).send({ status: "RELOADING" });
  });
}
