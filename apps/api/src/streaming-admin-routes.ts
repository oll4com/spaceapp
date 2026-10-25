import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import type { StreamingService } from "./streaming-service.js";
import type { AuditRecorder } from "./request-audit.js";
import { sendApiError } from "./http-errors.js";
import { z } from "zod";
import { streamingOAuthProviderSchema, streamingCatalogResponseSchema, streamingOAuthStartResponseSchema, streamingOverlaySnapshotSchema, streamingVerifyAccountResponseSchema, streamingDisconnectAuthorizationResponseSchema, updateStreamingOverlaySettingsInputSchema } from "@space/contracts";
import { cookieName } from "./auth.js";
import { StreamingServiceError } from "./streaming-service.js";

function parseBody<TSchema extends z.ZodType>(schema: TSchema, body: unknown): z.infer<TSchema> {
  return schema.parse(body);
}

function streamingOAuthPopupHtml(provider: z.infer<typeof streamingOAuthProviderSchema>, ok: boolean): string {
  const payload = JSON.stringify({ type: "space.streaming.oauth", provider, ok }).replaceAll("<", "\\u003c");
  const heading = ok ? "Connection complete" : "Connection failed";
  const detail = ok ? "You can close this window and return to Space." : "Return to Space for safe provider details.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${heading}</title></head><body><main><h1>${heading}</h1><p>${detail}</p></main><script>
try { localStorage.setItem("space.streaming.oauth", JSON.stringify({ type: "space.streaming.oauth", provider: ${JSON.stringify(provider)}, ok: ${ok}, at: Date.now() })); } catch (e) {}
try { window.opener?.postMessage(${payload}, window.location.origin); } catch (e) {}
window.close();
</script></body></html>`;
}

/** Authentication, CSRF and internal-token gates are installed by the composition root. */
export function registerStreamingAdminRoutes(app: FastifyInstance, options: {
  streamingService: Pick<StreamingService, "catalog" | "startOAuth" | "getPendingAuthorization" | "completeOAuth" | "verifyAccount" | "removeAccount" | "disconnectAuthorization" | "updateOverlaySettings" | "overlaySnapshot">;
  recordAudit: AuditRecorder;
}) {
  const { streamingService, recordAudit } = options;
  app.get(
    "/api/admin/streaming/catalog",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming integrations require the ADMIN role.");
      }
      return streamingCatalogResponseSchema.parse(await streamingService.catalog());
    }
  );
  app.post(
    "/api/admin/streaming/providers/:provider/oauth/start",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming integrations require the ADMIN role.");
      }
      const { provider } = z.object({ provider: streamingOAuthProviderSchema }).strict().parse(request.params);
      parseBody(z.object({}).strict(), request.body ?? {});
      const sessionToken = request.cookies[cookieName] ?? "";
      const result = streamingOAuthStartResponseSchema.parse(await streamingService.startOAuth(provider, sessionToken));
      await recordAudit(request, {
        action: "admin.streaming.oauth_started",
        targetType: "streaming_provider",
        targetId: provider,
        metadata: { provider, expiresAt: result.expiresAt }
      });
      return result;
    }
  );
  app.get(
    "/api/admin/streaming/providers/:provider/oauth/authorize",
    { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const params = z.object({ provider: streamingOAuthProviderSchema }).strict().safeParse(request.params);
      if (!params.success) return reply.status(400).send("Invalid provider");
      const query = z.object({ state: z.string().min(1).max(1024) }).safeParse(request.query);
      if (!query.success) return reply.status(400).send("Invalid state");
      const targetUrl = streamingService.getPendingAuthorization(params.data.provider, query.data.state);
      if (!targetUrl) {
        return reply.status(400).type("text/html; charset=utf-8").send("<!doctype html><html><body><p>Authorization request expired or invalid. Please close this window and try again from Space.</p></body></html>");
      }
      return reply.redirect(targetUrl);
    }
  );
  app.get(
    "/api/admin/streaming/providers/:provider/oauth/callback",
    { config: { rateLimit: { max: 30, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const params = z.object({ provider: streamingOAuthProviderSchema }).strict().safeParse(request.params);
      const provider = params.success ? params.data.provider : "YOUTUBE";
      if (!params.success) {
        return reply.type("text/html; charset=utf-8").send(streamingOAuthPopupHtml(provider, false));
      }
      const query = z.object({
        code: z.string().min(1).max(4096).optional(),
        state: z.string().min(1).max(1024).optional(),
        error: z.string().max(200).optional()
      }).passthrough().safeParse(request.query);
      if (!query.success || query.data.error || !query.data.code || !query.data.state) {
        return reply.type("text/html; charset=utf-8").send(streamingOAuthPopupHtml(provider, false));
      }
      try {
        const result = await streamingService.completeOAuth({
          provider,
          code: query.data.code,
          state: query.data.state,
          sessionToken: request.cookies[cookieName] ?? ""
        });
        await recordAudit(request, {
          action: "admin.streaming.oauth_completed",
          targetType: "streaming_authorization",
          targetId: result.authorization.id,
          metadata: { provider, accountCount: result.accounts.length }
        });
        return reply.type("text/html; charset=utf-8").send(streamingOAuthPopupHtml(provider, true));
      } catch (error) {
        request.log.info(
          {
            errorCode: error instanceof StreamingServiceError
              ? error.code
              : error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code.slice(0, 100)
                : "OAUTH_CALLBACK_FAILED",
            requestId: request.requestIdForSpace,
            provider
          },
          "streaming OAuth callback failed"
        );
        return reply.type("text/html; charset=utf-8").send(streamingOAuthPopupHtml(provider, false));
      }
    }
  );
  app.post(
    "/api/admin/streaming/accounts/:accountId/verify",
    { config: { rateLimit: { max: 30, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming integrations require the ADMIN role.");
      }
      const { accountId } = z.object({ accountId: z.string().min(1).max(200) }).strict().parse(request.params);
      parseBody(z.object({}).strict(), request.body ?? {});
      return streamingVerifyAccountResponseSchema.parse(await streamingService.verifyAccount(accountId));
    }
  );
  app.delete(
    "/api/admin/streaming/accounts/:accountId",
    { config: { rateLimit: { max: 30, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming integrations require the ADMIN role.");
      }
      const { accountId } = z.object({ accountId: z.string().min(1).max(200) }).strict().parse(request.params);
      const account = await streamingService.removeAccount(accountId);
      await recordAudit(request, {
        action: "admin.streaming.account_removed",
        targetType: "streaming_account",
        targetId: accountId,
        metadata: { provider: account.provider }
      });
      return { account };
    }
  );
  app.delete(
    "/api/admin/streaming/authorizations/:authorizationId",
    { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming integrations require the ADMIN role.");
      }
      const { authorizationId } = z.object({ authorizationId: z.string().min(1).max(200) }).strict().parse(request.params);
      const result = streamingDisconnectAuthorizationResponseSchema.parse(
        await streamingService.disconnectAuthorization(authorizationId)
      );
      await recordAudit(request, {
        action: "admin.streaming.authorization_disconnected",
        targetType: "streaming_authorization",
        targetId: authorizationId,
        metadata: { status: result.status, disconnected: result.disconnected }
      });
      return result;
    }
  );
  app.patch(
    "/api/admin/streaming/overlay-settings",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming integrations require the ADMIN role.");
      }
      const input = parseBody(updateStreamingOverlaySettingsInputSchema, request.body);
      const settings = await streamingService.updateOverlaySettings(input, request.user.id);
      await recordAudit(request, {
        action: "admin.streaming.overlay_saved",
        targetType: "streaming_overlay",
        targetId: "global",
        metadata: { version: settings.version, tileCount: settings.tiles.length, customTextEnabled: settings.customTextEnabled }
      });
      return settings;
    }
  );
  app.get(
    "/api/admin/streaming/overlay-snapshot",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Streaming integrations require the ADMIN role.");
      }
      return streamingOverlaySnapshotSchema.parse(await streamingService.overlaySnapshot());
    }
  );
}
