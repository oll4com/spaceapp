import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { connectPluginInputSchema, agentPluginConfigSchema } from "@space/contracts";
import { pluginsService } from "./plugins-service.js";

const pluginIdParamSchema = z.object({
  id: z.string().min(1).max(80)
});

const paneIdParamSchema = z.object({
  paneId: z.string().min(1).max(160)
});

export function registerPluginRoutes(app: FastifyInstance, rateLimitOptions: Record<string, unknown>): void {
  // Get all plugins with current connection states
  app.get("/api/plugins", rateLimitOptions, async () => {
    return await pluginsService.getPlugins();
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
      const state = await pluginsService.connectPlugin(body.data);
      return state;
    } catch (err: unknown) {
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

    const state = await pluginsService.disconnectPlugin(params.data.id);
    return state;
  });

  // Test connection / health check
  app.post("/api/plugins/:id/test", rateLimitOptions, async (request, reply) => {
    const params = pluginIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid plugin id" });
    }

    return await pluginsService.testConnection(params.data.id);
  });

  // Get agent plugin config
  app.get("/api/plugins/agent/:paneId", rateLimitOptions, async (request, reply) => {
    const params = paneIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "INVALID_PARAM", message: "Invalid pane id" });
    }

    return await pluginsService.getAgentConfig(params.data.paneId);
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

    return await pluginsService.setAgentConfig(body.data);
  });
}
