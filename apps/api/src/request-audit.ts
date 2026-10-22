import type {} from "./request-context.js";
import type { FastifyRequest } from "fastify";
import type { SpaceStore } from "@space/runtime";

export async function recordAudit(
  store: Pick<SpaceStore, "upsertUser" | "recordAuditEvent">,
  request: FastifyRequest,
  input: {
    action: string;
    targetType: string;
    targetId?: string | null;
    actorUserId?: string | null;
    metadata?: Record<string, unknown>;
  }
) {
  let actorUserId = input.actorUserId ?? request.user?.id ?? null;
  if (request.user) {
    const persistedUser = await store.upsertUser(request.user);
    if (!input.actorUserId || input.actorUserId === request.user.id) {
      actorUserId = persistedUser.id;
    }
  }
  await store.recordAuditEvent({
    actorUserId,
    traceId: request.requestIdForSpace,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    // An agent's broker session acts as the operator; the row keeps who really called (hardening plan step 17).
    metadata: request.sessionPrincipal
      ? { ...input.metadata, sessionPrincipal: request.sessionPrincipal, ...(request.user?.brokerScope ? { brokerScope: request.user.brokerScope } : {}) }
      : input.metadata ?? {}
  });
}


export type AuditRecorder = (request: FastifyRequest, input: Parameters<typeof recordAudit>[2]) => Promise<void>;
