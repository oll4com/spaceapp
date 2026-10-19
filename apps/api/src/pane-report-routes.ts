import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { SpaceStore } from "@space/runtime";
import type { CliBridgeClaims } from "./mail-copilot/agent-routes.js";
import { paneProgressSchema, type PaneReports } from "./pane-reports.js";

// A pane CLI's own progress report to Nous (scripts/space-progress.mjs, space_progress_report on the space_browser MCP
// server), with its pane-scoped bridge token: a token reports only for its own pane, in its pane's current room.
export const cliProgressPath = "/api/cli/progress";

export interface PaneReportRouteDependencies {
  store: Pick<SpaceStore, "getRoom" | "getPane">;
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
}
