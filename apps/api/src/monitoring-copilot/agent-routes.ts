import type {} from "../request-context.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  monitoringActionBeginSchema, monitoringActionFinishSchema, monitoringActionIdSchema, monitoringEventIdSchema, monitoringLogQuerySchema, monitoringMemoryCreateSchema, monitoringMemoryIdSchema, monitoringMemoryKindSchema, monitoringMemoryUpdateSchema,
  monitoringPromQuerySchema, monitoringSeveritySchema, type Pane
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { MonitoringCopilotService } from "./service.js";

// Agent-facing routes of the Monitoring Copilot pane, reached with the pane-scoped CLI bridge token: only the CLI session of a
// Monitoring Copilot pane (space_monitoringcopilot). Answers carry structured fields; LogQL answers are counts, never log lines.
export const cliMonitoringCopilotPathPrefix = "/api/cli/monitoring-copilot/";

interface CliBridgeClaims { roomId: string; paneId: string; cliSessionId: string }
export interface MonitoringCopilotAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
}

const text = (max: number) => z.string().trim().min(1).max(max);

export function registerMonitoringCopilotAgentRoutes(app: FastifyInstance, service: MonitoringCopilotService, deps: MonitoringCopilotAgentRouteDependencies): void {
  const { routeOptions, parseBody, parseQuery } = deps;
  type Bridge = { owner: string; pane: Pane };

  function handle(method: "get" | "post" | "patch" | "delete", path: string, handler: (bridge: Bridge, request: FastifyRequest) => Promise<unknown>) {
    app[method](`${cliMonitoringCopilotPathPrefix}${path}`, routeOptions, async (request, reply) => {
      const bridge = await deps.requireBridge(request, reply);
      if (!bridge) return reply;
      const room = await deps.store.getRoom(bridge.claims.roomId);
      if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; the Monitoring Copilot works in a signed-in operator's room.");
      const pane = await deps.store.getPane(bridge.claims.paneId);
      if (pane.mode !== "MONITORING_COPILOT") throw new SpaceConflictError("Monitoring Copilot tools belong to the CLI session of a Monitoring Copilot pane.");
      return handler({ owner: room.ownerUserId, pane }, request);
    });
  }
  const id = (request: FastifyRequest, schema: z.ZodType<string>): string => parseQuery(z.object({ id: schema }).strict(), request.params).id;

  handle("post", "next", async ({ owner, pane }) => service.next(owner, pane));
  handle("get", "summary", async ({ owner }) => service.summary(owner));

  // ---- alerts, targets, queries
  handle("get", "alerts", async ({ owner }, request) => {
    const query = parseQuery(z.object({ all: z.enum(["true", "false"]).optional(), severity: monitoringSeveritySchema.optional(),
      limit: z.coerce.number().int().min(1).max(300).optional() }).strict(), request.query);
    return { alerts: await service.alerts(owner, { firing: query.all !== "true", severity: query.severity ? [query.severity] : undefined, limit: query.limit }) };
  });
  handle("get", "targets", async ({ owner, pane }, request) => {
    const query = parseQuery(z.object({ down: z.enum(["true", "false"]).optional() }).strict(), request.query);
    const targets = await service.targets(owner, pane);
    return { targets: query.down === "true" ? targets.filter((target) => target.health !== "up") : targets };
  });
  handle("post", "query", async ({ owner, pane }, request) => service.promQuery(owner, pane, parseBody(monitoringPromQuerySchema, request.body ?? {})));
  handle("post", "logs", async ({ owner, pane }, request) => service.logQuery(owner, pane, parseBody(monitoringLogQuerySchema, request.body ?? {})));

  // ---- the gate (Phase 4)
  handle("post", "actions/begin", async ({ owner, pane }, request) => {
    const input = parseBody(monitoringActionBeginSchema, request.body ?? {});
    const result = await service.beginAction(owner, pane, input);
    await deps.audit(request, "monitoring_copilot.action.begin", result.actionId, { paneId: pane.id, kind: input.kind, target: input.target, gate: result.gate });
    return result;
  });
  handle("post", "actions/:id/start", async ({ owner, pane }, request) => {
    const action = await service.startApproved(owner, pane, id(request, monitoringActionIdSchema));
    await deps.audit(request, "monitoring_copilot.action.start", action.id, { paneId: pane.id, kind: action.kind });
    return { action };
  });
  handle("post", "actions/:id/finish", async ({ owner, pane }, request) => {
    const actionId = id(request, monitoringActionIdSchema);
    const input = parseBody(monitoringActionFinishSchema, request.body ?? {});
    const action = await service.finishAction(owner, pane, actionId, input);
    await deps.audit(request, "monitoring_copilot.action.finish", actionId, { paneId: pane.id, status: input.status });
    return { action };
  });
  handle("get", "actions", async ({ owner }, request) => {
    const query = parseQuery(z.object({ target: z.string().max(63).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict(), request.query);
    return { actions: await service.actions(owner, query) };
  });

  // ---- briefs, questions, notes
  handle("post", "briefs/:id/done", async ({ owner, pane }, request) => {
    const briefId = id(request, monitoringEventIdSchema);
    const input = parseBody(z.object({ summary: text(2000), failed: z.boolean().default(false) }).strict(), request.body ?? {});
    const event = await service.finishBrief(owner, pane, briefId, input);
    await deps.audit(request, "monitoring_copilot.brief.done", briefId, { paneId: pane.id, failed: input.failed });
    return { event };
  });
  handle("post", "ask", async ({ owner, pane }, request) => {
    const input = parseBody(z.object({ question: text(2000), options: z.array(text(200)).max(6).optional() }).strict(), request.body ?? {});
    return { question: await service.ask(owner, pane, input) };
  });
  handle("post", "events/:id/wait", async ({ owner, pane }, request) => service.waitForAnswer(owner, pane, id(request, monitoringEventIdSchema),
    parseBody(z.object({ waitMs: z.number().int().min(0).max(50_000).default(30_000) }).strict(), request.body ?? {}).waitMs));
  handle("post", "note", async ({ owner, pane }, request) => ({ event: await service.note(owner, pane, parseBody(z.object({ message: text(2000) }).strict(), request.body ?? {}).message) }));

  // ---- memory
  handle("post", "memory/recall", async ({ owner }, request) => {
    const query = parseBody(z.object({ query: z.string().max(300).optional(), target: z.string().max(200).optional(), kinds: z.array(monitoringMemoryKindSchema).max(7).optional(),
      limit: z.number().int().min(1).max(50).optional() }).strict(), request.body ?? {});
    return { memories: await service.recall(owner, query) };
  });
  handle("post", "memory", async ({ owner }, request) => ({ memory: await service.remember(owner, parseBody(monitoringMemoryCreateSchema, request.body ?? {}), "AGENT") }));
  handle("patch", "memory/:id", async ({ owner }, request) => ({ memory: await service.updateMemory(owner, id(request, monitoringMemoryIdSchema), parseBody(monitoringMemoryUpdateSchema, request.body ?? {})) }));
  handle("delete", "memory/:id", async ({ owner }, request) => service.forget(owner, id(request, monitoringMemoryIdSchema)));
}
