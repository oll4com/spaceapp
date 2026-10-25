import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sourceControlProviderSchema, updateSourceControlConnectionInputSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import type { SourceControlPublishingManager } from "./source-control-publishing.js";

const sourceControlProviderParamSchema = z.object({ provider: sourceControlProviderSchema }).strict();

/**
 * ADMIN source control provider connections (read, save, verify, delete); the parent retains authentication, CSRF,
 * errors and rate limits.
 */
export function registerSourceControlConnectionRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  sourceControlPublishingManager: SourceControlPublishingManager;
}) {
  const { store, sourceControlPublishingManager } = options;
  app.get(
    "/api/admin/source-control/connections",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Source-control publishing settings require the ADMIN role.");
      }
      return { data: await sourceControlPublishingManager.list() };
    }
  );
  app.get(
    "/api/admin/source-control/connections/:provider",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Source-control publishing settings require the ADMIN role.");
      }
      const params = parseQuery(sourceControlProviderParamSchema, request.params);
      return sourceControlPublishingManager.get(params.provider);
    }
  );
  app.put(
    "/api/admin/source-control/connections/:provider",
    { config: { rateLimit: { max: 6, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Source-control publishing changes require the ADMIN role.");
      }
      const params = parseQuery(sourceControlProviderParamSchema, request.params);
      const input = parseBody(updateSourceControlConnectionInputSchema, request.body);
      const connection = await sourceControlPublishingManager.replace(params.provider, input.token);
      await recordAudit(store, request, {
        action: "source_control.connection.replaced",
        targetType: "source_control_connection",
        targetId: params.provider,
        metadata: {
          provider: connection.provider,
          repositoryOwner: connection.repositoryOwner,
          repositoryName: connection.repositoryName,
          accountLogin: connection.accountLogin,
          status: connection.status,
          lastVerificationCode: connection.lastVerificationCode
        }
      });
      return connection;
    }
  );
  app.post(
    "/api/admin/source-control/connections/:provider/verifications",
    { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Source-control publishing changes require the ADMIN role.");
      }
      const params = parseQuery(sourceControlProviderParamSchema, request.params);
      parseBody(z.object({}).strict(), request.body ?? {});
      const connection = await sourceControlPublishingManager.verify(params.provider);
      await recordAudit(store, request, {
        action: "source_control.connection.verified",
        targetType: "source_control_connection",
        targetId: params.provider,
        metadata: {
          provider: connection.provider,
          accountLogin: connection.accountLogin,
          status: connection.status,
          lastVerificationCode: connection.lastVerificationCode
        }
      });
      return connection;
    }
  );
  app.delete(
    "/api/admin/source-control/connections/:provider",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Source-control publishing changes require the ADMIN role.");
      }
      const params = parseQuery(sourceControlProviderParamSchema, request.params);
      const connection = await sourceControlPublishingManager.disconnect(params.provider);
      await recordAudit(store, request, {
        action: "source_control.connection.disconnected",
        targetType: "source_control_connection",
        targetId: params.provider,
        metadata: { provider: connection.provider, status: connection.status }
      });
      return connection;
    }
  );
}
