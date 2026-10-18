/**
 * Worker-side end of the workerSpans sink. Workflow spans recorded by the
 * sandbox interceptor arrive here (never during replay: the sink is registered
 * with callDuringReplay: false). This module validates and prunes everything
 * before handing a span to the shared OTLP exporter: unknown attribute keys
 * are dropped, ids must be exactly hex, and string values are bounded so a
 * malformed sandbox event can never export unexpected data.
 */

import type { InjectedSinks } from "@temporalio/worker";
import type { SpanExporter } from "@space/runtime";
import {
  WORKFLOW_SPAN_ATTRIBUTE_ALLOWLIST,
  type WorkerSpanSinkDefinitions,
  type WorkflowSpanEvent
} from "./workflow-span-context.js";

const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;
const MAX_LINKS = 8;

function attributeValue(value: unknown): string | number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
  }
  return typeof value === "string" && value.length <= 128 ? value : null;
}

/** Filter an event down to exactly what may be exported; null when its ids are invalid. */
export function sanitizeWorkflowSpanEvent(event: WorkflowSpanEvent): WorkflowSpanEvent | null {
  if (!event || typeof event !== "object") return null;
  if (typeof event.traceId !== "string" || !traceIdPattern.test(event.traceId)) return null;
  if (typeof event.spanId !== "string" || !spanIdPattern.test(event.spanId)) return null;
  const parentSpanId = typeof event.parentSpanId === "string" && spanIdPattern.test(event.parentSpanId)
    ? event.parentSpanId
    : null;
  const workflowType = typeof event.workflowType === "string" && event.workflowType.length <= 200 ? event.workflowType : "unknown";
  const attributes: Record<string, string | number> = {};
  const source = event.attributes && typeof event.attributes === "object" ? event.attributes : {};
  for (const key of WORKFLOW_SPAN_ATTRIBUTE_ALLOWLIST) {
    const value = attributeValue((source as Record<string, unknown>)[key]);
    if (value !== null) attributes[key] = value;
  }
  const links = Array.isArray(event.links)
    ? event.links
        .filter((link): link is { traceId: string; spanId: string } =>
          Boolean(link) && typeof link === "object" && typeof (link as Record<string, unknown>).traceId === "string" &&
          traceIdPattern.test((link as Record<string, unknown>).traceId as string) &&
          typeof (link as Record<string, unknown>).spanId === "string" &&
          spanIdPattern.test((link as Record<string, unknown>).spanId as string))
        .slice(0, MAX_LINKS)
        .map((link) => ({ traceId: link.traceId, spanId: link.spanId }))
    : [];
  const startedAtMs = Number.isFinite(event.startedAtMs) && event.startedAtMs >= 0 ? Math.floor(event.startedAtMs) : 0;
  const endedAtMs = Number.isFinite(event.endedAtMs) && event.endedAtMs >= startedAtMs ? Math.floor(event.endedAtMs) : startedAtMs;
  const outcome = event.outcome === "COMPLETED" || event.outcome === "FAILED" || event.outcome === "CANCELLED" || event.outcome === "CONTINUED"
    ? event.outcome
    : "COMPLETED";
  return {
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId,
    name: "workflow " + workflowType,
    workflowType,
    workflowId: typeof event.workflowId === "string" && event.workflowId.length <= 256 ? event.workflowId : "",
    runId: typeof event.runId === "string" && event.runId.length <= 256 ? event.runId : "",
    attempt: Number.isInteger(event.attempt) && (event.attempt as number) >= 0 ? (event.attempt as number) : 1,
    startedAtMs,
    endedAtMs,
    outcome,
    attributes,
    links
  };
}

/** Record one sanitized workflow span on the shared exporter. */
export function recordWorkflowSpan(spans: SpanExporter, raw: WorkflowSpanEvent): void {
  const event = sanitizeWorkflowSpanEvent(raw);
  if (!event) return;
  spans.record({
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    name: event.name,
    startTimeUnixNano: BigInt(event.startedAtMs) * 1000000n,
    endTimeUnixNano: BigInt(event.endedAtMs) * 1000000n,
    attributes: event.attributes,
    error: event.outcome === "FAILED",
    kind: 1,
    ...(event.links.length ? { links: event.links } : {})
  });
}

/**
 * The workerSpans sink for WorkerOptions.sinks: exports finished workflow
 * spans through the shared exporter, never during replay. Undefined when the
 * exporter is off, so nothing is registered at all.
 */
export function workerSpanSinks(spans: SpanExporter | null): InjectedSinks<WorkerSpanSinkDefinitions> | undefined {
  if (!spans) return undefined;
  return {
    workerSpans: {
      workflowSpan: {
        // callDuringReplay defaults to false: replay emits no duplicate spans.
        fn: (_info, event) => recordWorkflowSpan(spans, event),
        callDuringReplay: false
      }
    }
  };
}
