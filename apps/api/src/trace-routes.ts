import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import {
  categorizeFailureCode,
  isSafeErrorCode,
  traceLookupIdSchema,
  traceLookupResponseSchema,
  type TraceLookupResponse
} from "@space/contracts";
import type { SpaceStore, TraceRecords } from "@space/runtime";
import { sendApiError } from "./http-errors.js";

const identifierPattern = /^[A-Za-z0-9:._-]{1,240}$/;
const identifier = (value: unknown): string | null => (typeof value === "string" && identifierPattern.test(value) ? value : null);
const status = (value: unknown): string | null => (typeof value === "string" && /^[A-Z_]{1,40}$/.test(value) ? value : null);

/**
 * Projects durable trace records to identifiers, codes, statuses and times.
 * Event messages, payload metadata and audit metadata are never returned:
 * they can contain classified error text or user content.
 */
export function projectTraceRecords(traceId: string, records: TraceRecords): TraceLookupResponse {
  const events = records.events.map((event) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const reasonCode = isSafeErrorCode(payload.reasonCode) ? payload.reasonCode : null;
    return {
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      roomId: identifier(event.roomId),
      paneId: identifier(event.paneId),
      turnId: identifier(event.turnId),
      workflowId: identifier(event.workflowId ?? payload.workflowId),
      runId: identifier(payload.runId),
      status: status(payload.status),
      reasonCode,
      category: reasonCode ? categorizeFailureCode(reasonCode) : null
    };
  });
  const agentRuns = (records.agentRuns ?? []).map((run) => {
    const errorCode = isSafeErrorCode(run.errorCode) ? run.errorCode : null;
    return {
      runId: run.runId,
      workflowId: run.workflowId,
      status: run.status,
      errorCode,
      category: errorCode ? categorizeFailureCode(errorCode) : null,
      createdAt: run.createdAt,
      completedAt: run.completedAt ?? null,
      continuationOf: identifier(run.continuationOf)
    };
  });
  const safeCode = (code: string | null) => (isSafeErrorCode(code) ? code : null);
  const roomAgentMissions = (records.roomAgentMissions ?? []).map((mission) => ({ ...mission, errorCode: safeCode(mission.errorCode) }));
  const roomAgentTaskRuns = (records.roomAgentTaskRuns ?? []).map((run) => ({ ...run, errorCode: safeCode(run.errorCode) }));
  // Newest classified failure first: the store returns events newest first. A failed agent run's code is the
  // cause when no event carries one (workflow-level faults that never became an event), then a failed mission's.
  const failure = events.find((event) => event.reasonCode);
  const failedRun = failure ? undefined : agentRuns.find((run) => run.status === "FAILED" && run.errorCode);
  const failedMission = failure || failedRun ? undefined : roomAgentMissions.find((mission) => mission.status === "FAILED" && mission.errorCode);
  return traceLookupResponseSchema.parse({
    traceId,
    causalError: failure
      ? {
          code: failure.reasonCode!,
          category: failure.category!,
          source: `event:${failure.type}`,
          eventId: failure.id,
          workflowId: failure.workflowId,
          at: failure.createdAt
        }
      : failedRun
        ? {
            code: failedRun.errorCode!,
            category: failedRun.category!,
            source: "agent-run",
            eventId: failedRun.runId,
            workflowId: failedRun.workflowId,
            at: failedRun.completedAt ?? failedRun.createdAt
          }
        : failedMission
          ? {
              code: failedMission.errorCode!,
              category: categorizeFailureCode(failedMission.errorCode!),
              source: "room-agent-mission",
              eventId: failedMission.missionId,
              workflowId: null,
              at: failedMission.completedAt ?? failedMission.queuedAt
            }
          : null,
    agentRuns,
    roomAgentMissions,
    roomAgentTaskRuns,
    cliSessions: (records.cliSessions ?? []).map((session) => ({
      sessionId: session.sessionId,
      paneId: session.paneId,
      roomId: session.roomId,
      runtimeId: session.runtimeId,
      cliTaskId: identifier(session.cliTaskId),
      cliTaskRevisionId: identifier(session.cliTaskRevisionId),
      launchMode: session.launchMode,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null
    })),
    events,
    auditEvents: records.auditEvents.map((audit) => ({
      id: audit.id,
      action: audit.action,
      createdAt: audit.createdAt,
      targetType: audit.targetType ?? null,
      targetId: identifier(audit.targetId),
      parentTraceId: identifier((audit.metadata as Record<string, unknown> | undefined)?.parentTraceId)
    })),
    workflows: records.workflows.map((workflow) => ({
      workflowId: workflow.workflowId,
      runId: identifier(workflow.runId),
      type: workflow.type,
      status: workflow.status,
      startedAt: workflow.startedAt,
      closedAt: workflow.closedAt
    })),
    logQueries: {
      api: `journalctl -u space-api.service -o cat | grep -F '"reqId":"${traceId}"'`,
      worker: `journalctl -u space-worker.service -o cat | grep -F '"traceId":"${traceId}"'`
    }
  });
}

/**
 * Administrator trace lookup: follow one Space request id (`x-request-id`,
 * error `requestId`, turn `traceId`) to the durable records and the causal
 * error code. The parent retains authentication, CSRF and error handling.
 */
export function registerTraceRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "listTraceRecords">;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, routeOptions } = options;
  app.get("/api/admin/traces/:traceId", routeOptions, async (request, reply) => {
    if (!request.user || (request.user.role !== "ADMIN" && request.user.role !== "OPERATOR")) {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Administrator permissions are required.");
    }
    const parsed = traceLookupIdSchema.safeParse((request.params as { traceId?: unknown }).traceId);
    if (!parsed.success) return sendApiError(reply, 400, "INVALID_TRACE_ID", "Trace ids are Space request ids such as req:abc123def456.");
    if (!store.listTraceRecords) return sendApiError(reply, 501, "NOT_IMPLEMENTED", "This store does not support trace lookup.");
    return projectTraceRecords(parsed.data, await store.listTraceRecords(parsed.data, { limit: 200 }));
  });
}
