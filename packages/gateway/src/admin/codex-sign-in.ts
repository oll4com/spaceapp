import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayProvider } from "@space/contracts";
import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { AccountPool } from "../accounts/account-pool.js";
import type { CredentialCipher } from "../credential-cipher.js";
import { codexCredentialsFromTokens } from "../providers/codex/credentials.js";
import {
  buildAuthorizationUrl, CodexOAuthError, exchangeAuthorizationCode, exchangeDeviceToken, extractCodexClaims, generatePkcePair,
  parseAuthorizationCallback, parseCodexAuthJson, requestDeviceCode, type CodexTokens
} from "../providers/codex/oauth.js";
import { buildCodexUpstreamHeaders } from "../providers/codex/headers.js";
import { ResponseStreamInspector } from "../providers/codex/stream.js";
import { CODEX_UPSTREAM_BASE_URL, consumeResetCredit, fetchCodexUsage } from "../providers/codex/usage.js";
import { refreshCodexAccountUsage, storeCodexUsage } from "../providers/codex/usage-refresh.js";

/**
 * Codex account sign-in, served to the Space API only (loopback + the Space internal token). Tokens are
 * encrypted here and never leave the gateway; the API receives the account summary.
 */
const FLOW_TTL_MS = 15 * 60_000;

interface DeviceFlow { kind: "device"; deviceAuthId: string; userCode: string; expiresAt: number }
interface BrowserFlow { kind: "browser"; verifier: string; state: string; expiresAt: number }

/** Test and usage refresh for accounts of other providers, served on the same account routes. */
export interface ProviderAccountActions {
  test(account: GatewayAccountRecord, body: unknown): Promise<Record<string, unknown>>;
  refreshUsage(account: GatewayAccountRecord): Promise<void>;
}

export interface CodexSignInOptions {
  repository: GatewayRepository;
  pool: AccountPool;
  cipher: () => CredentialCipher | null;
  internalToken: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  otherProviders?: Partial<Record<GatewayProvider, ProviderAccountActions>>;
}

function sameToken(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Admin routes answer only the Space API: loopback callers presenting the Space internal token. */
export function createAdminGuard(internalToken: string | null) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const header = request.headers["x-space-internal-token"];
    if (!isLoopback(request.socket.remoteAddress) || !sameToken(Array.isArray(header) ? header[0] ?? null : header ?? null, internalToken)) {
      await reply.code(403).send({ error: { code: "forbidden", message: "Space Gateway administration is only available to the Space API." } });
      return false;
    }
    return true;
  };
}

export function publicAccountSummary(account: GatewayAccountRecord) {
  return { id: account.id, provider: account.provider, label: account.label, email: account.email, planType: account.planType, status: account.status };
}

export function registerCodexSignInRoutes(app: FastifyInstance, options: CodexSignInOptions) {
  const now = options.now ?? Date.now;
  const flows = new Map<string, DeviceFlow | BrowserFlow>();
  const prune = () => { for (const [id, flow] of flows) if (flow.expiresAt < now()) flows.delete(id); };

  const guard = createAdminGuard(options.internalToken);

  async function saveAccount(tokens: CodexTokens, source: "OAUTH" | "IMPORT_AUTH_JSON", accountIdHint: string | null, lastRefreshAt: string | null) {
    const cipher = options.cipher();
    if (!cipher) throw new CodexOAuthError("credential_key_missing", "The Space Gateway encryption key is missing. Redeploy Space to create it.");
    const claims = extractCodexClaims(tokens.idToken, accountIdHint);
    if (!claims.accountId) throw new CodexOAuthError("invalid_identity", "The ChatGPT sign-in did not include an account id.");
    const accountId = `gw_account:${randomBytes(16).toString("hex")}`;
    const externalAccountId = claims.chatgptUserId ? `${claims.accountId}:${claims.chatgptUserId}` : claims.accountId;
    const credentials = codexCredentialsFromTokens(tokens, claims);
    // On a re-sign-in the row keeps its id, so the envelope is bound to whichever id the upsert keeps.
    const codexAccounts = (await options.repository.listAccounts()).filter((account) => account.provider === "CODEX");
    const existing = codexAccounts.find((account) => account.externalAccountId === externalAccountId);
    // Import with overwrite (codex-lb "import without overwrite" off): a single account with the same email takes this sign-in.
    const sameEmail = !existing && source === "IMPORT_AUTH_JSON" && claims.email && !(await options.repository.getSettings()).importWithoutOverwrite
      ? codexAccounts.filter((account) => account.email?.toLowerCase() === claims.email!.toLowerCase()) : [];
    if (sameEmail.length > 1) throw new CodexOAuthError("import_conflict", "More than one account has this email. Remove one before importing.");
    if (sameEmail.length === 1) {
      const target = sameEmail[0]!;
      const replaced = await options.repository.replaceAccountSignIn(target.id, {
        email: claims.email, externalAccountId, planType: claims.planType, credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), target.id),
        credentialsExpiresAt: credentials.accessExpiresAtMs ? new Date(credentials.accessExpiresAtMs).toISOString() : null, source, sourceRef: null,
        lastRefreshAt: lastRefreshAt ?? new Date(now()).toISOString()
      });
      options.pool.signedIn(target.id);
      // Read back through the pool, which pauses a free-plan account before anyone sees it active.
      if (replaced) return (await options.pool.accounts()).find((account) => account.id === replaced.id) ?? replaced;
    }
    const boundId = existing?.id ?? accountId;
    const saved = await options.repository.upsertAccount({
      accountId: boundId, provider: "CODEX", label: claims.email ?? claims.workspaceLabel ?? "ChatGPT account", email: claims.email,
      externalAccountId, planType: claims.planType, credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), boundId),
      credentialsExpiresAt: credentials.accessExpiresAtMs ? new Date(credentials.accessExpiresAtMs).toISOString() : null,
      source, sourceRef: null, lastRefreshAt: lastRefreshAt ?? new Date(now()).toISOString()
    });
    options.pool.signedIn(saved.id);
    await fetchCodexUsage({ accessToken: credentials.accessToken, accountId: credentials.upstreamAccountId, fetchImpl: options.fetchImpl, maxRetries: 1 })
      .then((usage) => storeCodexUsage(options.repository, saved, usage)).catch(() => undefined);
    options.pool.invalidate();
    return (await options.pool.accounts()).find((account) => account.id === saved.id) ?? saved;
  }

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof CodexOAuthError) {
      const upstreamFault = error.code === "transport_error" || (error.statusCode !== null && error.statusCode >= 500);
      return reply.code(upstreamFault ? 502 : 422).send({ error: { code: error.code, message: error.message } });
    }
    throw error;
  };

  app.post("/__space-gateway/admin/codex/device", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    prune();
    try {
      const device = await requestDeviceCode({ fetchImpl: options.fetchImpl });
      const flowId = randomBytes(16).toString("hex");
      flows.set(flowId, { kind: "device", deviceAuthId: device.deviceAuthId, userCode: device.userCode, expiresAt: now() + Math.min(device.expiresInSeconds * 1000, FLOW_TTL_MS) });
      return { flowId, verificationUrl: device.verificationUrl, userCode: device.userCode, intervalSeconds: device.intervalSeconds, expiresInSeconds: device.expiresInSeconds };
    } catch (error) { return fail(reply, error); }
  });

  app.post("/__space-gateway/admin/codex/device/:flowId/poll", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const flow = flows.get((request.params as { flowId: string }).flowId);
    if (!flow || flow.kind !== "device" || flow.expiresAt < now()) return { status: "EXPIRED" };
    try {
      const tokens = await exchangeDeviceToken({ deviceAuthId: flow.deviceAuthId, userCode: flow.userCode, fetchImpl: options.fetchImpl });
      if (!tokens) return { status: "PENDING" };
      flows.delete((request.params as { flowId: string }).flowId);
      return { status: "CONNECTED", account: publicAccountSummary(await saveAccount(tokens, "OAUTH", null, null)) };
    } catch (error) { return fail(reply, error); }
  });

  app.post("/__space-gateway/admin/codex/browser", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    prune();
    const { verifier, challenge } = generatePkcePair();
    const state = randomBytes(16).toString("base64url");
    const flowId = randomBytes(16).toString("hex");
    flows.set(flowId, { kind: "browser", verifier, state, expiresAt: now() + FLOW_TTL_MS });
    return { flowId, authorizationUrl: buildAuthorizationUrl({ state, codeChallenge: challenge }) };
  });

  app.post("/__space-gateway/admin/codex/browser/:flowId/complete", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const flowId = (request.params as { flowId: string }).flowId;
    const flow = flows.get(flowId);
    if (!flow || flow.kind !== "browser" || flow.expiresAt < now()) {
      return reply.code(422).send({ error: { code: "flow_expired", message: "This sign-in expired. Start again." } });
    }
    try {
      const callback = parseAuthorizationCallback(String((request.body as { callbackUrl?: unknown } | null)?.callbackUrl ?? ""));
      if (callback.state !== flow.state) throw new CodexOAuthError("state_mismatch", "This address belongs to a different sign-in. Start again.");
      const tokens = await exchangeAuthorizationCode({ code: callback.code, codeVerifier: flow.verifier, fetchImpl: options.fetchImpl });
      flows.delete(flowId);
      return { status: "CONNECTED", account: publicAccountSummary(await saveAccount(tokens, "OAUTH", null, null)) };
    } catch (error) { return fail(reply, error); }
  });

  app.post("/__space-gateway/admin/codex/import", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    try {
      const parsed = parseCodexAuthJson(String((request.body as { authJson?: unknown } | null)?.authJson ?? ""));
      return {
        status: "CONNECTED",
        account: publicAccountSummary(await saveAccount(parsed.tokens, "IMPORT_AUTH_JSON", parsed.claims.accountId,
          parsed.lastRefreshMs ? new Date(parsed.lastRefreshMs).toISOString() : null))
      };
    } catch (error) { return fail(reply, error); }
  });

  /** Sends one tiny real request with this account (like codex-lb's limit warm-up) and reports the outcome. */
  app.post("/__space-gateway/admin/accounts/:accountId/test", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const account = (await options.repository.listAccounts()).find((item) => item.id === (request.params as { accountId: string }).accountId);
    const other = account && account.provider !== "CODEX" ? options.otherProviders?.[account.provider] : undefined;
    if (other && account) {
      try {
        return await other.test(account, request.body);
      } catch (error) {
        return reply.code(502).send({ error: { code: "account_test_failed", message: error instanceof Error ? error.message : "The test request failed." } });
      }
    }
    if (!account || account.provider !== "CODEX") return reply.code(404).send({ error: { code: "not_found", message: "Account not found." } });
    const requested = (request.body as { model?: unknown } | null)?.model;
    const model = typeof requested === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(requested) ? requested : "gpt-5.6-sol";
    const startedAt = now();
    try {
      const credentials = await options.pool.credentials(account);
      const upstream = await (options.fetchImpl ?? fetch)(`${CODEX_UPSTREAM_BASE_URL}/codex/responses`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: buildCodexUpstreamHeaders({ "user-agent": "space-gateway-account-test" }, credentials.accessToken, credentials.upstreamAccountId),
        body: JSON.stringify({
          model, instructions: "Reply with OK only.", stream: true, store: false, tools: [], parallel_tool_calls: false,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Say OK." }] }]
        })
      });
      if (!upstream.ok) {
        const text = (await upstream.text()).slice(0, 500);
        return { ok: false, model, status: upstream.status, latencyMs: now() - startedAt, error: text };
      }
      const inspector = new ResponseStreamInspector();
      const reader = upstream.body!.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; inspector.push(value); }
      const outcome = inspector.outcome;
      if (outcome.status === "success") await options.pool.markSuccess(account.id);
      return {
        ok: outcome.status === "success", model: outcome.model ?? model, status: upstream.status, latencyMs: now() - startedAt,
        usage: outcome.usage, error: outcome.status === "success" ? null : outcome.errorCode ?? outcome.status
      };
    } catch (error) {
      return reply.code(502).send({ error: { code: "account_test_failed", message: error instanceof Error ? error.message : "The test request failed." } });
    }
  });

  /** Spends one weekly reset credit for the account, then reads usage again. */
  app.post("/__space-gateway/admin/accounts/:accountId/reset-credit", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const account = (await options.repository.listAccounts()).find((item) => item.id === (request.params as { accountId: string }).accountId);
    if (!account || account.provider !== "CODEX") return reply.code(404).send({ error: { code: "not_found", message: "Account not found." } });
    const idempotencyKey = String((request.body as { idempotencyKey?: unknown } | null)?.idempotencyKey ?? "");
    if (!/^[A-Za-z0-9-]{8,80}$/.test(idempotencyKey)) return reply.code(422).send({ error: { code: "invalid_request", message: "An idempotency key is required." } });
    try {
      const credentials = await options.pool.credentials(account);
      const result = await consumeResetCredit({ accessToken: credentials.accessToken, accountId: credentials.upstreamAccountId,
        redeemRequestId: idempotencyKey, fetchImpl: options.fetchImpl });
      await refreshCodexAccountUsage({ repository: options.repository, pool: options.pool, account, fetchImpl: options.fetchImpl }).catch(() => undefined);
      if (result.code === "reset") await options.pool.markSuccess(account.id);
      return { outcome: result.code.toUpperCase(), windowsReset: result.windowsReset };
    } catch (error) {
      return reply.code(502).send({ error: { code: "reset_credit_failed", message: error instanceof Error ? error.message : "The reset credit could not be used." } });
    }
  });

  app.post("/__space-gateway/admin/accounts/:accountId/usage", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const account = (await options.repository.listAccounts()).find((item) => item.id === (request.params as { accountId: string }).accountId);
    const other = account && account.provider !== "CODEX" ? options.otherProviders?.[account.provider] : undefined;
    if (!account || (account.provider !== "CODEX" && !other)) return reply.code(404).send({ error: { code: "not_found", message: "Account not found." } });
    try {
      if (other) await other.refreshUsage(account);
      else await refreshCodexAccountUsage({ repository: options.repository, pool: options.pool, account, fetchImpl: options.fetchImpl });
      return { status: "REFRESHED" };
    } catch (error) {
      return reply.code(502).send({ error: { code: "usage_refresh_failed", message: error instanceof Error ? error.message : "Usage refresh failed." } });
    }
  });
}
