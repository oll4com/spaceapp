import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type AntigravityUsageAccountList, antigravityUsageAccountListSchema, type ApiProviderAccountList,
  apiProviderAccountListSchema, type ClaudeUsageAccountList, claudeUsageAccountListSchema, type CliSessionStats,
  cliSessionStatsSchema, type CodexLbSpeedDefaultsResponse, codexLbSpeedDefaultsResponseSchema,
  codexLbSpeedDefaultUpdateRequestSchema, type CodexLbSpeedTier, codexResetCreditAvailabilitySchema,
  codexResetCreditRedemptionInputSchema, codexResetCreditRedemptionResponseSchema, type CodexUsageAccountList,
  codexUsageAccountListSchema, type HostMemoryDetails, hostMemoryDetailsSchema,
  providerSwitchRequestSchema, providerSwitchTargetsSchema,
  toolbarModelStatsSchema
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { CodexLbSpeedModelId } from "./codex-lb-speed-defaults.js";
import type { CodexResetCreditsService } from "./codex-reset-credits.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";
import type { ToolbarModelStatsCollector } from "./toolbar-model-stats.js";

const codexLbSpeedModelParamsSchema = z
  .object({ modelId: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) })
  .strict();

/**
 * ADMIN toolbar: usage accounts, Codex reset credits, CLI session stats, host memory, model stats, provider switch
 * targets and Codex-LB speed defaults. The CLI reap and memory reclaim routes share their in-flight flag with the
 * maintenance autopilot and stay in the composition root, which also retains authentication, CSRF, errors and rate
 * limits.
 */
export function registerAdminToolbarRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  antigravityUsageProvider: () => Promise<AntigravityUsageAccountList>;
  claudeUsageProvider: () => Promise<ClaudeUsageAccountList>;
  apiProviderAccountsProvider: () => Promise<ApiProviderAccountList>;
  toolbarUsageProvider: () => Promise<CodexUsageAccountList>;
  codexResetCreditsService: CodexResetCreditsService;
  toolbarCliSessionStatsProvider: () => Promise<CliSessionStats>;
  toolbarHostMemoryProvider: () => Promise<HostMemoryDetails>;
  toolbarModelStatsCollector: ToolbarModelStatsCollector;
  codexLbSpeedDefaultsProvider: () => Promise<CodexLbSpeedDefaultsResponse>;
  codexLbSpeedDefaultUpdater: (modelId: CodexLbSpeedModelId, tier: CodexLbSpeedTier) => Promise<CodexLbSpeedDefaultsResponse>;
}) {
  const { store, cliRuntimeVisibility, antigravityUsageProvider, claudeUsageProvider, apiProviderAccountsProvider,
    toolbarUsageProvider, codexResetCreditsService, toolbarCliSessionStatsProvider, toolbarHostMemoryProvider,
    toolbarModelStatsCollector, codexLbSpeedDefaultsProvider, codexLbSpeedDefaultUpdater } = options;
  const codexResetRedemptionAttempts = new Map<string, number[]>();
  function consumeCodexResetRedemptionLimit(actorId: string): boolean {
    const current = Date.now();
    const cutoff = current - 5 * 60 * 1000;
    const recent = (codexResetRedemptionAttempts.get(actorId) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= 12) {
      codexResetRedemptionAttempts.set(actorId, recent);
      return false;
    }
    recent.push(current);
    codexResetRedemptionAttempts.set(actorId, recent);
    return true;
  }
  let codexLbSpeedUpdateQueue: Promise<void> = Promise.resolve();
  function serializeCodexLbSpeedUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = codexLbSpeedUpdateQueue.then(operation, operation);
    codexLbSpeedUpdateQueue = result.then(() => undefined, () => undefined);
    return result;
  }
  app.get(
    "/api/admin/antigravity-usage-accounts",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Toolbar system telemetry requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:gemini");
      return antigravityUsageAccountListSchema.parse(await antigravityUsageProvider());
    }
  );
  app.get(
    "/api/admin/claude-usage-accounts",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Toolbar system telemetry requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:claude");
      return claudeUsageAccountListSchema.parse(await claudeUsageProvider());
    }
  );
  app.get(
    "/api/admin/api-provider-accounts",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Toolbar system telemetry requires the ADMIN role.");
      }
      return apiProviderAccountListSchema.parse(await apiProviderAccountsProvider());
    }
  );
  app.get(
    "/api/admin/codex-usage-accounts",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Toolbar system telemetry requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      return codexUsageAccountListSchema.parse(await toolbarUsageProvider());
    }
  );
  app.get(
    "/api/admin/codex-reset-credits",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Codex reset credit telemetry requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      return codexResetCreditAvailabilitySchema.parse(await codexResetCreditsService.availability());
    }
  );
  app.post(
    "/api/admin/codex-reset-credits/:accountId/redemptions",
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Codex reset credit redemption requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const { accountId } = z.object({ accountId: z.string().min(1).max(160) }).strict().parse(request.params);
      const { idempotencyKey } = parseBody(codexResetCreditRedemptionInputSchema, request.body ?? {});
      if (!consumeCodexResetRedemptionLimit(request.user.id)) {
        reply.header("retry-after", "300");
        return sendApiError(reply, 429, "RATE_LIMITED", "Too many Codex reset redemption attempts.");
      }
      const result = await codexResetCreditsService.redeem(accountId, idempotencyKey);
      await recordAudit(store, request, {
        action: "admin.codex_reset_credit.redeemed",
        targetType: "codex_reset_credit",
        targetId: accountId,
        metadata: result.audit
      });
      return codexResetCreditRedemptionResponseSchema.parse(result.response);
    }
  );
  app.get(
    "/api/admin/cli-sessions",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Toolbar system telemetry requires the ADMIN role.");
      }
      return cliSessionStatsSchema.parse(await toolbarCliSessionStatsProvider());
    }
  );
  app.get(
    "/api/admin/host-memory",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Toolbar system telemetry requires the ADMIN role.");
      }
      return hostMemoryDetailsSchema.parse(await toolbarHostMemoryProvider());
    }
  );
  app.get(
    "/api/admin/toolbar-model-stats",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Toolbar model telemetry requires the ADMIN role.");
      }
      const input = z.object({
        roomId: z.string().min(1).max(200).optional(),
        windowMinutes: z.coerce.number().int().min(1).max(1440).default(10)
      }).strict().parse(request.query);
      return toolbarModelStatsSchema.parse(await toolbarModelStatsCollector({
        roomId: input.roomId ?? "global",
        windowMinutes: input.windowMinutes
      }));
    }
  );
  app.get(
    "/api/admin/provider-switch-targets",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Provider route telemetry requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      // Codex runs through Space Gateway; the codex-lb route it used to switch is retired.
      return providerSwitchTargetsSchema.parse({ data: [], pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 }, checkedAt: new Date().toISOString() });
    }
  );
  app.get(
    "/api/admin/codex-lb-speed-defaults",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Codex speed telemetry requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      return codexLbSpeedDefaultsResponseSchema.parse(await codexLbSpeedDefaultsProvider());
    }
  );
  app.patch(
    "/api/admin/codex-lb-speed-defaults/:modelId",
    { config: { rateLimit: { max: 6, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Codex speed updates require the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const { modelId } = codexLbSpeedModelParamsSchema.parse(request.params);
      const { tier } = parseBody(codexLbSpeedDefaultUpdateRequestSchema, request.body ?? {});
      return serializeCodexLbSpeedUpdate(async () => {
        const before = codexLbSpeedDefaultsResponseSchema.parse(await codexLbSpeedDefaultsProvider());
        const beforeModel = before.models.find((model) => model.modelId === modelId);
        if (!beforeModel) {
          throw new SpaceConflictError("The selected model is not advertised by the current Codex catalog.");
        }
        const previousTier = beforeModel.tier;
        const result = codexLbSpeedDefaultsResponseSchema.parse(await codexLbSpeedDefaultUpdater(modelId, tier));
        if (result.models.find((model) => model.modelId === modelId)?.tier !== tier) {
          throw new SpaceConflictError("Codex speed update could not be confirmed.");
        }
        try {
          await recordAudit(store, request, {
            action: "admin.codex_lb_speed_default.updated",
            targetType: "codex_lb_speed_default",
            targetId: modelId,
            metadata: { modelId, tier }
          });
        } catch (auditError) {
          try {
            const restored = codexLbSpeedDefaultsResponseSchema.parse(
              await codexLbSpeedDefaultUpdater(modelId, previousTier)
            );
            if (restored.models.find((model) => model.modelId === modelId)?.tier !== previousTier) {
              throw new Error("Codex speed rollback was not confirmed.");
            }
          } catch (rollbackError) {
            request.log.error(
              { auditError, rollbackError, requestId: request.requestIdForSpace },
              "Codex speed update audit and rollback failed"
            );
            throw new SpaceConflictError("Codex speed update audit failed and recovery is required.");
          }
          throw new SpaceConflictError("Codex speed update audit failed; the previous default was restored.");
        }
        return result;
      });
    }
  );
}

/**
 * ADMIN global provider switch. It flipped the codex-lb route (primary, fallback, Headroom); codex-lb is retired and
 * Codex runs through Space Gateway, so a switch is always refused. Kept so older clients get a clear answer.
 */
export function registerProviderSwitchRoutes(app: FastifyInstance, options: {
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
}) {
  app.post(
    "/api/admin/provider-switches",
    { config: { rateLimit: { max: 6, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Provider route switching requires the ADMIN role.");
      }
      await options.cliRuntimeVisibility.assertEnabled("cli:codex");
      parseBody(providerSwitchRequestSchema, request.body ?? {});
      throw new SpaceConflictError("Codex runs through Space Gateway; routing and compression are set in Space Gateway.");
    }
  );
}
