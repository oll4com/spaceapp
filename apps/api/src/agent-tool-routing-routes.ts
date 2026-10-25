import { readFile } from "node:fs/promises";
import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  agentToolAssignmentSchema, applyAgentToolsInputSchema, idSchema, resolveToolRoute, spaceToolPolicies,
  updateAgentToolAssignmentInputSchema, updateToolRoutingSchema
} from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { applyAgentTools, buildAgentToolsCatalog, type AgentToolsOptions } from "./agent-tools.js";
import { sendApiError } from "./http-errors.js";
import type { AuditRecorder } from "./request-audit.js";
import {
  discoverRoutingProfiles, effectiveRouting, projectRoutingState, routingStateWithLegacy, saveProjectedRouting,
  serializeRoutingUpdate
} from "./tool-routing.js";

/**
 * ADMIN tool-routing policy and agent tool assignment domain. Launching agent tool
 * tasks needs the CLI terminal manager and stays in the composition root, which
 * also retains authentication, CSRF, errors and rate limits.
 */
export function registerAgentToolRoutingRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  agentToolsOptions: AgentToolsOptions | undefined;
  recordAudit: AuditRecorder;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  /** Written by the inventory job (scripts/space-capability-usage.mjs). */
  capabilityUsagePath?: string;
}) {
  const { store, agentToolsOptions, recordAudit, routeOptions: defaultRouteRateLimitOptions } = options;
  const capabilityUsagePath = options.capabilityUsagePath ?? "/opt/spaceapp/var/inventory/capability-usage.json";
  const routingQuery = z.object({ runtimeId: z.string().min(1).max(160), modelId: z.string().min(1).max(160) }).strict();

  app.get("/api/model-capabilities", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Routing settings require ADMIN.");
    return { profiles: await discoverRoutingProfiles(agentToolsOptions), state: await store.getToolRoutingState() };
  });

  // Which skills and MCP tools agents used in the last 30 days (identifiers and counts only).
  app.get("/api/agent-tools/usage", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Agent tool usage requires ADMIN.");
    const raw = await readFile(capabilityUsagePath, "utf8").catch(() => null);
    if (raw === null) return { available: false, reason: "No usage has been collected yet; the inventory job writes it every 10 minutes." };
    try {
      return { available: true, ...JSON.parse(raw) };
    } catch {
      return sendApiError(reply, 500, "USAGE_UNREADABLE", "The collected usage file is not valid JSON.");
    }
  });

  app.get("/api/agent-tools/effective", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Routing settings require ADMIN.");
    const input = routingQuery.parse(request.query);
    return effectiveRouting(store, input.runtimeId, input.modelId, agentToolsOptions);
  });

  app.post("/api/agent-tools/route-preview", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Routing settings require ADMIN.");
    const input = routingQuery.extend({ toolId: z.string().max(160), taskNeedsTool: z.boolean().default(true) }).parse(request.body);
    const plan = await effectiveRouting(store, input.runtimeId, input.modelId, agentToolsOptions);
    const policy = spaceToolPolicies.find((entry) => entry.toolId === input.toolId);
    if (!policy) return sendApiError(reply, 404, "TOOL_NOT_FOUND", "No routing policy exists for this tool.");
    const state = await routingStateWithLegacy(store);
    return resolveToolRoute(policy, plan.profile, state.overrides, { taskNeedsTool: input.taskNeedsTool });
  });

  app.put("/api/agent-tools/policies", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Routing settings require ADMIN.");
    const input = updateToolRoutingSchema.parse(request.body);
    return serializeRoutingUpdate(async () => {
      const previous = await store.getToolRoutingState();
      const state = await saveProjectedRouting(store, { ...previous, enabledRuntimeIds: input.enabledRuntimeIds, overrides: input.overrides }, input.expectedRevision, request.user!.id, agentToolsOptions);
      await recordAudit(request, {
        action: "agent_tools.routing_updated", targetType: "agent_tools", targetId: "routing",
        metadata: { revision: state.revision, enabledRuntimeIds: state.enabledRuntimeIds }
      });
      return state;
    });
  });

  app.post("/api/agent-tools/vision-exceptions", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "A per-turn vision exception requires an explicit ADMIN request.");
    const input = routingQuery.extend({
      sessionId: idSchema, turnId: idSchema, expectedRevision: z.number().int().nonnegative()
    }).parse(request.body);
    return serializeRoutingUpdate(async () => {
      const session = await store.getPaneCliSession(input.sessionId);
      if (!session || session.runtimeId !== input.runtimeId || session.status !== "RUNNING") {
        throw new SpaceConflictError("A vision exception requires a running session of the selected runtime.");
      }
      const previous = await store.getToolRoutingState();
      const visionExceptions = previous.visionExceptions.filter((entry) => Date.parse(entry.expiresAt) > Date.now());
      visionExceptions.push({
        runtimeId: input.runtimeId, modelId: input.modelId, sessionId: input.sessionId, turnId: input.turnId,
        actorId: request.user!.id, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      });
      const state = await saveProjectedRouting(store, { ...previous, visionExceptions }, input.expectedRevision, request.user!.id, agentToolsOptions);
      await recordAudit(request, { action: "agent_tools.vision_exception", targetType: "cli_session",
        targetId: input.sessionId, metadata: { modelId: input.modelId, turnId: input.turnId, expiresInSeconds: 300 } });
      return { revision: state.revision, expiresInSeconds: 300 };
    });
  });

  const agentToolIdParamSchema = z.object({ toolId: idSchema });

  app.get("/api/agent-tools/catalog", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Agent tools require the ADMIN role.");
    }
    return await buildAgentToolsCatalog(store, agentToolsOptions);
  });

  app.patch("/api/agent-tools/assignments/:toolId", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Agent tool assignments require the ADMIN role.");
    }
    const params = agentToolIdParamSchema.parse(request.params);
    const input = updateAgentToolAssignmentInputSchema.parse(request.body ?? {});
    return serializeRoutingUpdate(async () => {
      const assignment = await store.updateAgentToolAssignment(params.toolId, input, request.user?.id ?? "operator:unknown");
      await projectRoutingState(store, agentToolsOptions);
      return agentToolAssignmentSchema.parse(assignment);
    });
  });

  app.delete("/api/agent-tools/assignments/:toolId", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Agent tool assignments require the ADMIN role.");
    }
    const params = agentToolIdParamSchema.parse(request.params);
    return serializeRoutingUpdate(async () => {
    const deleted = await store.deleteAgentToolAssignment(params.toolId);
    if (!deleted) {
      throw new SpaceNotFoundError(`Agent tool assignment ${params.toolId} was not found.`);
    }
    await projectRoutingState(store, agentToolsOptions);
    return { toolId: params.toolId, deleted: true };
    });
  });

  app.post("/api/agent-tools/apply", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Applying agent tools requires the ADMIN role.");
    }
    const input = applyAgentToolsInputSchema.parse(request.body ?? {});
    return serializeRoutingUpdate(async () => {
      const result = await applyAgentTools(store, input.assignments, agentToolsOptions);
      for (const assignment of input.assignments) {
        await store.updateAgentToolAssignment(assignment.toolId, assignment, request.user!.id);
      }
      await projectRoutingState(store, agentToolsOptions);
      return result;
    });
  });
}
