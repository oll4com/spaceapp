import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { connectPluginInputSchema, agentPluginConfigSchema, isRepositoryProviderId, setRepositoryProviderEnabledSchema } from "@space/contracts";
import { pluginsService, type PluginsService } from "./plugins-service.js";
import type { SourceControlService } from "./source-control/service.js";
import { GitControlError } from "./source-control/errors.js";
import { sendApiError } from "./http-errors.js";
import type { AuditRecorder } from "./request-audit.js";

const pluginIdParamSchema = z.object({
  id: z.string().min(1).max(80)
});

const paneIdParamSchema = z.object({
  paneId: z.string().min(1).max(160)
});

export function registerPluginRoutes(
  app: FastifyInstance,
  rateLimitOptions: Record<string, unknown>,
  personal?: { service: SourceControlService; owner: (request: FastifyRequest) => Promise<string> },
  installation: { service?: PluginsService; recordAudit?: AuditRecorder } = {}
): void {
  const isGitProvider = isRepositoryProviderId;
  const plugins = installation.service ?? pluginsService;
  // Installation plugins (skills, MCP backends) are shared by every account, so only
  // administrators change them. Personal repository providers stay per user.
  const installationChangeDenied = (request: FastifyRequest, reply: FastifyReply) =>
    request.user?.role === "ADMIN" || request.user?.role === "OPERATOR"
      ? null
      : sendApiError(reply, 403, "ADMIN_REQUIRED", "Only an administrator can change installation plugins.");
  const audit = (request: FastifyRequest, action: string, targetId: string, metadata: Record<string, unknown> = {}) =>
    installation.recordAudit?.(request, { action, targetType: "plugin", targetId, metadata });
  app.post("/api/plugins/:id/enabled", rateLimitOptions, async (request, reply) => {
    const params = pluginIdParamSchema.safeParse(request.params);
    const body = setRepositoryProviderEnabledSchema.safeParse(request.body);
    if (!params.success || !isGitProvider(params.data.id) || !body.success) {
      return reply.code(400).send({ error: "INVALID_INPUT", message: "Choose a repository provider and a boolean enabled value." });
    }
    if (!personal) return reply.code(503).send({ error: "SOURCE_CONTROL_UNAVAILABLE", message: "Personal repository providers are unavailable." });
    return personal.service.setEnabled(await personal.owner(request), params.data.id, body.data.enabled);
  });
  // Get all plugins with current connection states
  app.get("/api/plugins", rateLimitOptions, async (request) => {
    const catalog = await plugins.getPlugins();
    if (!personal) return catalog;
    const owner = await personal.owner(request);
    const providers = await personal.service.providers(owner);
    return Promise.all(catalog.map(async plugin => !isGitProvider(plugin.id) ? plugin : ({
      ...plugin,
      enabled: providers.find(p => p.id === plugin.id)!.enabled,
      available: providers.find(p => p.id === plugin.id)!.available,
      authFields: plugin.authFields.map(field => field.key === "serverUrl" ? { ...field, placeholder: personal.service.defaultGiteaUrl } : field),
      connection: await personal.service.pluginState(owner, plugin.id)
    })));
  });

  // Connect a plugin with credentials
  app.post("/api/plugins/:id/connect", rateLimitOptions, async (request, reply) => {
    const params = pluginIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid plugin id" });
    }

    const body = connectPluginInputSchema.safeParse({
      ...(request.body as object),
      pluginId: params.data.id
    });

    if (!body.success) {
      return reply.code(400).send({ error: "INVALID_BODY", message: body.error.message });
    }

    try {
      if (isGitProvider(params.data.id) && !personal) return reply.code(503).send({ error: "SOURCE_CONTROL_UNAVAILABLE", message: "Personal repository providers are unavailable." });
      if (isGitProvider(params.data.id) && personal) {
        const owner = await personal.owner(request);
        await personal.service.connect(owner, params.data.id, body.data.credentials);
        return personal.service.pluginState(owner, params.data.id);
      }
      const denied = installationChangeDenied(request, reply);
      if (denied) return denied;
      const state = await plugins.connectPlugin(body.data);
      await audit(request, "plugins.connected", params.data.id);
      return state;
    } catch (err: unknown) {
      if (err instanceof GitControlError && err.code === "PROVIDER_NOT_AVAILABLE") return reply.code(err.statusCode).send({ error: err.code, message: err.message });
      const message = err instanceof Error ? err.message : "Failed to connect plugin";
      return reply.code(400).send({ error: "CONNECT_FAILED", message });
    }
  });

  // Disconnect a plugin
  app.post("/api/plugins/:id/disconnect", rateLimitOptions, async (request, reply) => {
    const params = pluginIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid plugin id" });
    }

    if (isGitProvider(params.data.id) && !personal) return reply.code(503).send({ error: "SOURCE_CONTROL_UNAVAILABLE", message: "Personal repository providers are unavailable." });
    if (isGitProvider(params.data.id) && personal) {
      const owner = await personal.owner(request); await personal.service.disconnect(owner, params.data.id);
      return personal.service.pluginState(owner, params.data.id);
    }
    const denied = installationChangeDenied(request, reply);
    if (denied) return denied;
    const state = await plugins.disconnectPlugin(params.data.id);
    await audit(request, "plugins.disconnected", params.data.id);
    return state;
  });

  // Test connection / health check
  app.post("/api/plugins/:id/test", rateLimitOptions, async (request, reply) => {
    const params = pluginIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid plugin id" });
    }

    if (isGitProvider(params.data.id) && !personal) return reply.code(503).send({ error: "SOURCE_CONTROL_UNAVAILABLE", message: "Personal repository providers are unavailable." });
    if (isGitProvider(params.data.id) && personal) return personal.service.test(await personal.owner(request), params.data.id);
    return await plugins.testConnection(params.data.id);
  });

  // Upgrade all plugins with available updates
  app.post("/api/plugins/upgrade-all", rateLimitOptions, async (request, reply) => {
    const denied = installationChangeDenied(request, reply);
    if (denied) return denied;
    const result = await plugins.upgradeAllPlugins();
    await audit(request, "plugins.upgraded_all", "all");
    return result;
  });

  // Update plugin to latest version
  app.post("/api/plugins/:id/update", rateLimitOptions, async (request, reply) => {
    const params = pluginIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid plugin id" });
    }

    const denied = installationChangeDenied(request, reply);
    if (denied) return denied;
    try {
      const result = await plugins.updatePlugin(params.data.id);
      await audit(request, "plugins.updated", params.data.id);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to update plugin";
      return reply.code(400).send({ error: "UPDATE_FAILED", message });
    }
  });

  // Check plugin for updates
  app.post("/api/plugins/:id/check-update", rateLimitOptions, async (request, reply) => {
    const params = pluginIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid plugin id" });
    }

    const denied = installationChangeDenied(request, reply);
    if (denied) return denied;
    try {
      return await plugins.checkPluginUpdate(params.data.id);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to check update";
      return reply.code(400).send({ error: "CHECK_UPDATE_FAILED", message });
    }
  });

  // Get agent plugin config
  app.get("/api/plugins/agent/:paneId", rateLimitOptions, async (request, reply) => {
    const params = paneIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid pane id" });
    }

    return await plugins.getAgentConfig(params.data.paneId);
  });

  // Set agent plugin config
  app.post("/api/plugins/agent/:paneId", rateLimitOptions, async (request, reply) => {
    const params = paneIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid pane id" });
    }

    const body = agentPluginConfigSchema.safeParse({
      ...(request.body as object),
      paneId: params.data.paneId
    });

    if (!body.success) {
      return reply.code(400).send({ error: "INVALID_BODY", message: body.error.message });
    }

    const denied = installationChangeDenied(request, reply);
    if (denied) return denied;
    const config = await plugins.setAgentConfig(body.data);
    await audit(request, "plugins.agent_config_updated", params.data.paneId);
    return config;
  });
}
