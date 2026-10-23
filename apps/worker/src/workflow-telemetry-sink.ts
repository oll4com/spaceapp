import type { WorkflowInfo } from "@temporalio/workflow";
import type { InjectedSinks } from "@temporalio/worker";
import type { ServerSpan, SpanExporter, SpanLink } from "@space/runtime";
import { identifierPattern } from "./telemetry-identifiers.js";
import type { WorkflowTelemetrySinks } from "./workflow-observability.js";

/**
 * Worker-process implementation of the workflow telemetry sink. The workflow
 * isolate calls `workflowStarted` / `workflowCompleted` (registered with
 * `callDuringReplay: false`, so replay emits no spans); this side timestamps
 * with worker-process time, joins start and finish, and records one INTERNAL
 * span per workflow execution via the shared OTLP exporter.
 *
 * This file is never bundled into the workflow isolate.
 */

interface StartedSpan {
  traceId: string;
  parentSpanId: string | null;
  name: string;
  attributes: Record<string, string | number>;
  links: SpanLink[];
  startTimeMs: number;
  workflowType: string;
  workflowId: string;
  runId: string;
}

const MAX_STARTED = 4096;

function safeIdentifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value) ? value : null;
}

function parseStarted(payloadJson: string): Omit<StartedSpan, "startTimeMs" | "workflowType" | "workflowId" | "runId"> | null {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const traceId = safeIdentifier(payload.traceId);
  const spanId = safeIdentifier(payload.spanId);
  if (!traceId || !spanId || !/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) return null;
  const attributes: Record<string, string | number> = {};
  const rawAttributes = payload.attributes;
  if (rawAttributes && typeof rawAttributes === "object" && !Array.isArray(rawAttributes)) {
    for (const [key, value] of Object.entries(rawAttributes as Record<string, unknown>)) {
      if (typeof key !== "string") continue;
      if (typeof value === "number" && Number.isInteger(value)) attributes[key] = value;
      else {
        const id = safeIdentifier(value);
        if (id !== null) attributes[key] = id;
      }
    }
  }
  const links: SpanLink[] = [];
  if (Array.isArray(payload.links)) {
    for (const link of payload.links) {
      if (!link || typeof link !== "object") continue;
      const linkTraceId = safeIdentifier((link as Record<string, unknown>).traceId);
      const linkSpanId = safeIdentifier((link as Record<string, unknown>).spanId);
      if (linkTraceId && linkSpanId && /^[0-9a-f]{32}$/.test(linkTraceId) && /^[0-9a-f]{16}$/.test(linkSpanId)) {
        links.push({ traceId: linkTraceId, spanId: linkSpanId });
      }
    }
  }
  return {
    traceId,
    parentSpanId: safeIdentifier(payload.parentSpanId),
    name: typeof payload.name === "string" ? payload.name.slice(0, 200) : "workflow",
    attributes,
    links
  };
}

/**
 * Create the injected sink implementations for workflow span export.
 * Safe to call with a null exporter (export off): the sinks become no-ops so
 * workflow code never fails on a missing sink.
 */
export function createWorkflowTelemetrySinks(spans: SpanExporter | null): InjectedSinks<WorkflowTelemetrySinks> {
  const started = new Map<string, StartedSpan>();

  const remember = (spanId: string, record: StartedSpan): void => {
    started.delete(spanId);
    started.set(spanId, record);
    while (started.size > MAX_STARTED) {
      const oldest = started.keys().next().value;
      if (oldest === undefined) break;
      started.delete(oldest);
    }
  };

  return {
    workflowTelemetry: {
      workflowStarted: {
        fn: (info: WorkflowInfo, payloadJson: string): void => {
          if (!spans) return;
          let spanId: string | null = null;
          try {
            spanId = safeIdentifier((JSON.parse(payloadJson) as Record<string, unknown>).spanId);
          } catch {
            return;
          }
          if (!spanId || !/^[0-9a-f]{16}$/.test(spanId)) return;
          const parsed = parseStarted(payloadJson);
          if (!parsed) return;
          remember(spanId, {
            ...parsed,
            startTimeMs: Date.now(),
            workflowType: typeof info.workflowType === "string" ? info.workflowType.slice(0, 200) : "unknown",
            workflowId: safeIdentifier(info.workflowId) ?? "unknown",
            runId: safeIdentifier(info.runId) ?? "unknown"
          });
        },
        callDuringReplay: false
      },
      workflowCompleted: {
        fn: (info: WorkflowInfo, payloadJson: string): void => {
          if (!spans) return;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(payloadJson) as Record<string, unknown>;
          } catch {
            return;
          }
          const spanId = safeIdentifier(payload.spanId);
          if (!spanId) return;
          const start = started.get(spanId);
          if (!start) return;
          started.delete(spanId);
          const endTimeMs = Date.now();
          const status = payload.status === "COMPLETED" ? "COMPLETED" : payload.status === "CANCELLED" ? "CANCELLED" : "FAILED";
          const attributes: Record<string, string | number> = {
            ...start.attributes,
            "space.workflow_type": start.workflowType,
            "space.workflow_id": start.workflowId,
            "space.run_id": start.runId,
            "space.status": status
          };
          const errorCode = safeIdentifier(payload.errorCode);
          if (errorCode && status !== "COMPLETED") attributes["space.error_code"] = errorCode;
          const span: ServerSpan = {
            traceId: start.traceId,
            spanId,
            parentSpanId: start.parentSpanId,
            name: start.name,
            startTimeUnixNano: BigInt(start.startTimeMs) * 1_000_000n,
            endTimeUnixNano: BigInt(Math.max(endTimeMs, start.startTimeMs)) * 1_000_000n,
            attributes,
            error: status !== "COMPLETED",
            kind: 1,
            links: start.links
          };
          try {
            spans.record(span);
          } catch {
            // Export is best effort; never break the worker.
          }
        },
        callDuringReplay: false
      }
    }
  };
}
