import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { idSchema, listTaskItemsQuerySchema, taskItemListResponseSchema, createTaskItemRequestSchema, updateTaskItemInputSchema } from "@space/contracts";
import { SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { AuditRecorder } from "./request-audit.js";
import { startTaskSchedules, type TaskScheduleRunnerDeps } from "./task-schedules.js";

const idParamSchema = z.object({ id: idSchema });

/** Owner-scoped domain. Authentication, CSRF, rate limiting and errors are installed by the composition root. */
export function registerTaskItemRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "upsertUser" | "listTaskItems" | "getTaskItem" | "upsertTaskItem" | "updateTaskItem" | "deleteTaskItem" | "clearTaskItems" | "getPane" | "getRoom"
    | "dueTaskSchedules" | "claimTaskSchedule">;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  recordAudit: AuditRecorder;
  /** Scheduled tasks are typed into their CLI panes when due; null where the instance job is off. */
  schedules?: Omit<TaskScheduleRunnerDeps, "store"> | null;
}) {
  const { store, routeOptions, recordAudit } = options;
  if (options.schedules) startTaskSchedules(app, { store, ...options.schedules });
  app.get("/api/task-items", routeOptions, async (request) => {
    const query = listTaskItemsQuerySchema.parse(request.query);
    const owner = await store.upsertUser(request.user!);
    const result = await store.listTaskItems(owner.id, query);
    return taskItemListResponseSchema.parse({
      data: result.items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / query.pageSize)
      }
    });
  });

  app.get("/api/task-items/:id", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const owner = await store.upsertUser(request.user!);
    const item = await store.getTaskItem(owner.id, params.id);
    if (!item) {
      throw new SpaceNotFoundError("Task item was not found.");
    }
    return item;
  });

  app.post("/api/task-items", routeOptions, async (request, reply) => {
    const input = createTaskItemRequestSchema.parse(request.body);
    const owner = await store.upsertUser(request.user!);
    // A scheduled task is typed into its pane, so the pane must be in one of the owner's rooms.
    if (input.paneId) {
      const pane = await Promise.resolve().then(() => store.getPane(input.paneId!)).catch(() => null);
      const room = pane ? await Promise.resolve().then(() => store.getRoom(pane.roomId)).catch(() => null) : null;
      if (!pane || room?.ownerUserId !== owner.id) throw new SpaceNotFoundError("Pane was not found.");
      input.roomId = pane.roomId;
    }
    const item = await store.upsertTaskItem({
      ...input,
      status: input.status ?? "OPEN",
      source: "MANUAL",
      ownerUserId: owner.id
    });
    await recordAudit(request, {
      action: "task.create",
      targetType: "task_item",
      targetId: item.id,
      metadata: { title: item.title, roomId: item.roomId, paneId: item.paneId }
    });
    return reply.code(201).send(item);
  });

  app.patch("/api/task-items/:id", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const input = updateTaskItemInputSchema.parse(request.body);
    const owner = await store.upsertUser(request.user!);
    const item = await store.updateTaskItem(owner.id, params.id, input);
    await recordAudit(request, {
      action: "task.update",
      targetType: "task_item",
      targetId: params.id,
      metadata: { status: input.status, hasTitle: Boolean(input.title) }
    });
    return item;
  });

  app.delete("/api/task-items/:id", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const owner = await store.upsertUser(request.user!);
    const deleted = await store.deleteTaskItem(owner.id, params.id);
    await recordAudit(request, {
      action: "task.delete",
      targetType: "task_item",
      targetId: params.id,
      metadata: {}
    });
    return { id: deleted.id, deleted: true };
  });

  app.delete("/api/task-items", routeOptions, async (request) => {
    const owner = await store.upsertUser(request.user!);
    return { deletedCount: await store.clearTaskItems(owner.id) };
  });

}
