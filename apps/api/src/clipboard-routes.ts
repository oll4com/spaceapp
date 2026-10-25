import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { idSchema, listClipboardItemsQuerySchema, clipboardItemListResponseSchema, createClipboardItemRequestSchema, setClipboardItemCompletedRequestSchema, updatePlanProgressRequestSchema, updateClipboardNoteTextRequestSchema } from "@space/contracts";
import { type SpaceStore } from "@space/runtime";

const idParamSchema = z.object({ id: idSchema });

/** Owner-scoped domain. Authentication, CSRF, rate limiting and errors are installed by the composition root. */
export function registerClipboardRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "upsertUser" | "listClipboardItems" | "upsertClipboardItem" | "deleteClipboardItem" | "setClipboardItemCompleted" | "updateClipboardItemProgress" | "updateClipboardNoteText" | "clearClipboardItems">;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, routeOptions } = options;
  app.get("/api/clipboard-items", routeOptions, async (request) => {
    const query = listClipboardItemsQuerySchema.parse(request.query);
    const owner = await store.upsertUser(request.user!);
    const result = await store.listClipboardItems(owner.id, query);
    return clipboardItemListResponseSchema.parse({
      data: result.items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / query.pageSize)
      }
    });
  });

  app.post("/api/clipboard-items", routeOptions, async (request, reply) => {
    const input = createClipboardItemRequestSchema.parse(request.body);
    const owner = await store.upsertUser(request.user!);
    const item = await store.upsertClipboardItem({ ...input, ownerUserId: owner.id });
    return reply.code(201).send(item);
  });

  app.delete("/api/clipboard-items/:id", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const owner = await store.upsertUser(request.user!);
    const deleted = await store.deleteClipboardItem(owner.id, params.id);
    return { id: deleted.id, deleted: true };
  });

  app.patch("/api/clipboard-items/:id", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const input = setClipboardItemCompletedRequestSchema.parse(request.body);
    const owner = await store.upsertUser(request.user!);
    return store.setClipboardItemCompleted(owner.id, params.id, input.completed);
  });

  // A note's edit keeps the same record (id, source, room, pane, created time) instead of saving a new one and deleting the old.
  app.patch("/api/clipboard-items/:id/text", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const input = updateClipboardNoteTextRequestSchema.parse(request.body);
    const owner = await store.upsertUser(request.user!);
    return store.updateClipboardNoteText(owner.id, params.id, input.text);
  });

  app.patch("/api/clipboard-items/:id/progress", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const input = updatePlanProgressRequestSchema.parse(request.body);
    const owner = await store.upsertUser(request.user!);
    const updated = await store.updateClipboardItemProgress(owner.id, params.id, input);
    return updated;
  });

  app.delete("/api/clipboard-items", routeOptions, async (request) => {
    const owner = await store.upsertUser(request.user!);
    return { deletedCount: await store.clearClipboardItems(owner.id) };
  });

}
