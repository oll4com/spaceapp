import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { GatewayRepository } from "@space/db";
import type { AccountPool } from "../accounts/account-pool.js";
import type { CredentialCipher } from "../credential-cipher.js";
import { checkClaudeApiKey, isClaudeApiKeyAccount } from "../providers/claude/api-key.js";
import { claudeCredentialsFromTokens } from "../providers/claude/credentials.js";
import {
  buildClaudeAuthorizationUrl, ClaudeOAuthError, exchangeClaudeCode, generateClaudePkce, parseClaudeAuthorizationCode, type ClaudeTokens
} from "../providers/claude/oauth.js";
import { fetchClaudeProfile, fetchClaudeUsage } from "../providers/claude/usage.js";
import { refreshClaudeAccountUsage, storeClaudeUsage } from "../providers/claude/usage-refresh.js";
import { createAdminGuard, publicAccountSummary, type ProviderAccountActions } from "./codex-sign-in.js";

/**
 * Claude subscription sign-in for Space Gateway, served to the Space API only. The operator signs in on claude.ai
 * and pastes back the code shown afterwards; the tokens are encrypted here and never leave the gateway.
 * Each sign-in is its own session, independent of any Claude profile on this server.
 */
const FLOW_TTL_MS = 15 * 60_000;

interface ClaudeFlow { verifier: string; state: string; expiresAt: number }

export interface ClaudeSignInOptions {
  repository: GatewayRepository;
  pool: AccountPool;
  cipher: () => CredentialCipher | null;
  internalToken: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function registerClaudeSignInRoutes(app: FastifyInstance, options: ClaudeSignInOptions) {
  const now = options.now ?? Date.now;
  const flows = new Map<string, ClaudeFlow>();
  const guard = createAdminGuard(options.internalToken);
  const prune = () => { for (const [id, flow] of flows) if (flow.expiresAt < now()) flows.delete(id); };

  async function saveAccount(tokens: ClaudeTokens) {
    const cipher = options.cipher();
    if (!cipher) throw new ClaudeOAuthError("credential_key_missing", "The Space Gateway encryption key is missing. Redeploy Space to create it.");
    const profile = await fetchClaudeProfile(tokens.accessToken, options.fetchImpl).catch(() => null);
    const accountUuid = profile?.accountUuid ?? tokens.accountUuid;
    if (!accountUuid) throw new ClaudeOAuthError("invalid_identity", "The Claude sign-in did not include an account id.");
    const externalAccountId = tokens.organizationUuid ? `${tokens.organizationUuid}:${accountUuid}` : accountUuid;
    const email = profile?.email ?? tokens.email;
    const credentials = claudeCredentialsFromTokens({ ...tokens, accountUuid });
    const existing = (await options.repository.listAccounts()).find((account) => account.provider === "CLAUDE" && account.externalAccountId === externalAccountId);
    const boundId = existing?.id ?? `gw_account:${randomBytes(16).toString("hex")}`;
    const saved = await options.repository.upsertAccount({
      accountId: boundId, provider: "CLAUDE", label: email ?? tokens.organizationName ?? "Claude account", email, externalAccountId,
      planType: profile?.planType ?? null, credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), boundId),
      credentialsExpiresAt: credentials.accessExpiresAtMs ? new Date(credentials.accessExpiresAtMs).toISOString() : null,
      source: "OAUTH", sourceRef: null, lastRefreshAt: new Date(now()).toISOString()
    });
    options.pool.signedIn(saved.id);
    await fetchClaudeUsage(credentials.accessToken, options.fetchImpl).then((usage) => storeClaudeUsage(options.repository, saved, usage)).catch(() => undefined);
    options.pool.invalidate();
    // Read back through the pool, which pauses a free-plan account before anyone sees it active.
    return (await options.pool.accounts()).find((account) => account.id === saved.id) ?? saved;
  }

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ClaudeOAuthError) {
      const upstreamFault = error.code === "transport_error" || (error.statusCode !== null && error.statusCode >= 500);
      return reply.code(upstreamFault ? 502 : 422).send({ error: { code: error.code, message: error.message } });
    }
    throw error;
  };

  app.post("/__space-gateway/admin/claude/browser", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    prune();
    const pkce = generateClaudePkce();
    const flowId = randomBytes(16).toString("hex");
    flows.set(flowId, { verifier: pkce.verifier, state: pkce.state, expiresAt: now() + FLOW_TTL_MS });
    return { flowId, authorizationUrl: buildClaudeAuthorizationUrl({ challenge: pkce.challenge, state: pkce.state }) };
  });

  app.post("/__space-gateway/admin/claude/browser/:flowId/complete", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const flowId = (request.params as { flowId: string }).flowId;
    const flow = flows.get(flowId);
    if (!flow || flow.expiresAt < now()) {
      return reply.code(422).send({ error: { code: "flow_expired", message: "This sign-in expired. Start again." } });
    }
    try {
      const pasted = parseClaudeAuthorizationCode(String((request.body as { code?: unknown } | null)?.code ?? ""));
      if (pasted.state !== null && pasted.state !== flow.state) {
        throw new ClaudeOAuthError("state_mismatch", "This code belongs to a different sign-in. Start again.");
      }
      const tokens = await exchangeClaudeCode({ code: pasted.code, state: flow.state, verifier: flow.verifier, fetchImpl: options.fetchImpl });
      flows.delete(flowId);
      return { status: "CONNECTED", account: publicAccountSummary(await saveAccount(tokens)) };
    } catch (error) { return fail(reply, error); }
  });
}

/** Account test (a token check that spends no usage) and usage refresh for Claude accounts. */
export function claudeAccountActions(options: { repository: GatewayRepository; pool: AccountPool; fetchImpl?: typeof fetch; now?: () => number;
  upstreamBaseUrl?: string }): ProviderAccountActions {
  const now = options.now ?? Date.now;
  return {
    async test(account) {
      const startedAt = now();
      const credentials = await options.pool.credentials(account);
      if (isClaudeApiKeyAccount(account)) {
        // The free model list: a working key answers 200, a revoked one 401, exhausted credits still 200.
        const check = await checkClaudeApiKey(credentials.accessToken, options.fetchImpl, options.upstreamBaseUrl);
        if (check.ok) await options.pool.markSuccess(account.id);
        return { ok: check.ok, model: null, status: check.status || 502, latencyMs: now() - startedAt,
          error: check.ok ? null : check.status === 0 ? "Anthropic could not be reached." : `Anthropic answered HTTP ${check.status}`, planType: account.planType };
      }
      try {
        const profile = await fetchClaudeProfile(credentials.accessToken, options.fetchImpl);
        await options.pool.markSuccess(account.id);
        return { ok: true, model: null, status: 200, latencyMs: now() - startedAt, error: null, planType: profile.planType };
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode;
        return { ok: false, model: null, status: typeof status === "number" ? status : 502, latencyMs: now() - startedAt,
          error: error instanceof Error ? error.message : "The account check failed." };
      }
    },
    async refreshUsage(account) {
      if (isClaudeApiKeyAccount(account)) return; // An API key has no plan usage windows.
      await refreshClaudeAccountUsage({ repository: options.repository, pool: options.pool, account, fetchImpl: options.fetchImpl });
    }
  };
}
