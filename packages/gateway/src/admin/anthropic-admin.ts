import type { FastifyInstance } from "fastify";
import { gatewayAnthropicAdminKeySaveRequestSchema, type GatewayAnthropicUpstreamKey } from "@space/contracts";
import type { GatewayRepository } from "@space/db";
import type { AccountPool } from "../accounts/account-pool.js";
import {
  ANTHROPIC_ADMIN_KEY_AAD, AnthropicAdminError, anthropicAdminGet, anthropicAdminStatus, fetchAnthropicReports, listAnthropicApiKeys, matchAnthropicKey,
  reconcileAnthropicKeyLimits, shiftDay
} from "../anthropic-billing.js";
import type { CredentialCipher } from "../credential-cipher.js";
import { createAdminGuard } from "./codex-sign-in.js";

/** The reports restate recent days, so every sync reads the last 31 (the report pages' maximum). */
const syncDays = 31;

export interface AnthropicBillingSync { runOnce(): Promise<{ ok: boolean; error: string | null; limitsSet: number }>; stop(): void }

/**
 * Reads the organization's cost and usage reports with the sealed admin key every `intervalMs` (Anthropic allows one
 * poll a minute; data lands about 5 minutes after a request), matches the Claude API-key accounts' keys, stores the last
 * 31 days and lets the daily COST_USD caps count the real charge. Nothing runs without a saved key.
 */
export function startAnthropicBillingSync(options: {
  repository: GatewayRepository; cipher: () => CredentialCipher | null; claudePool: AccountPool; intervalMs: number;
  fetchImpl?: typeof fetch; now?: () => number; onError?: (code: string) => void;
}): AnthropicBillingSync {
  const now = options.now ?? Date.now;
  let running: Promise<{ ok: boolean; error: string | null; limitsSet: number }> | null = null;
  const sync = async () => {
    const record = await options.repository.getAnthropicAdmin();
    if (!record) return { ok: false, error: "not_configured", limitsSet: 0 };
    const at = new Date(now()).toISOString();
    try {
      const cipher = options.cipher();
      if (!cipher) throw new AnthropicAdminError("credential_key_missing", 0);
      let adminKey: string;
      try {
        adminKey = cipher.decrypt(record.keyEncrypted, ANTHROPIC_ADMIN_KEY_AAD);
      } catch {
        throw new AnthropicAdminError("admin_key_unreadable", 0);
      }
      const apiKeys = await listAnthropicApiKeys(adminKey, options.fetchImpl);
      const upstream: GatewayAnthropicUpstreamKey[] = [];
      for (const account of await options.repository.listAccounts()) {
        if (account.provider !== "CLAUDE" || account.source !== "API_KEY") continue;
        const match = matchAnthropicKey((await options.claudePool.credentials(account)).accessToken, apiKeys);
        if (match) upstream.push({ accountId: account.id, apiKeyId: match.id, keyName: match.name, workspaceId: match.workspaceId });
      }
      // The window ends a day after tomorrow, so today's bucket (ending at midnight) ends before it.
      const fromDay = shiftDay(at.slice(0, 10), 1 - syncDays);
      const toDay = shiftDay(at.slice(0, 10), 2);
      const rows = await fetchAnthropicReports(adminKey, { fromDay, toDay }, options.fetchImpl);
      await options.repository.replaceAnthropicUsage(fromDay, rows);
      const limitsSet = await reconcileAnthropicKeyLimits(options.repository, { upstream, rows, now: now() });
      const error = upstream.length ? null : "no_matching_api_key";
      await options.repository.recordAnthropicSync({ at, error, upstream });
      return { ok: true, error, limitsSet };
    } catch (error) {
      const code = error instanceof AnthropicAdminError ? error.code : "sync_failed";
      await options.repository.recordAnthropicSync({ at, error: code }).catch(() => undefined);
      options.onError?.(code);
      return { ok: false, error: code, limitsSet: 0 };
    }
  };
  const runOnce = () => (running ??= sync().finally(() => { running = null; }));
  const timer = setInterval(() => { void runOnce(); }, options.intervalMs);
  timer.unref();
  return { runOnce, stop: () => clearInterval(timer) };
}

/**
 * The operator's Anthropic Admin API key: checked with one Admin API read, sealed with the gateway's credential key and
 * never returned. Answers carry the hint and sync state only.
 */
export function registerAnthropicAdminRoutes(app: FastifyInstance, options: {
  repository: GatewayRepository; cipher: () => CredentialCipher | null; internalToken: string | null; sync: () => AnthropicBillingSync | null;
  fetchImpl?: typeof fetch; now?: () => number;
}) {
  const guard = createAdminGuard(options.internalToken);
  const now = options.now ?? Date.now;
  app.post("/__space-gateway/admin/anthropic-admin/save", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const parsed = gatewayAnthropicAdminKeySaveRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(422).send({ error: { code: "invalid_admin_key", message: "This does not look like an Anthropic Admin API key (sk-ant-admin01-...)." } });
    const cipher = options.cipher();
    if (!cipher) return reply.code(503).send({ error: { code: "credential_key_missing", message: "The Space Gateway encryption key is missing. Redeploy Space to create it." } });
    const adminKey = parsed.data.adminKey;
    try {
      await anthropicAdminGet(adminKey, "/v1/organizations/api_keys?limit=1", options.fetchImpl);
    } catch (error) {
      const status = error instanceof AnthropicAdminError ? error.status : 0;
      return reply.code(status === 0 || status >= 500 ? 502 : 422).send({ error: { code: "admin_key_rejected",
        message: status === 0 || status >= 500 ? "Anthropic could not be reached." : `Anthropic rejected the key (HTTP ${status}).` } });
    }
    await options.repository.saveAnthropicAdminKey({ keyEncrypted: cipher.encrypt(adminKey, ANTHROPIC_ADMIN_KEY_AAD), keyHint: `…${adminKey.slice(-4)}`,
      at: new Date(now()).toISOString() });
    await options.sync()?.runOnce();
    return anthropicAdminStatus(await options.repository.getAnthropicAdmin());
  });
  app.post("/__space-gateway/admin/anthropic-admin/remove", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    return { removed: await options.repository.deleteAnthropicAdminKey() };
  });
  app.post("/__space-gateway/admin/anthropic-admin/sync", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const sync = options.sync();
    if (sync) await sync.runOnce();
    return anthropicAdminStatus(await options.repository.getAnthropicAdmin());
  });
}
