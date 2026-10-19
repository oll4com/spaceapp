import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createTaskItemRequestSchema, idSchema, listTaskItemsQuerySchema, ownerWorkingTimeZone, updateTaskItemInputSchema } from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { CliBridgeClaims } from "./mail-copilot/agent-routes.js";

// The room owner's Tasks dock, reached by a pane CLI with its pane-scoped bridge token (scripts/space-task.mjs).
// A task an agent adds runs in the agent's own pane; the agent can change only its owner's tasks.
export const cliTaskItemsPathPrefix = "/api/cli/task-items";

const createSchema = createTaskItemRequestSchema.pick({ title: true, objective: true, schedule: true });

export interface TaskAgentRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane" | "listTaskItems" | "getTaskItem" | "upsertTaskItem" | "updateTaskItem" | "getUserSettings">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  audit(request: FastifyRequest, action: string, targetId: string | null, metadata?: Record<string, unknown>): Promise<void>;
}

export function registerTaskAgentRoutes(app: FastifyInstance, deps: TaskAgentRouteDependencies): void {
  const { store, routeOptions, parseBody, parseQuery } = deps;

  async function context(request: FastifyRequest, reply: FastifyReply) {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return null;
    const room = await store.getRoom(bridge.claims.roomId);
    if (!room.ownerUserId) throw new SpaceConflictError("This room has no owner; tasks belong to a signed-in operator account.");
    return { owner: room.ownerUserId, claims: bridge.claims };
  }

  app.get(cliTaskItemsPathPrefix, routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const query = parseQuery(listTaskItemsQuerySchema, request.query ?? {});
    const result = await store.listTaskItems(bridge.owner, query);
    // The owner's working time zone: a schedule sent without one runs in it (space-task converts local --at times with it).
    return { items: result.items, total: result.total, timeZone: ownerWorkingTimeZone(await store.getUserSettings(bridge.owner)) };
  });

  app.post(cliTaskItemsPathPrefix, routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const input = parseBody(createSchema, request.body ?? {});
    const pane = await store.getPane(bridge.claims.paneId);
    const item = await store.upsertTaskItem({ ...input, ownerUserId: bridge.owner, status: "OPEN", source: "AGENT",
      roomId: bridge.claims.roomId, paneId: pane.id, paneTitle: pane.title.slice(0, 160) || null });
    await deps.audit(request, "task.agent.create", item.id, { paneId: pane.id, scheduled: Boolean(item.schedule) });
    return reply.code(201).send(item);
  });

  app.patch(`${cliTaskItemsPathPrefix}/:id`, routeOptions, async (request, reply) => {
    const bridge = await context(request, reply);
    if (!bridge) return reply;
    const { id } = parseQuery(z.object({ id: idSchema }).strict(), request.params);
    if (!await store.getTaskItem(bridge.owner, id)) throw new SpaceNotFoundError("Task item was not found.");
    const input = parseBody(updateTaskItemInputSchema, request.body ?? {});
    const item = await store.updateTaskItem(bridge.owner, id, input);
    await deps.audit(request, "task.agent.update", id, { status: input.status, schedule: input.schedule === undefined ? undefined : Boolean(input.schedule) });
    return item;
  });
}
