import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GatewayRepository } from "@space/db";
import type { AccountPool, StoredCredentials } from "../accounts/account-pool.js";
import type { CredentialCipher } from "../credential-cipher.js";
import { fetchQuotaSummary, loadCodeAssist } from "../providers/antigravity/code-assist.js";
import { AntigravityAuthError, parseAntigravityTokenFile, refreshGoogleAccessToken } from "../providers/antigravity/oauth.js";
import { refreshAntigravityAccountUsage, storeAntigravityUsage } from "../providers/antigravity/usage-refresh.js";
import { createAdminGuard, publicAccountSummary, type ProviderAccountActions } from "./codex-sign-in.js";

/**
 * Adds an Antigravity account to Space Gateway from a Space Antigravity profile's sign-in (the Space API reads the
 * profile's token file and passes its contents here). Google refresh tokens do not rotate, so the profile keeps
 * working; the gateway stores its copy encrypted.
 */
export function registerAntigravitySignInRoutes(app: FastifyInstance, options: {
  repository: GatewayRepository; pool: AccountPool; cipher: () => CredentialCipher | null; internalToken: string | null; fetchImpl?: typeof fetch; now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const guard = createAdminGuard(options.internalToken);

  app.post("/__space-gateway/admin/antigravity/import", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const body = (request.body ?? {}) as { tokenJson?: unknown; sourceRef?: unknown };
    const sourceRef = typeof body.sourceRef === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(body.sourceRef) ? body.sourceRef : null;
    try {
      const cipher = options.cipher();
      if (!cipher) throw new AntigravityAuthError("credential_key_missing", "The Space Gateway encryption key is missing. Redeploy Space to create it.");
      const tokens = parseAntigravityTokenFile(String(body.tokenJson ?? ""));
      let accessToken = tokens.accessToken;
      let expiresAtMs = tokens.expiresAtMs;
      if (!accessToken || expiresAtMs === null || expiresAtMs - now() < 120_000) {
        const refreshed = await refreshGoogleAccessToken(tokens.refreshToken, { fetchImpl: options.fetchImpl, now });
        accessToken = refreshed.accessToken;
        expiresAtMs = refreshed.expiresAtMs;
      }
      const info = await loadCodeAssist(accessToken, { fetchImpl: options.fetchImpl });
      const externalAccountId = tokens.subject ?? tokens.email;
      if (!externalAccountId) throw new AntigravityAuthError("invalid_identity", "The Antigravity sign-in does not name its Google account.");
      const credentials: StoredCredentials = { accessToken, refreshToken: tokens.refreshToken, idToken: null, upstreamAccountId: info.project, accessExpiresAtMs: expiresAtMs };
      const existing = (await options.repository.listAccounts()).find((account) => account.provider === "ANTIGRAVITY" && account.externalAccountId === externalAccountId);
      const boundId = existing?.id ?? `gw_account:${randomBytes(16).toString("hex")}`;
      const saved = await options.repository.upsertAccount({
        accountId: boundId, provider: "ANTIGRAVITY", label: tokens.email ?? "Antigravity account", email: tokens.email, externalAccountId,
        planType: info.planType, credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), boundId),
        credentialsExpiresAt: new Date(expiresAtMs).toISOString(), source: "PROFILE_ADOPTION", sourceRef, lastRefreshAt: new Date(now()).toISOString()
      });
      options.pool.signedIn(saved.id);
      await fetchQuotaSummary(accessToken, info.project, { fetchImpl: options.fetchImpl })
        .then((groups) => storeAntigravityUsage(options.repository, saved.id, groups)).catch(() => undefined);
      options.pool.invalidate();
      // Read back through the pool, which pauses a free-plan account before anyone sees it active.
      const account = (await options.pool.accounts()).find((item) => item.id === saved.id) ?? saved;
      return { status: "CONNECTED", account: publicAccountSummary(account) };
    } catch (error) {
      if (error instanceof AntigravityAuthError) {
        const upstreamFault = error.code === "transport_error" || (error.statusCode !== null && error.statusCode >= 500);
        return reply.code(upstreamFault ? 502 : 422).send({ error: { code: error.code, message: error.message } });
      }
      return reply.code(502).send({ error: { code: "antigravity_import_failed", message: error instanceof Error ? error.message : "The account could not be added." } });
    }
  });
}

/** Account test (loadCodeAssist, which spends no quota) and usage refresh for Antigravity accounts. */
export function antigravityAccountActions(options: { repository: GatewayRepository; pool: AccountPool; fetchImpl?: typeof fetch; now?: () => number }): ProviderAccountActions {
  const now = options.now ?? Date.now;
  return {
    async test(account) {
      const startedAt = now();
      const credentials = await options.pool.credentials(account);
      try {
        const info = await loadCodeAssist(credentials.accessToken, { fetchImpl: options.fetchImpl });
        await options.pool.markSuccess(account.id);
        return { ok: true, model: null, status: 200, latencyMs: now() - startedAt, error: null, planType: info.planType };
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode;
        return { ok: false, model: null, status: typeof status === "number" ? status : 502, latencyMs: now() - startedAt,
          error: error instanceof Error ? error.message : "The account check failed." };
      }
    },
    async refreshUsage(account) {
      await refreshAntigravityAccountUsage({ repository: options.repository, pool: options.pool, account, fetchImpl: options.fetchImpl });
    }
  };
}
