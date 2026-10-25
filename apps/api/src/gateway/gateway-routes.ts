import type {} from "../request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  gatewayAccountUpdateRequestSchema, gatewayAnthropicAdminKeySaveRequestSchema, gatewayApiKeyCreateRequestSchema, gatewayApiKeyUpdateRequestSchema, gatewayDashboardRangeSchema, gatewayHistorySeriesSchema,
  gatewayLogStatusCategorySchema, gatewayProviderSchema, gatewayRequestLogFilterSchema, gatewaySettingsUpdateRequestSchema, type GatewayRequestLogFilter
} from "@space/contracts";
import type { AuditRecorder } from "../request-audit.js";
import { sendApiError } from "../http-errors.js";
import {
  GatewayAccountFreePlanError, GatewayAccountNotFoundError, GatewayKeyPolicyError, GatewaySettingsError, type GatewayAdminService
} from "./gateway-service.js";

const accountIdSchema = z.string().regex(/^gw_account:[a-f0-9]{32}$/);
const keyIdSchema = z.string().regex(/^gw_key:[a-f0-9]{32}$/);
const accountParamsSchema = z.object({ accountId: accountIdSchema }).strict();
const keyParamsSchema = z.object({ keyId: keyIdSchema }).strict();
const isoQuery = z.string().max(40).refine((value) => Number.isFinite(Date.parse(value)), "Expected a date and time.");
/** A query parameter given once or repeated. */
const many = <T extends z.ZodTypeAny>(item: T, max: number) => z.union([item, z.array(item).max(max)])
  .transform((value) => (Array.isArray(value) ? value : [value]) as z.output<T>[]).optional();
const logFilterQuery = {
  q: z.string().trim().min(1).max(200).optional(),
  from: isoQuery.optional(),
  to: isoQuery.optional(),
  account: many(accountIdSchema, 100),
  key: many(keyIdSchema, 100),
  model: many(z.string().min(1).max(160), 100),
  provider: many(gatewayProviderSchema, 20),
  status: many(gatewayLogStatusCategorySchema, 5),
  client: many(z.string().min(1).max(80), 50)
};
const logsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d{1,19}$/).optional(),
  accountId: accountIdSchema.optional(),
  apiKeyId: keyIdSchema.optional(),
  ...logFilterQuery
}).strict();
const logFilterQuerySchema = z.object(logFilterQuery).strict();

function toFilter(query: z.output<typeof logFilterQuerySchema>): GatewayRequestLogFilter {
  return gatewayRequestLogFilterSchema.parse({
    ...(query.q ? { q: query.q } : {}),
    ...(query.from ? { from: new Date(query.from).toISOString() } : {}),
    ...(query.to ? { to: new Date(query.to).toISOString() } : {}),
    ...(query.account?.length ? { accountIds: query.account } : {}),
    ...(query.key?.length ? { apiKeyIds: query.key } : {}),
    ...(query.model?.length ? { models: query.model } : {}),
    ...(query.provider?.length ? { providers: query.provider } : {}),
    ...(query.status?.length ? { statuses: query.status } : {}),
    ...(query.client?.length ? { clients: query.client } : {})
  });
}

/** Space Gateway administration. Administrators only; every change is audited. */
export function registerGatewayAdminRoutes(app: FastifyInstance, options: {
  service: GatewayAdminService;
  recordAudit: AuditRecorder;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { service, recordAudit, routeOptions } = options;
  const writeOptions = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.user?.role === "ADMIN") return true;
    void sendApiError(reply, 403, "ADMIN_REQUIRED", "Administrator permissions are required.");
    return false;
  };

  app.get("/api/admin/gateway/status", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.status();
  });

  app.get("/api/admin/gateway/accounts", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.listAccounts();
  });

  app.get("/api/admin/gateway/claude-api-key", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.claudeApiKeyUse();
  });

  // The operator's Anthropic Admin API key (operator request 2026-10-18): the gateway checks and seals it; answers and the
  // audit carry its hint only.
  app.get("/api/admin/gateway/anthropic-admin", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.anthropicAdminStatus();
  });

  app.put("/api/admin/gateway/anthropic-admin", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { adminKey } = gatewayAnthropicAdminKeySaveRequestSchema.parse(request.body);
    const result = await service.gatewayAdmin("/__space-gateway/admin/anthropic-admin/save", { adminKey });
    if (result.status === 200) await recordAudit(request, { action: "admin.gateway.anthropic-admin.save", targetType: "gateway_settings", targetId: "anthropic-admin",
      metadata: { keyHint: `…${adminKey.slice(-4)}` } });
    return relay(reply, result);
  });

  app.delete("/api/admin/gateway/anthropic-admin", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const result = await service.gatewayAdmin("/__space-gateway/admin/anthropic-admin/remove");
    if (result.status === 200) await recordAudit(request, { action: "admin.gateway.anthropic-admin.remove", targetType: "gateway_settings", targetId: "anthropic-admin" });
    return relay(reply, result);
  });

  app.post("/api/admin/gateway/anthropic-admin/sync", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return relay(reply, await service.gatewayAdmin("/__space-gateway/admin/anthropic-admin/sync"));
  });

  app.get("/api/admin/gateway/anthropic-billing", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(31).default(14) }).strict().parse(request.query);
    return service.anthropicBilling(days);
  });

  app.get("/api/admin/gateway/dashboard", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { range } = z.object({ range: gatewayDashboardRangeSchema.default("24h") }).strict().parse(request.query);
    return service.dashboard(range);
  });

  app.get("/api/admin/gateway/health", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.health();
  });

  app.get("/api/admin/gateway/accounts/:accountId", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { accountId } = accountParamsSchema.parse(request.params);
    const detail = await service.accountDetail(accountId);
    return detail ?? sendApiError(reply, 404, "GATEWAY_ACCOUNT_NOT_FOUND", "Account not found.");
  });

  app.patch("/api/admin/gateway/accounts/:accountId", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { accountId } = accountParamsSchema.parse(request.params);
    const patch = gatewayAccountUpdateRequestSchema.parse(request.body);
    let account;
    try {
      account = await service.updateAccount(accountId, patch);
    } catch (error) {
      if (error instanceof GatewayAccountFreePlanError) return sendApiError(reply, 409, "GATEWAY_ACCOUNT_FREE_PLAN", error.message);
      throw error;
    }
    if (!account) return sendApiError(reply, 404, "GATEWAY_ACCOUNT_NOT_FOUND", "Account not found.");
    if (patch.paused !== undefined) {
      await recordAudit(request, { action: patch.paused ? "admin.gateway.account.pause" : "admin.gateway.account.resume", targetType: "gateway_account", targetId: accountId });
    }
    if (patch.alias !== undefined || patch.warmupEnabled !== undefined) {
      await recordAudit(request, { action: "admin.gateway.account.update", targetType: "gateway_account", targetId: accountId,
        metadata: { ...(patch.alias !== undefined ? { alias: patch.alias } : {}), ...(patch.warmupEnabled !== undefined ? { warmupEnabled: patch.warmupEnabled } : {}) } });
    }
    return account;
  });

  /** Hands out the account's Codex sign-in as auth.json. The operator confirms first; every export is audited. */
  app.post("/api/admin/gateway/accounts/:accountId/export", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { accountId } = accountParamsSchema.parse(request.params);
    z.object({ confirm: z.literal(true) }).strict().parse(request.body);
    const result = await service.gatewayAdmin(`/__space-gateway/admin/accounts/${accountId}/export`);
    await recordAudit(request, { action: "admin.gateway.account.export", targetType: "gateway_account", targetId: accountId, metadata: { status: result.status } });
    return relay(reply, result);
  });

  const flowParamsSchema = z.object({ flowId: z.string().regex(/^[a-f0-9]{32}$/) }).strict();
  const signInLimits = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
  const relay = async (reply: FastifyReply, result: { status: number; body: unknown }) => reply.code(result.status).header("cache-control", "no-store").send(result.body);
  const connected = (body: unknown): { id?: string; provider?: string } | null => {
    const record = body as { status?: unknown; account?: { id?: string; provider?: string } } | null;
    return record?.status === "CONNECTED" && record.account ? record.account : null;
  };

  app.post("/api/admin/gateway/codex/device", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return relay(reply, await service.gatewayAdmin("/__space-gateway/admin/codex/device"));
  });

  app.post("/api/admin/gateway/codex/device/:flowId/poll", signInLimits, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { flowId } = flowParamsSchema.parse(request.params);
    const result = await service.gatewayAdmin(`/__space-gateway/admin/codex/device/${flowId}/poll`);
    const account = connected(result.body);
    if (account) await recordAudit(request, { action: "admin.gateway.account.add", targetType: "gateway_account", targetId: account.id ?? null, metadata: { provider: "CODEX", method: "device_code" } });
    return relay(reply, result);
  });

  app.post("/api/admin/gateway/codex/browser", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return relay(reply, await service.gatewayAdmin("/__space-gateway/admin/codex/browser"));
  });

  app.post("/api/admin/gateway/codex/browser/:flowId/complete", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { flowId } = flowParamsSchema.parse(request.params);
    const { callbackUrl } = z.object({ callbackUrl: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
    const result = await service.gatewayAdmin(`/__space-gateway/admin/codex/browser/${flowId}/complete`, { callbackUrl });
    const account = connected(result.body);
    if (account) await recordAudit(request, { action: "admin.gateway.account.add", targetType: "gateway_account", targetId: account.id ?? null, metadata: { provider: "CODEX", method: "browser" } });
    return relay(reply, result);
  });

  app.post("/api/admin/gateway/claude/browser", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return relay(reply, await service.gatewayAdmin("/__space-gateway/admin/claude/browser"));
  });

  app.post("/api/admin/gateway/claude/browser/:flowId/complete", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { flowId } = flowParamsSchema.parse(request.params);
    const { code } = z.object({ code: z.string().trim().min(1).max(4000) }).strict().parse(request.body);
    const result = await service.gatewayAdmin(`/__space-gateway/admin/claude/browser/${flowId}/complete`, { code });
    const account = connected(result.body);
    if (account) await recordAudit(request, { action: "admin.gateway.account.add", targetType: "gateway_account", targetId: account.id ?? null, metadata: { provider: "CLAUDE", method: "browser" } });
    return relay(reply, result);
  });

  app.get("/api/admin/gateway/antigravity/profiles", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.antigravityProfiles();
  });

  app.post("/api/admin/gateway/antigravity/import", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { profileId } = z.object({ profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/) }).strict().parse(request.body);
    const result = await service.importAntigravityProfile(profileId);
    const account = connected(result.body);
    if (account) await recordAudit(request, { action: "admin.gateway.account.add", targetType: "gateway_account", targetId: account.id ?? null, metadata: { provider: "ANTIGRAVITY", method: "profile" } });
    return relay(reply, result);
  });

  app.post("/api/admin/gateway/api-key/add", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const input = z.object({
      provider: z.enum(["OPENAI_API", "OPENROUTER", "DEEPSEEK", "CLAUDE", "GOOGLE_AI"]),
      apiKey: z.string().trim().min(20).max(400).optional(),
      useSpaceKey: z.boolean().optional(),
      label: z.string().trim().min(1).max(80).optional()
    }).strict().refine((value) => Boolean(value.apiKey) !== Boolean(value.useSpaceKey), "Give an API key or choose the Space key.")
      .refine((value) => !value.useSpaceKey || value.provider === "OPENAI_API" || value.provider === "CLAUDE", "Only the OpenAI and Claude keys exist on this server.")
      .parse(request.body);
    const result = await service.addOpenAiApiKey(input);
    const account = connected(result.body);
    if (account) await recordAudit(request, { action: "admin.gateway.account.add", targetType: "gateway_account", targetId: account.id ?? null,
      metadata: { provider: input.provider, method: input.useSpaceKey ? "space-key" : "api-key" } });
    return relay(reply, result);
  });

  app.post("/api/admin/gateway/codex/import", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { authJson } = z.object({ authJson: z.string().trim().min(2).max(64_000) }).strict().parse(request.body);
    const result = await service.gatewayAdmin("/__space-gateway/admin/codex/import", { authJson });
    const account = connected(result.body);
    if (account) await recordAudit(request, { action: "admin.gateway.account.add", targetType: "gateway_account", targetId: account.id ?? null, metadata: { provider: "CODEX", method: "auth_json" } });
    return relay(reply, result);
  });

  app.post("/api/admin/gateway/accounts/:accountId/usage", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { accountId } = accountParamsSchema.parse(request.params);
    return relay(reply, await service.gatewayAdmin(`/__space-gateway/admin/accounts/${accountId}/usage`));
  });

  app.post("/api/admin/gateway/accounts/:accountId/test", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { accountId } = accountParamsSchema.parse(request.params);
    const { model } = z.object({ model: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/).optional() }).strict().parse(request.body ?? {});
    const result = await service.gatewayAdmin(`/__space-gateway/admin/accounts/${accountId}/test`, model ? { model } : {});
    await recordAudit(request, { action: "admin.gateway.account.test", targetType: "gateway_account", targetId: accountId, metadata: { model: model ?? null } });
    return relay(reply, result);
  });

  app.post("/api/admin/gateway/accounts/:accountId/reset-credit", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { accountId } = accountParamsSchema.parse(request.params);
    const { idempotencyKey } = z.object({ idempotencyKey: z.string().regex(/^[A-Za-z0-9-]{8,80}$/) }).strict().parse(request.body);
    const result = await service.gatewayAdmin(`/__space-gateway/admin/accounts/${accountId}/reset-credit`, { idempotencyKey });
    await recordAudit(request, { action: "admin.gateway.account.reset_credit", targetType: "gateway_account", targetId: accountId,
      metadata: { outcome: (result.body as { outcome?: unknown } | null)?.outcome ?? null, status: result.status } });
    return relay(reply, result);
  });

  app.delete("/api/admin/gateway/accounts/:accountId", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { accountId } = accountParamsSchema.parse(request.params);
    if (!(await service.deleteAccount(accountId))) return sendApiError(reply, 404, "GATEWAY_ACCOUNT_NOT_FOUND", "Account not found.");
    await recordAudit(request, { action: "admin.gateway.account.delete", targetType: "gateway_account", targetId: accountId });
    return { id: accountId, deleted: true };
  });

  app.get("/api/admin/gateway/keys", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.listApiKeys();
  });

  app.post("/api/admin/gateway/keys", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const input = gatewayApiKeyCreateRequestSchema.parse(request.body);
    try {
      const created = await service.createApiKey(input, request.user?.id ?? null);
      await recordAudit(request, {
        action: "admin.gateway.key.create", targetType: "gateway_api_key", targetId: created.key.id,
        metadata: { name: created.key.name, trafficClass: created.key.trafficClass, keyPrefix: created.key.keyPrefix }
      });
      return reply.code(201).header("cache-control", "no-store").send(created);
    } catch (error) {
      if (error instanceof GatewayAccountNotFoundError) return sendApiError(reply, 422, "GATEWAY_ACCOUNT_NOT_FOUND", error.message);
      throw error;
    }
  });

  app.get("/api/admin/gateway/keys/:keyId", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { keyId } = keyParamsSchema.parse(request.params);
    const detail = await service.apiKeyDetail(keyId);
    return detail ?? sendApiError(reply, 404, "GATEWAY_KEY_NOT_FOUND", "API key not found.");
  });

  app.patch("/api/admin/gateway/keys/:keyId", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { keyId } = keyParamsSchema.parse(request.params);
    const patch = gatewayApiKeyUpdateRequestSchema.parse(request.body);
    try {
      const key = await service.updateApiKey(keyId, patch);
      if (!key) return sendApiError(reply, 404, "GATEWAY_KEY_NOT_FOUND", "API key not found.");
      await recordAudit(request, { action: "admin.gateway.key.update", targetType: "gateway_api_key", targetId: keyId, metadata: { ...patch } });
      return key;
    } catch (error) {
      if (error instanceof GatewayAccountNotFoundError) return sendApiError(reply, 422, "GATEWAY_ACCOUNT_NOT_FOUND", error.message);
      if (error instanceof GatewayKeyPolicyError) return sendApiError(reply, 422, "GATEWAY_KEY_POLICY_INVALID", error.message);
      throw error;
    }
  });

  /** A new secret for the key; the plain key is shown once. The old secret stops working at once. */
  app.post("/api/admin/gateway/keys/:keyId/regenerate", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { keyId } = keyParamsSchema.parse(request.params);
    const regenerated = await service.regenerateApiKey(keyId);
    if (!regenerated) return sendApiError(reply, 404, "GATEWAY_KEY_NOT_FOUND", "API key not found.");
    await recordAudit(request, { action: "admin.gateway.key.regenerate", targetType: "gateway_api_key", targetId: keyId,
      metadata: { keyPrefix: regenerated.key.keyPrefix } });
    return reply.header("cache-control", "no-store").send(regenerated);
  });

  app.delete("/api/admin/gateway/keys/:keyId", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { keyId } = keyParamsSchema.parse(request.params);
    if (!(await service.deleteApiKey(keyId))) return sendApiError(reply, 404, "GATEWAY_KEY_NOT_FOUND", "API key not found.");
    await recordAudit(request, { action: "admin.gateway.key.delete", targetType: "gateway_api_key", targetId: keyId });
    return { id: keyId, deleted: true };
  });

  app.get("/api/admin/gateway/logs", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { limit, cursor, accountId, apiKeyId, ...filterQuery } = logsQuerySchema.parse(request.query);
    return service.listRequestLogs({ limit, cursor, accountId, apiKeyId, filter: toFilter(filterQuery) });
  });

  app.get("/api/admin/gateway/logs/facets", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { from, to } = z.object({ from: isoQuery.optional(), to: isoQuery.optional() }).strict().parse(request.query);
    return service.requestLogFacets({ from: from ? new Date(from).toISOString() : undefined, to: to ? new Date(to).toISOString() : undefined });
  });

  app.get("/api/admin/gateway/logs/export.csv", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const csv = await service.requestLogCsv(toFilter(logFilterQuerySchema.parse(request.query)));
    return reply.header("content-type", "text/csv; charset=utf-8").header("cache-control", "no-store")
      .header("content-disposition", `attachment; filename="space-gateway-requests-${new Date().toISOString().slice(0, 10)}.csv"`).send(csv);
  });

  app.get("/api/admin/gateway/logs/:logId", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { logId } = z.object({ logId: z.string().regex(/^\d{1,19}$/) }).strict().parse(request.params);
    const log = await service.requestLog(logId);
    return log ?? sendApiError(reply, 404, "GATEWAY_LOG_NOT_FOUND", "Request log not found.");
  });

  app.get("/api/admin/gateway/reports", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const { from, to } = z.object({ from: day, to: day }).strict().parse(request.query);
    if (from > to) return sendApiError(reply, 422, "INVALID_RANGE", "The start date must not be after the end date.");
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) return sendApiError(reply, 422, "INVALID_RANGE", "Reports cover at most one year.");
    return service.report(from, to);
  });

  app.get("/api/admin/gateway/compression-stats", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) }).strict().parse(request.query);
    return service.compressionStats(hours);
  });

  app.get("/api/admin/gateway/compression/session", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.headroomSession();
  });

  app.get("/api/admin/gateway/compression/lifetime", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.headroomLifetime();
  });

  app.get("/api/admin/gateway/compression/history", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.headroomHistory();
  });

  /** Headroom-style exports: the whole history as JSON, or one series as CSV. */
  app.get("/api/admin/gateway/compression/export", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { format, series } = z.object({ format: z.enum(["json", "csv"]).default("json"), series: gatewayHistorySeriesSchema.default("daily") }).strict().parse(request.query);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      return reply.header("content-type", "text/csv; charset=utf-8").header("cache-control", "no-store")
        .header("content-disposition", `attachment; filename="space-gateway-savings-${series}-${stamp}.csv"`).send(await service.headroomHistoryCsv(series));
    }
    return reply.header("cache-control", "no-store").header("content-disposition", `attachment; filename="space-gateway-savings-${stamp}.json"`)
      .send(await service.headroomHistory());
  });

  app.get("/api/admin/gateway/settings", routeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return service.getSettings();
  });

  app.patch("/api/admin/gateway/settings", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const patch = gatewaySettingsUpdateRequestSchema.parse(request.body);
    try {
      const settings = await service.updateSettings(patch);
      await recordAudit(request, { action: "admin.gateway.settings.update", targetType: "gateway_settings", targetId: "space-gateway", metadata: { ...patch } });
      return settings;
    } catch (error) {
      if (error instanceof GatewaySettingsError) return sendApiError(reply, 422, "GATEWAY_SETTINGS_INVALID", error.message);
      throw error;
    }
  });

  /** Starts a new gateway worker that reads the settings (LAN access) and takes over without dropping open streams. */
  app.post("/api/admin/gateway/reload", writeOptions, async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const result = await service.gatewayAdmin("/__space-gateway/admin/reload");
    await recordAudit(request, { action: "admin.gateway.reload", targetType: "gateway_settings", targetId: "space-gateway", metadata: { status: result.status } });
    return relay(reply, result);
  });
}
