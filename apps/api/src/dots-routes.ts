import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { dotIdSchema, dotResourceSchema, updateDotProfileSchema, type AgentPaneGoal, type DotResource, type DotCollectionItem, type Pane } from "@space/contracts";
import { SpaceFeatureDisabledError, type SpaceStore } from "@space/runtime";
import type { DotsRepository } from "@space/db";

export function registerDotsRoutes(app: FastifyInstance, options: {
  repository: DotsRepository | null;
  nativeGoals?: () => Promise<AgentPaneGoal[]>;
  /** Resources whose plain path belongs to a dedicated Stage 4 route; their collection stays under /collections. */
  dedicatedResources?: readonly DotResource[];
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
}) {
  const params = z.object({ dotId: dotIdSchema }).strict();
  const pagination = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict();
  const handler = dotsRouteHandler(options.repository, options.authenticatedOwner);
  app.get("/api/dots", options.routeOptions, handler(async (request, owner, repository) => {
    z.object({}).strict().parse(request.query);
    return { dots: await repository.list(owner) };
  }));
  app.get("/api/dots/:dotId", options.routeOptions, handler(async (request, owner, repository) => {
    const { dotId } = params.parse(request.params);
    const dot = await repository.get(owner, dotId);
    return dot ? { dot } : null;
  }));
  app.patch("/api/dots/:dotId", options.routeOptions, handler(async (request, owner, repository) => {
    const { dotId } = params.parse(request.params);
    const dot = await repository.update(owner, dotId, updateDotProfileSchema.parse(request.body));
    return dot ? { dot } : null;
  }));
  const collection = async (request: FastifyRequest, owner: string, repository: DotsRepository, dotId: string, resource: DotResource) => {
    const { limit, offset } = pagination.parse(request.query);
    // Check ownership before reading the native Goal registry, which is shared internally.
    if (!await repository.get(owner, dotId)) return null;
    const items = resource === "goals"
      ? await repository.related(owner, dotId, resource, limit, offset, await options.nativeGoals?.() ?? [])
      : await repository.related(owner, dotId, resource, limit, offset);
    return items ? { dotId, items: items.map(item => projectDotCollectionItem(resource, dotId, item)), limit, offset } : null;
  };
  // Canonical path for every read-only collection.
  const collectionParams = z.object({ dotId: dotIdSchema, resource: dotResourceSchema }).strict();
  app.get("/api/dots/:dotId/collections/:resource", options.routeOptions, handler(async (request, owner, repository) => {
    const { dotId, resource } = collectionParams.parse(request.params);
    return collection(request, owner, repository, dotId, resource);
  }));
  // Stage 2 paths, kept where no dedicated route owns them.
  for (const resource of dotResourceSchema.options.filter(resource => !options.dedicatedResources?.includes(resource))) {
    app.get(`/api/dots/:dotId/${resource}`, options.routeOptions, handler(async (request, owner, repository) =>
      collection(request, owner, repository, params.parse(request.params).dotId, resource)));
  }
}

/** An interactive owner's request against Dots storage; `null` from the action means another user's or a missing Dot. */
export function dotsRouteHandler<R>(repository: R | null, authenticatedOwner: (request: FastifyRequest) => Promise<string>) {
  return (action: (request: FastifyRequest, owner: string, repository: R) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to use Dots." } });
      if (request.user.automationScope || request.user.proofScope === "READ_ONLY") {
        return reply.code(403).send({ error: { code: "DOTS_SCOPE_FORBIDDEN", message: "An interactive user session is required." } });
      }
      if (!repository) return reply.code(503).send({ error: { code: "DOTS_UNAVAILABLE", message: "Dots storage is unavailable." } });
      try {
        const owner = await authenticatedOwner(request);
        const data = await action(request, owner, repository);
        if (data === null) return reply.code(404).send({ error: { code: "DOT_NOT_FOUND", message: "Dot was not found." } });
        return data;
      } catch (error) {
        if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "INVALID_DOT_INPUT", message: "Dots request is invalid." } });
        throw error;
      }
    };
}

const resourceFields: Record<DotResource, string[]> = {
  sessions: ["sessionId", "paneId", "roomId", "threadId", "title", "status", "isActive", "updatedAt"],
  tasks: ["runId", "sessionId", "roomId", "status", "createdAt", "updatedAt", "completedAt"],
  goals: ["kind", "missionId", "sessionId", "roomId", "objective", "status", "statusReason", "updatedAt"],
  memory: ["id", "kind", "roomId", "scope", "title", "body", "revision", "createdAt", "updatedAt"],
  schedules: ["id", "roomId", "updatedAt"],
  receipts: ["id", "kind", "runId", "sessionId", "roomId", "status", "updatedAt"],
  activity: ["id", "kind", "sessionId", "roomId", "status", "updatedAt"]
};
export function projectDotCollectionItem(resource: DotResource, dotId: string, item: Record<string, unknown>): DotCollectionItem {
  const result: Record<string, unknown> = { dotId };
  for (const field of resourceFields[resource]) {
    const value = item[field];
    if (typeof value === "string") result[field] = value.slice(0, field === "body" ? 12000 : 2000);
    else if (typeof value === "boolean" && field === "isActive") result[field] = value;
    else if (typeof value === "number" && field === "revision" && Number.isFinite(value)) result[field] = value;
    else if (value === null && ["threadId", "completedAt"].includes(field)) result[field] = null;
  }
  if (resource === "memory") {
    if (typeof item.provenance === "string") result.source = item.provenance.slice(0, 1000);
    else if (item.kind === "PERSONAL") result.source = "Dot-attributed personal memory";
    // Personal memory's structured value is deliberately not serialized. Its
    // supported metadata is visible until Stage5 defines a safe body projection.
  }
  return result as unknown as DotCollectionItem;
}

export async function validateSessionDotOwner(store: Pick<SpaceStore, "getRoom">, repository: DotsRepository | null,
  pane: Pick<Pane, "roomId">, dotId: string, ownerUserId?: string): Promise<void> {
  const room = await store.getRoom(pane.roomId);
  const owner = ownerUserId ?? room.ownerUserId;
  if (!owner || owner !== room.ownerUserId || !repository || !await repository.get(owner, dotId)) {
    throw new SpaceFeatureDisabledError("DOT_NOT_FOUND", "Dot is not available in this room.");
  }
}
