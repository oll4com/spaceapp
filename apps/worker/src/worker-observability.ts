import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InjectedSinks } from "@temporalio/worker";
import {
  categorizeFailureCode,
  deterministicSpanId,
  deterministicTraceId,
  parseTraceparent,
  sanitizeSpanAttributes,
  workflowExecutionSpanId,
  type SpanLink
} from "@space/contracts";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import type { WorkerMetrics } from "./worker-metrics.js";
import type {
  WorkflowObservabilitySinks,
  WorkflowTraceFinishEvent,
  WorkflowTraceObservations,
  WorkflowTraceStartEvent
} from "./workflow-observability-interceptors.js";

export interface ResolvedWorkflowTrace {
  workflowId: string;
  runId: string;
  workflowType: string;
  w3cTraceId: string;
  spanId: string;
  parentSpanId: string | null;
  spaceTraceId: string | null;
  startedAtWallMs: number;
  observations: WorkflowTraceObservations;
  attributes: Record<string, string | number>;
  links: SpanLink[];
}

function nowWallMs(): number {
  return performance.timeOrigin + performance.now();
}

export function observationsToSpanAttributes(observations: WorkflowTraceObservations): Record<string, string | number> {
  const raw: Record<string, unknown> = {
    ...(observations.traceId ? { "space.trace_id": observations.traceId, "space.request_id": observations.traceId } : {}),
    ...(observations.parentTraceId ? { "space.parent_trace_id": observations.parentTraceId } : {}),
    ...(observations.roomId ? { "space.room_id": observations.roomId } : {}),
    ...(observations.paneId ? { "space.pane_id": observations.paneId } : {}),
    ...(observations.missionId ? { "space.mission_id": observations.missionId } : {}),
    ...(observations.agentRunId ? { "space.agent_run_id": observations.agentRunId } : {}),
    ...(observations.agentSessionId ? { "space.agent_session_id": observations.agentSessionId } : {}),
    ...(observations.actionId ? { "space.action_id": observations.actionId } : {}),
    ...(observations.goalId ? { "space.goal_id": observations.goalId } : {}),
    ...(observations.dotId ? { "space.dot_id": observations.dotId } : {}),
    ...(observations.turnId ? { "space.turn_id": observations.turnId } : {}),
    ...(observations.cliTaskId ? { "space.cli_task_id": observations.cliTaskId } : {}),
    ...(observations.revisionId ? { "space.revision_id": observations.revisionId } : {}),
    ...(observations.changeSetId ? { "space.change_set_id": observations.changeSetId } : {}),
    ...(observations.continuationSourceRunId ? { "space.source_run_id": observations.continuationSourceRunId } : {}),
    ...(observations.continuationGeneration !== undefined ? { "space.continuation_generation": observations.continuationGeneration } : {})
  };
  return sanitizeSpanAttributes(raw);
}

/**
 * Bounded in-memory registry of active and recent workflow trace contexts in
 * this worker process so child workflows, continue-as-new runs, background
 * continuations and activity attempts join the same W3C trace and parent span
 * without mutating deterministic workflow command payloads.
 */
export class WorkflowTraceRegistry {
  private readonly byExecution = new Map<string, ResolvedWorkflowTrace>();
  private readonly byWorkflowId = new Map<string, ResolvedWorkflowTrace>();
  private readonly bySpaceTraceId = new Map<string, ResolvedWorkflowTrace>();
  private readonly byAgentRunId = new Map<string, ResolvedWorkflowTrace>();
  private readonly emittedSpanKeys = new Set<string>();

  constructor(private readonly capacity = 4096) {}

  private trim<K, V>(map: Map<K, V>): void {
    while (map.size > this.capacity) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  getByExecution(workflowId: string, runId: string): ResolvedWorkflowTrace | null {
    return this.byExecution.get(`${workflowId}\u0000${runId}`) ?? this.byWorkflowId.get(workflowId) ?? null;
  }

  getBySpaceTraceId(spaceTraceId: string | null | undefined): ResolvedWorkflowTrace | null {
    return spaceTraceId ? this.bySpaceTraceId.get(spaceTraceId) ?? null : null;
  }

  getByAgentRunId(agentRunId: string | null | undefined): ResolvedWorkflowTrace | null {
    return agentRunId ? this.byAgentRunId.get(agentRunId) ?? null : null;
  }

  resolveStart(event: WorkflowTraceStartEvent, startedAtWallMs = nowWallMs()): ResolvedWorkflowTrace {
    const executionKey = `${event.workflowId}\u0000${event.runId}`;
    const existing = this.byExecution.get(executionKey);
    const sameTrace = !existing
      || !event.observations.traceId
      || !existing.spaceTraceId
      || existing.spaceTraceId === event.observations.traceId;
    const mergedObservations: WorkflowTraceObservations = sameTrace
      ? {
          ...existing?.observations,
          ...event.observations
        }
      : { ...event.observations };

    const spanId = workflowExecutionSpanId(event.workflowId, event.runId);
    const parsedTraceparent = parseTraceparent(mergedObservations.traceparent);
    const parentEntry = event.parentWorkflowId && event.parentRunId
      ? this.getByExecution(event.parentWorkflowId, event.parentRunId)
      : null;
    const continuedEntry = event.continuedFromRunId
      ? this.byExecution.get(`${event.workflowId}\u0000${event.continuedFromRunId}`) ?? this.byWorkflowId.get(event.workflowId) ?? null
      : null;
    const isBackgroundContinuation = Boolean(mergedObservations.continuationSourceRunId);

    let w3cTraceId: string;
    if (isBackgroundContinuation) {
      w3cTraceId = parsedTraceparent?.traceId ?? deterministicTraceId(mergedObservations.traceId ?? event.workflowId);
    } else if (parentEntry) {
      w3cTraceId = parentEntry.w3cTraceId;
    } else if (continuedEntry) {
      w3cTraceId = continuedEntry.w3cTraceId;
    } else if (parsedTraceparent) {
      w3cTraceId = parsedTraceparent.traceId;
    } else if (mergedObservations.traceId && this.bySpaceTraceId.has(mergedObservations.traceId)) {
      w3cTraceId = this.bySpaceTraceId.get(mergedObservations.traceId)!.w3cTraceId;
    } else {
      w3cTraceId = deterministicTraceId(mergedObservations.traceId ?? event.workflowId);
    }

    let parentSpanId: string | null;
    if (event.parentWorkflowId && event.parentRunId) {
      if (isBackgroundContinuation && parentEntry && parentEntry.w3cTraceId !== w3cTraceId) {
        parentSpanId = parsedTraceparent?.parentId ?? null;
      } else {
        parentSpanId = workflowExecutionSpanId(event.parentWorkflowId, event.parentRunId);
      }
    } else if (continuedEntry) {
      parentSpanId = continuedEntry.parentSpanId ?? parsedTraceparent?.parentId ?? null;
    } else {
      parentSpanId = parsedTraceparent?.parentId ?? null;
    }

    const links: SpanLink[] = [];
    if (event.continuedFromRunId) {
      const prevSpanId = workflowExecutionSpanId(event.workflowId, event.continuedFromRunId);
      const prevTraceId = continuedEntry?.w3cTraceId ?? w3cTraceId;
      links.push({
        traceId: prevTraceId,
        spanId: prevSpanId,
        attributes: sanitizeSpanAttributes({
          "space.link_kind": "continue_as_new",
          "space.continued_from_run_id": event.continuedFromRunId,
          "space.workflow_id": event.workflowId
        })
      });
    }

    if (mergedObservations.continuationSourceRunId) {
      const sourceRunId = mergedObservations.continuationSourceRunId;
      const sourceEntry = this.getByAgentRunId(sourceRunId) ?? this.getBySpaceTraceId(mergedObservations.continuationSourceTraceId);
      const parsedSource = parseTraceparent(mergedObservations.continuationSourceTraceparent);
      const linkTraceId = sourceEntry?.w3cTraceId
        ?? parsedSource?.traceId
        ?? (mergedObservations.continuationSourceTraceId
          ? deterministicTraceId(mergedObservations.continuationSourceTraceId)
          : parentEntry?.w3cTraceId ?? deterministicTraceId(sourceRunId));
      const linkSpanId = sourceEntry?.spanId ?? parsedSource?.parentId ?? deterministicSpanId(sourceRunId);
      links.push({
        traceId: linkTraceId,
        spanId: linkSpanId,
        attributes: sanitizeSpanAttributes({
          "space.link_kind": "background_continuation",
          "space.source_run_id": sourceRunId,
          ...(mergedObservations.continuationGeneration !== undefined
            ? { "space.continuation_generation": mergedObservations.continuationGeneration }
            : {}),
          ...(mergedObservations.continuationSourceTraceId
            ? { "space.parent_trace_id": mergedObservations.continuationSourceTraceId }
            : {})
        })
      });
    }

    const attributes = sanitizeSpanAttributes({
      "space.workflow_type": event.workflowType,
      "space.workflow_id": event.workflowId,
      "space.run_id": event.runId,
      "space.task_queue": event.taskQueue,
      ...(event.parentWorkflowId ? { "space.parent_workflow_id": event.parentWorkflowId } : {}),
      ...(event.parentRunId ? { "space.parent_run_id": event.parentRunId } : {}),
      ...(event.continuedFromRunId ? { "space.continued_from_run_id": event.continuedFromRunId } : {}),
      ...observationsToSpanAttributes(mergedObservations)
    });

    const resolved: ResolvedWorkflowTrace = {
      workflowId: event.workflowId,
      runId: event.runId,
      workflowType: event.workflowType,
      w3cTraceId,
      spanId,
      parentSpanId,
      spaceTraceId: mergedObservations.traceId ?? parentEntry?.spaceTraceId ?? null,
      startedAtWallMs: sameTrace && existing ? existing.startedAtWallMs : startedAtWallMs,
      observations: mergedObservations,
      attributes,
      links
    };

    this.byExecution.delete(executionKey);
    this.byExecution.set(executionKey, resolved);
    this.trim(this.byExecution);

    this.byWorkflowId.delete(event.workflowId);
    this.byWorkflowId.set(event.workflowId, resolved);
    this.trim(this.byWorkflowId);

    if (resolved.spaceTraceId) {
      this.bySpaceTraceId.delete(resolved.spaceTraceId);
      this.bySpaceTraceId.set(resolved.spaceTraceId, resolved);
      this.trim(this.bySpaceTraceId);
    }

    if (mergedObservations.agentRunId) {
      this.byAgentRunId.delete(mergedObservations.agentRunId);
      this.byAgentRunId.set(mergedObservations.agentRunId, resolved);
      this.trim(this.byAgentRunId);
    }

    return resolved;
  }

  markSpanEmitted(workflowId: string, runId: string, spaceTraceId: string | null): boolean {
    const key = `${workflowId}\u0000${runId}\u0000${spaceTraceId ?? ""}`;
    if (this.emittedSpanKeys.has(key)) return false;
    this.emittedSpanKeys.add(key);
    while (this.emittedSpanKeys.size > this.capacity) {
      const oldest = this.emittedSpanKeys.values().next().value;
      if (oldest === undefined) break;
      this.emittedSpanKeys.delete(oldest);
    }
    return true;
  }
}

export const defaultWorkflowTraceRegistry = new WorkflowTraceRegistry();

export function resolveWorkflowObservabilityModulePath(): string {
  const jsPath = fileURLToPath(new URL("./workflow-observability-interceptors.js", import.meta.url));
  if (existsSync(jsPath)) return jsPath;
  return fileURLToPath(new URL("./workflow-observability-interceptors.ts", import.meta.url));
}

export function createWorkflowObservabilitySinks(options: {
  spanExporter?: SpanExporter | null;
  traceRegistry?: WorkflowTraceRegistry;
} = {}): InjectedSinks<WorkflowObservabilitySinks> {
  const registry = options.traceRegistry ?? defaultWorkflowTraceRegistry;
  const spanExporter = options.spanExporter ?? null;

  return {
    workflowObservability: {
      recordWorkflowStart: {
        callDuringReplay: false,
        fn(_info, event: WorkflowTraceStartEvent) {
          registry.resolveStart(event);
        }
      },
      recordWorkflowFinish: {
        callDuringReplay: false,
        fn(_info, event: WorkflowTraceFinishEvent) {
          const resolved = registry.resolveStart(event);
          if (!spanExporter) return;
          if (!registry.markSpanEmitted(event.workflowId, event.runId, resolved.spaceTraceId)) return;
          const endWallMs = Math.max(resolved.startedAtWallMs, nowWallMs());
          const durationMs = Math.max(0, Math.round(endWallMs - resolved.startedAtWallMs));
          const startNs = BigInt(Math.round(resolved.startedAtWallMs * 1_000_000));
          const endNs = startNs + BigInt(Math.max(0, Math.round((endWallMs - resolved.startedAtWallMs) * 1_000_000)));
          const category = event.reasonCode
            ? (event.outcome === "CANCELLED" ? "CANCELLED" : categorizeFailureCode(event.reasonCode))
            : null;
          spanExporter.record({
            traceId: resolved.w3cTraceId,
            spanId: resolved.spanId,
            parentSpanId: resolved.parentSpanId,
            name: event.workflowType,
            kind: 1,
            startTimeUnixNano: startNs,
            endTimeUnixNano: endNs,
            attributes: sanitizeSpanAttributes({
              ...resolved.attributes,
              "space.outcome": event.outcome,
              "space.status": event.outcome,
              "space.duration_ms": durationMs,
              ...(event.reasonCode ? { "space.reason_code": event.reasonCode, "space.error_code": event.reasonCode } : {}),
              ...(category ? { "space.category": category, "space.error_category": category } : {})
            }),
            ...(resolved.links.length ? { links: resolved.links } : {}),
            error: event.error
          });
        }
      }
    }
  };
}

export interface WorkerObservabilityOptions {
  serviceName?: string;
  env?: NodeJS.ProcessEnv;
  spanExporter?: SpanExporter | null;
  metrics?: WorkerMetrics;
  traceRegistry?: WorkflowTraceRegistry;
}

export function createWorkerObservability(options: WorkerObservabilityOptions = {}) {
  const serviceName = options.serviceName ?? "space-worker";
  const env = options.env ?? process.env;
  const spanExporter = options.spanExporter !== undefined
    ? options.spanExporter
    : otlpSpanExporterFromEnv(env, serviceName);
  const traceRegistry = options.traceRegistry ?? defaultWorkflowTraceRegistry;
  const workflowModulePath = resolveWorkflowObservabilityModulePath();

  const interceptors = {
    workflowModules: [workflowModulePath],
    activity: [
      createActivityObservabilityInterceptors({
        ...(options.metrics ? { metrics: options.metrics } : {}),
        spanExporter,
        traceRegistry
      })
    ]
  };
  const sinks = createWorkflowObservabilitySinks({ spanExporter, traceRegistry });

  return {
    spanExporter,
    traceRegistry,
    interceptors,
    sinks,
    workerOptions: {
      interceptors,
      sinks
    },
    flush: async () => {
      await spanExporter?.flush();
    },
    close: async () => {
      await spanExporter?.close();
    }
  };
}
