import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  createDotMemoryInputSchema,
  dotIdSchema,
  dotMemoryIdSchema,
  dotMemoryProjectKey,
  dotMemoryTextSchema,
  listDotMemoriesQuerySchema,
  updateDotMemoryInputSchema,
  type DotMemory,
  type DotMemoryScope
} from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";
import type { DotMemoryRepository, DotsRepository } from "@space/db";

/**
 * Space Dots Stage 5: each Dot's memory, per Dot and per project.
 *
 * The owner lists, adds, edits and forgets memories in the Memory view. A Dot
 * recalls, remembers, updates and forgets its own memories through gateway
 * tools; sharing a memory with all Dots needs the owner's approval. Forgetting
 * deletes the memory and its embedding; audit records keep only ids.
 */
export class DotMemoryError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) { super(message); }
}
export interface DotMemoryServiceDeps {
  store: Pick<SpaceStore, "getRoom">;
  dots: Pick<DotsRepository, "get">;
  memories: DotMemoryRepository;
  /** An embedding when semantic memory is ready; null otherwise (text search still works). */
  embed?(text: string, purpose?: "document" | "query"): Promise<number[] | null>;
  audit(request: FastifyRequest | null, action: string, metadata: Record<string, unknown>): Promise<void>;
}
type ToolOutcome = { status: "COMPLETED"; result: unknown } | { status: "BLOCKED"; statusReason: string };

export function createDotMemoryService(deps: DotMemoryServiceDeps) {
  const embed = async (text: string, purpose: "document" | "query" = "document") => deps.embed ? await deps.embed(text, purpose).catch(() => null) : null;
  async function owned(owner: string, dotId: string) {
    if (!await deps.dots.get(owner, dotId)) throw new DotMemoryError(404, "DOT_NOT_FOUND", "Dot was not found.");
  }
  async function projectKey(owner: string, roomId: string | null | undefined): Promise<string | null> {
    if (!roomId) return null;
    const room = await Promise.resolve().then(() => deps.store.getRoom(roomId)).catch(() => null);
    return room && room.ownerUserId === owner ? dotMemoryProjectKey(room.projectPath) : null;
  }
  async function create(owner: string, dotId: string, input: { text: string; scope: DotMemoryScope; roomId?: string | null },
    source: "USER" | "DOT", sourceRef: string | null, request: FastifyRequest | null): Promise<DotMemory> {
    await owned(owner, dotId);
    const text = redactMemoryText(dotMemoryTextSchema.parse(input.text));
    const project = input.scope === "PROJECT" ? await projectKey(owner, input.roomId) : null;
    if (input.scope === "PROJECT" && !project) throw new DotMemoryError(409, "DOT_MEMORY_NO_PROJECT", "This room has no project, so the memory cannot belong to one.");
    const memory = await deps.memories.create({ ownerUserId: owner, dotId: input.scope === "SHARED" ? null : dotId, scope: input.scope,
      projectKey: project, text, source, sourceRef, embedding: await embed(text) });
    await deps.audit(request, "dot.memory.create", { dotId, memoryId: memory.memoryId, scope: memory.scope, source });
    return memory;
  }
  async function update(owner: string, dotId: string, memoryId: string, raw: unknown, request: FastifyRequest | null,
    editor: { source: "USER" | "DOT"; sourceRef: string | null } = { source: "USER", sourceRef: null }): Promise<DotMemory> {
    await owned(owner, dotId);
    const text = redactMemoryText(updateDotMemoryInputSchema.parse(raw).text);
    const updated = await deps.memories.update(owner, dotId, dotMemoryIdSchema.parse(memoryId), text, await embed(text), editor);
    if (!updated) throw new DotMemoryError(404, "DOT_MEMORY_NOT_FOUND", "Memory was not found.");
    await deps.audit(request, "dot.memory.update", { dotId, memoryId });
    return updated;
  }
  async function forget(owner: string, dotId: string, memoryId: string, request: FastifyRequest | null): Promise<void> {
    await owned(owner, dotId);
    if (!await deps.memories.delete(owner, dotId, dotMemoryIdSchema.parse(memoryId))) throw new DotMemoryError(404, "DOT_MEMORY_NOT_FOUND", "Memory was not found.");
    await deps.audit(request, "dot.memory.delete", { dotId, memoryId });
  }
  async function list(owner: string, dotId: string, raw: unknown) {
    await owned(owner, dotId);
    const query = listDotMemoriesQuerySchema.parse(raw ?? {});
    return deps.memories.list(owner, dotId, { scope: query.scope, q: query.q, limit: query.limit });
  }
  /** Recent memories for the start of a turn in this room. */
  async function context(owner: string, dotId: string, roomId: string, limit = 12): Promise<DotMemory[]> {
    const project = await projectKey(owner, roomId);
    const recent = await deps.memories.list(owner, dotId, { projectKey: project ?? "", limit: limit * 2 });
    return recent.filter((memory) => memory.scope !== "PROJECT" || (project !== null && memory.projectKey === project)).slice(0, limit);
  }
  /** `dot_memory.*` gateway tools. SHARED `remember` arrives here only after the owner approved it. */
  async function tool(session: { sessionId: string; dotId: string; roomId: string }, owner: string, toolId: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const blocked = (statusReason: string): ToolOutcome => ({ status: "BLOCKED", statusReason });
    try {
      switch (toolId) {
        case "dot_memory.recall": {
          const input = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(30).optional() }).strict().safeParse(args);
          if (!input.success) return blocked("dot_memory.recall needs a query.");
          const found = await deps.memories.recall(owner, session.dotId, await projectKey(owner, session.roomId),
            { text: input.data.query, embedding: await embed(input.data.query, "query") }, input.data.limit ?? 10);
          return { status: "COMPLETED", result: { memories: found.map(({ memoryId, scope, text, source, updatedAt }) => ({ memoryId, scope, text, source, updatedAt })) } };
        }
        case "dot_memory.remember": {
          const input = z.object({ text: dotMemoryTextSchema, scope: z.enum(["DOT", "PROJECT", "SHARED"]).default("DOT") }).strict().safeParse(args);
          if (!input.success) return blocked("dot_memory.remember needs text (up to 4000 characters) and an optional scope DOT, PROJECT or SHARED.");
          const memory = await create(owner, session.dotId, { text: input.data.text, scope: input.data.scope, roomId: session.roomId }, "DOT", session.sessionId, null);
          return { status: "COMPLETED", result: { memoryId: memory.memoryId, scope: memory.scope } };
        }
        case "dot_memory.update": {
          const input = z.object({ memoryId: dotMemoryIdSchema, text: dotMemoryTextSchema }).strict().safeParse(args);
          if (!input.success) return blocked("dot_memory.update needs a memoryId and the new text.");
          const memory = await update(owner, session.dotId, input.data.memoryId, { text: input.data.text }, null, { source: "DOT", sourceRef: session.sessionId });
          return { status: "COMPLETED", result: { memoryId: memory.memoryId, updatedAt: memory.updatedAt } };
        }
        case "dot_memory.forget": {
          const input = z.object({ memoryId: dotMemoryIdSchema }).strict().safeParse(args);
          if (!input.success) return blocked("dot_memory.forget needs a memoryId.");
          await forget(owner, session.dotId, input.data.memoryId, null);
          return { status: "COMPLETED", result: { memoryId: input.data.memoryId, deleted: true } };
        }
        default: return blocked("Unknown memory tool.");
      }
    } catch (error) {
      return blocked(error instanceof DotMemoryError ? error.message : "The memory could not be changed.");
    }
  }
  async function scope(owner: string, dotId: string, memoryId: string) {
    const parsed = dotMemoryIdSchema.safeParse(memoryId);
    return parsed.success ? (await deps.memories.get(owner, dotId, parsed.data))?.scope ?? null : null;
  }
  return { list, create, update, forget, context, tool, scope };
}
export type DotMemoryService = ReturnType<typeof createDotMemoryService>;

export function registerDotMemoryRoutes(app: FastifyInstance, service: DotMemoryService | null, options: {
  routeOptions: RouteShorthandOptions;
  authenticatedOwner: (request: FastifyRequest) => Promise<string>;
}) {
  const params = z.object({ dotId: dotIdSchema }).strict();
  const memoryParams = z.object({ dotId: dotIdSchema, memoryId: dotMemoryIdSchema }).strict();
  const user = (action: (request: FastifyRequest, owner: string, service: DotMemoryService) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Sign in to use Dots." } });
      if (request.user.automationScope || request.user.proofScope === "READ_ONLY") {
        return reply.code(403).send({ error: { code: "DOTS_SCOPE_FORBIDDEN", message: "An interactive user session is required." } });
      }
      if (!service) return reply.code(503).send({ error: { code: "DOT_MEMORY_UNAVAILABLE", message: "Dot memory is unavailable." } });
      try { return await action(request, await options.authenticatedOwner(request), service); }
      catch (error) {
        if (error instanceof DotMemoryError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: "DOT_MEMORY_INVALID", message: "Memory request is invalid." } });
        throw error;
      }
    };
  app.get("/api/dots/:dotId/memories", options.routeOptions, user(async (request, owner, service) => {
    const { dotId } = params.parse(request.params);
    return { dotId, items: await service.list(owner, dotId, request.query) };
  }));
  app.post("/api/dots/:dotId/memories", options.routeOptions, user(async (request, owner, service) => {
    const { dotId } = params.parse(request.params);
    const input = createDotMemoryInputSchema.parse(request.body ?? {});
    return { memory: await service.create(owner, dotId, input, "USER", null, request) };
  }));
  app.patch("/api/dots/:dotId/memories/:memoryId", options.routeOptions, user(async (request, owner, service) => {
    const { dotId, memoryId } = memoryParams.parse(request.params);
    return { memory: await service.update(owner, dotId, memoryId, request.body ?? {}, request) };
  }));
  app.delete("/api/dots/:dotId/memories/:memoryId", options.routeOptions, user(async (request, owner, service) => {
    const { dotId, memoryId } = memoryParams.parse(request.params);
    await service.forget(owner, dotId, memoryId, request);
    return { memoryId, deleted: true };
  }));
}
