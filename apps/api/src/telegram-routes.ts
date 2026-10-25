import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import type { TelegramIntegrationManager } from "@space/runtime";
import { createTelegramPairingInputSchema, updateTelegramIntegrationInputSchema, idSchema } from "@space/contracts";
import { z } from "zod";
import { sendApiError } from "./http-errors.js";
import type { AuditRecorder } from "./request-audit.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";

const idParamSchema = z.object({ id: idSchema });

/** Authentication, CSRF and error serialization belong to the parent application. */
export function registerTelegramRoutes(app: FastifyInstance, options: {
  manager: Pick<TelegramIntegrationManager, "getStatus" | "createPairing" | "checkPairing" | "sendTest" | "setEnabled" | "disconnect">;
  visibility: Pick<CliRuntimeVisibilityPolicy, "assertEnabled">;
  recordAudit: AuditRecorder;
}) {
  const { manager: telegramIntegrationManager, visibility: cliRuntimeVisibility, recordAudit } = options;
  app.get(
    "/api/integrations/telegram",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async () => telegramIntegrationManager.getStatus()
  );
  app.post(
    "/api/integrations/telegram/pairings",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Telegram integration changes require the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const input = createTelegramPairingInputSchema.parse(request.body);
      const pairing = await telegramIntegrationManager.createPairing(input.botToken, request.user.id);
      await recordAudit(request, {
        action: "telegram.pairing.created",
        targetType: "telegram_integration",
        targetId: "global",
        metadata: {
          pairingId: pairing.pairing.id,
          connectionStatus: pairing.integration.connectionStatus,
          expiresAt: pairing.pairing.expiresAt
        }
      });
      return reply.status(201).send(pairing);
    }
  );
  app.post(
    "/api/integrations/telegram/pairings/:id/check",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Telegram integration changes require the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const params = idParamSchema.parse(request.params);
      const status = await telegramIntegrationManager.checkPairing(params.id);
      await recordAudit(request, {
        action: "telegram.pairing.checked",
        targetType: "telegram_integration",
        targetId: "global",
        metadata: { pairingId: params.id, connectionStatus: status.connectionStatus }
      });
      return status;
    }
  );
  app.post(
    "/api/integrations/telegram/test-deliveries",
    { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Telegram integration changes require the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const status = await telegramIntegrationManager.sendTest();
      await recordAudit(request, {
        action: "telegram.test_delivery.sent",
        targetType: "telegram_integration",
        targetId: "global",
        metadata: { connectionStatus: status.connectionStatus }
      });
      return status;
    }
  );
  app.patch(
    "/api/integrations/telegram",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Telegram integration changes require the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const input = updateTelegramIntegrationInputSchema.parse(request.body);
      const status = await telegramIntegrationManager.setEnabled(input.isEnabled);
      await recordAudit(request, {
        action: input.isEnabled ? "telegram.enabled" : "telegram.disabled",
        targetType: "telegram_integration",
        targetId: "global",
        metadata: { connectionStatus: status.connectionStatus, isEnabled: status.isEnabled }
      });
      return status;
    }
  );
  app.delete(
    "/api/integrations/telegram",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Telegram integration changes require the ADMIN role.");
      }
      await cliRuntimeVisibility.assertEnabled("cli:codex");
      const status = await telegramIntegrationManager.disconnect();
      await recordAudit(request, {
        action: "telegram.disconnected",
        targetType: "telegram_integration",
        targetId: "global",
        metadata: { connectionStatus: status.connectionStatus }
      });
      return status;
    }
  );
}
