import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { idSchema, listUserLinksQuerySchema, createUserLinkRequestSchema, updateUserLinkRequestSchema } from "@space/contracts";
import { type SpaceStore } from "@space/runtime";
import type { AuditRecorder } from "./request-audit.js";

const idParamSchema = z.object({ id: idSchema });

/** Owner-scoped domain. Authentication, CSRF, rate limiting and errors are installed by the composition root. */
export function registerUserLinkRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "upsertUser" | "listUserLinks" | "createUserLink" | "updateUserLink" | "deleteUserLink">;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  recordAudit: AuditRecorder;
}) {
  const { store, routeOptions, recordAudit } = options;
  app.get("/api/links", routeOptions, async (request) => {
    const query = listUserLinksQuerySchema.parse(request.query);
    const owner = await store.upsertUser(request.user!);
    const result = await store.listUserLinks(owner.id, query);
    return {
      data: result.items,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems: result.total,
        totalPages: Math.ceil(result.total / query.pageSize)
      }
    };
  });

  app.post("/api/links", routeOptions, async (request, reply) => {
    const input = createUserLinkRequestSchema.parse(request.body);
    const owner = await store.upsertUser(request.user!);
    const link = await store.createUserLink({ ...input, ownerUserId: owner.id });
    await recordAudit(request, {
      action: "link.create",
      targetType: "user_link",
      targetId: link.id,
      metadata: { hostname: new URL(link.url).hostname }
    });
    return reply.code(201).send(link);
  });

  app.patch("/api/links/:id", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const input = updateUserLinkRequestSchema.parse(request.body);
    const owner = await store.upsertUser(request.user!);
    const link = await store.updateUserLink(owner.id, params.id, input);
    await recordAudit(request, {
      action: "link.update",
      targetType: "user_link",
      targetId: link.id,
      metadata: { hostname: new URL(link.url).hostname }
    });
    return link;
  });

  app.delete("/api/links/:id", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const owner = await store.upsertUser(request.user!);
    const link = await store.deleteUserLink(owner.id, params.id);
    await recordAudit(request, {
      action: "link.delete",
      targetType: "user_link",
      targetId: link.id,
      metadata: { hostname: new URL(link.url).hostname }
    });
    return { id: link.id, deleted: true };
  });

}
