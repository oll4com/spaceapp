import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { nousTestTargetSchema } from "@space/contracts";
import { makeSpaceId, type SpaceStore } from "@space/runtime";
import { TEST_RESOURCE_CREATED } from "./nous/allowances.js";
import type { CliBridgeClaims } from "./mail-copilot/agent-routes.js";
import { paneProgressSchema, type PaneReports } from "./pane-reports.js";

// A pane CLI's own progress report to Nous (scripts/space-progress.mjs, space_progress_report on the space_progress MCP
// server), with its pane-scoped bridge token: a token reports only for its own pane, in its pane's current room.
export const cliProgressPath = "/api/cli/progress";
/** R27-1: a pane records a test VM/CT or snapshot it created (scripts/space-test-resource.mjs), so Nous may delete it later under "May delete what Nous created". */
export const cliTestResourcePath = "/api/cli/test-resources";
const testResourceSchema = nousTestTargetSchema.extend({
  kind: z.enum(["VM", "CT", "SNAPSHOT"]),
  note: z.string().trim().min(3).max(500)
}).strict().refine((input) => (input.kind === "SNAPSHOT") === Boolean(input.snapshot), { message: "A SNAPSHOT names its snapshot; a VM or CT names none.", path: ["snapshot"] });

export interface PaneReportRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane" | "recordAuditEvent">;
  routeOptions: Record<string, unknown>;
  requireBridge(request: FastifyRequest, reply: FastifyReply): Promise<{ claims: CliBridgeClaims } | null>;
  parseBody<TSchema extends z.ZodTypeAny>(schema: TSchema, body: unknown): z.infer<TSchema>;
  /** Nous's pane reports, once Nous is registered. */
  reports(): PaneReports | null;
}

export function registerPaneReportRoutes(app: FastifyInstance, deps: PaneReportRouteDependencies): void {
  app.post(cliProgressPath, deps.routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return reply;
    const reports = deps.reports();
    if (!reports) throw Object.assign(new Error("Pane reports are not available yet."), { statusCode: 503 });
    const input = deps.parseBody(paneProgressSchema, request.body ?? {});
    const [room, pane] = await Promise.all([deps.store.getRoom(bridge.claims.roomId), deps.store.getPane(bridge.claims.paneId)]);
    const report = await reports.report(room, pane, input);
    // The stored summary, redacted: what Nous will read.
    return reply.code(201).send({ id: report.id, at: report.at, status: report.status, summary: report.summary });
  });
  // The record is the server's: stamped with the token's own pane and session, under the room's owner; never written by Nous.
  app.post(cliTestResourcePath, deps.routeOptions, async (request, reply) => {
    const bridge = await deps.requireBridge(request, reply);
    if (!bridge) return reply;
    const input = deps.parseBody(testResourceSchema, request.body ?? {});
    const room = await deps.store.getRoom(bridge.claims.roomId);
    const event = await deps.store.recordAuditEvent({ actorUserId: room.ownerUserId ?? "user:operator", traceId: makeSpaceId("trace"), action: TEST_RESOURCE_CREATED,
      targetType: "pane", targetId: bridge.claims.paneId, metadata: { ...input, snapshot: input.snapshot ?? null, paneId: bridge.claims.paneId, roomId: room.id, cliSessionId: bridge.claims.cliSessionId } });
    return reply.code(201).send({ id: event.id, at: event.createdAt });
  });
}
