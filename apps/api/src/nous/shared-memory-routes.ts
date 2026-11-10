import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { sharedMemoryContentSchema, sharedMemoryStatusSchema } from "@space/contracts";
import { isOperatorPerson } from "../queue-operator-grants.js";
import type { SharedMemory } from "./shared-memory.js";

const patchSchema = sharedMemoryContentSchema.partial().extend({ tags: sharedMemoryContentSchema.shape.tags.removeDefault().optional(), status: sharedMemoryStatusSchema.optional(), revision: z.number().int().positive() }).strict();
const policySchema = z.object({ autoApprove: z.boolean().optional(), dailyUpgrade: z.boolean().optional() }).strict();
export function registerSharedMemoryRoutes(app: FastifyInstance, deps: {
  shared: SharedMemory; assertPerson(request: FastifyRequest): void; routeOptions: Record<string, unknown>;
  parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T>;
  audit(owner: string, action: string, id?: string): Promise<void>;
}) {
  const owner = (request: FastifyRequest, write = false) => {
    if (!request.user) throw Object.assign(new Error("Sign in to read shared memory."), { statusCode: 401 });
    if (write) {
      if (!isOperatorPerson(request.user)) throw Object.assign(new Error("Only a team administrator in person can manage shared memory."), { statusCode: 403 });
      deps.assertPerson(request);
    }
    return request.user.id;
  };
  const base = "/api/nous/shared-memory";
  app.get(base, deps.routeOptions, async (request) => {
    const who = owner(request); return { entries: await deps.shared.list(who), policy: await deps.shared.policy(who) };
  });
  app.patch(`${base}/policy`, deps.routeOptions, async (request) => {
    const who = owner(request, true); const policy = await deps.shared.savePolicy(who, deps.parseBody(policySchema, request.body));
    await deps.audit(who, "policy"); return { policy };
  });
  app.post(base, deps.routeOptions, async (request, reply) => {
    const who = owner(request, true); const entry = await deps.shared.create(who, deps.parseBody(sharedMemoryContentSchema, request.body));
    await deps.audit(who, "create", entry.id); return reply.code(201).send({ entry });
  });
  app.patch(`${base}/:id`, deps.routeOptions, async (request, reply) => {
    const who = owner(request, true); const { id } = request.params as { id: string };
    const { revision, ...patch } = deps.parseBody(patchSchema, request.body);
    const entry = await deps.shared.update(who, id, revision, patch);
    if (!entry) return reply.code(409).send({ error: { code: "SHARED_MEMORY_CONFLICT", message: "This entry changed, was removed, or duplicates existing knowledge. Reload and try again." } });
    await deps.audit(who, "update", id); return { entry };
  });
  app.delete(`${base}/:id`, deps.routeOptions, async (request, reply) => {
    const who = owner(request, true); const { id } = request.params as { id: string };
    const { revision } = deps.parseBody(z.object({ revision: z.number().int().positive() }).strict(), request.body);
    if (!await deps.shared.remove(who, id, revision)) return reply.code(409).send({ error: { message: "This entry changed, was removed, or duplicates existing knowledge. Reload and try again." } });
    await deps.audit(who, "delete", id); return { deleted: true };
  });
}
