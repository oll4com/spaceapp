import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { InjectedSinks } from "@temporalio/worker";
import { sanitizeSpanAttributes, type SpanExporter } from "@space/runtime";
import {
  type WorkflowObservabilitySinks,
  type WorkflowSpanRecordPayload
} from "./workflow-observability-interceptors.js";

/** Compiled `.js` in production, the `.ts` source when tests bundle the worker. */
function resolveWorkflowObservabilityInterceptorPath(): string {
  const compiled = fileURLToPath(new URL("./workflow-observability-interceptors.js", import.meta.url));
  if (existsSync(compiled)) return compiled;
  const source = compiled.replace(/\.js$/, ".ts");
  return existsSync(source) ? source : compiled;
}

export const workflowObservabilityInterceptorPath = resolveWorkflowObservabilityInterceptorPath();

export interface ActiveWorkflowTraceState {
  spanId: string;
  traceparent: string;
  correlation: Record<string, string>;
  startedAtMs: number;
}

const activeWorkflows = new Map<string, ActiveWorkflowTraceState>();
const MAX_ACTIVE_WORKFLOWS = 4096;

function workflowKey(workflowId: string, runId: string): string {
  return `${workflowId}\u0000${runId}`;
}

export function rememberActiveWorkflowTrace(
  workflowId: string,
  runId: string,
  state: ActiveWorkflowTraceState
): void {
  const key = workflowKey(workflowId, runId);
  activeWorkflows.delete(key);
  activeWorkflows.set(key, state);
  while (activeWorkflows.size > MAX_ACTIVE_WORKFLOWS) {
    const oldest = activeWorkflows.keys().next().value;
    if (oldest === undefined) break;
    activeWorkflows.delete(oldest);
  }
}

export function lookupActiveWorkflowTrace(
  workflowId: string | null | undefined,
  runId: string | null | undefined
): ActiveWorkflowTraceState | null {
  if (!workflowId || !runId) return null;
  return activeWorkflows.get(workflowKey(workflowId, runId)) ?? null;
}

export interface WorkflowObservabilityOptions {
  spans?: SpanExporter | null;
  now?: () => number;
}

export function recordWorkflowSpan(
  payload: WorkflowSpanRecordPayload,
  options: WorkflowObservabilityOptions & { startedAtMs?: number } = {}
): void {
  const spans = options.spans;
  if (!spans) return;
  const now = options.now ?? Date.now;
  const finishedAtMs = now();
  const key = workflowKey(payload.workflowId, payload.runId);
  const existing = activeWorkflows.get(key);
  const startedAtMs = options.startedAtMs ?? existing?.startedAtMs ?? finishedAtMs;
  const durationMs = Math.max(0, finishedAtMs - startedAtMs);

  const rawAttributes: Record<string, string | number> = {
    ...payload.correlation,
    "space.workflow_type": payload.workflowType,
    "space.workflow_id": payload.workflowId,
    "space.run_id": payload.runId,
    "space.outcome": payload.outcome,
    "space.duration_ms": durationMs
  };
  if (payload.parentWorkflowId) rawAttributes["space.parent_workflow_id"] = payload.parentWorkflowId;
  if (payload.parentRunId) rawAttributes["space.parent_run_id"] = payload.parentRunId;
  if (payload.continuedFromRunId) rawAttributes["space.continued_from_run_id"] = payload.continuedFromRunId;
  if (payload.reasonCode) rawAttributes["space.reason_code"] = payload.reasonCode;
  if (payload.category) rawAttributes["space.category"] = payload.category;

  spans.record({
    traceId: payload.traceId,
    spanId: payload.spanId,
    parentSpanId: payload.parentSpanId,
    name: `workflow ${payload.workflowType}`,
    startTimeUnixNano: BigInt(startedAtMs) * 1_000_000n,
    endTimeUnixNano: BigInt(startedAtMs + durationMs) * 1_000_000n,
    attributes: sanitizeSpanAttributes(rawAttributes),
    error: payload.outcome === "FAILED",
    kind: 1,
    ...(payload.links.length ? { links: payload.links } : {})
  });
}

/**
 * Temporal worker sinks for deterministic workflow span export.
 * Both functions set `callDuringReplay: false` so workflow replay never emits duplicate spans.
 */
export function createWorkflowObservabilitySinks(
  options: WorkflowObservabilityOptions = {}
): InjectedSinks<WorkflowObservabilitySinks> {
  const now = options.now ?? Date.now;
  return {
    workflowObservability: {
      workflowStarted: {
        callDuringReplay: false,
        fn(info, spanId, traceparent, correlation) {
          const runStartMs = info.runStartTime instanceof Date ? info.runStartTime.getTime() : now();
          rememberActiveWorkflowTrace(info.workflowId, info.runId, {
            spanId,
            traceparent,
            correlation: correlation ?? {},
            startedAtMs: Number.isFinite(runStartMs) ? Math.min(runStartMs, now()) : now()
          });
        }
      },
      workflowFinished: {
        callDuringReplay: false,
        fn(info, payload) {
          // After a worker restart/cache eviction, workflowStarted was skipped
          // during replay (callDuringReplay: false), so the in-memory start
          // time is gone. Prefer the remembered start, then Temporal's
          // runStartTime, so long-running workflows do not export duration 0.
          const existing = lookupActiveWorkflowTrace(info.workflowId, info.runId);
          const runStartMs = info.runStartTime instanceof Date ? info.runStartTime.getTime() : Number.NaN;
          const startedAtMs =
            existing?.startedAtMs ?? (Number.isFinite(runStartMs) ? runStartMs : undefined);
          recordWorkflowSpan(payload, {
            ...options,
            ...(startedAtMs !== undefined ? { startedAtMs } : {})
          });
        }
      }
    }
  };
}
