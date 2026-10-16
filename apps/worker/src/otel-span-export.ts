import { randomBytes } from "node:crypto";
import {
  createOtlpSpanExporter,
  otlpTracesUrl,
  type ServerSpan,
  type SpanExporter
} from "@space/otel-exporter";
import { parseTraceparent } from "@space/contracts";
import {
  activityCorrelation,
  type ActivitySpanRecorder,
  type WorkerSpanFinishInput,
  type WorkerSpanStartInput
} from "./activity-observability.js";
import { logIdentifier } from "./worker-log.js";

/**
 * Worker-side OTLP span export for Temporal worker processes. Off unless
 * SPACE_OTEL_EXPORTER_OTLP_ENDPOINT names a collector base URL (spans go to
 * `<base>/v1/traces`) — the same gating as the API exporter, reusing its
 * dependency-free, bounded-queue implementation from @space/otel-exporter.
 *
 * Spans carry only allowlisted correlation identifiers; prompts, content and
 * messages are never exported. Export is best effort: a failing or slow
 * collector never affects activity execution or worker shutdown.
 */

/** The OTLP exporter for worker spans, or null when export is off/unsafe. */
export function resolveWorkerSpanExporter(
  env: NodeJS.ProcessEnv,
  serviceName = "space-worker"
): SpanExporter | null {
  const endpoint = env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!otlpTracesUrl(endpoint)) return null;
  return createOtlpSpanExporter({ endpoint: endpoint!, serviceName, scopeName: "space-worker" });
}

const traceparentKeys = ["traceparent"] as const;
const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

/** Locate a W3C traceparent in activity args (depth 2, like activityCorrelation). */
function findTraceparent(args: readonly unknown[]): string | null {
  const visit = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    for (const key of traceparentKeys) {
      const identifier = logIdentifier(record[key]);
      if (identifier && parseTraceparent(identifier)) return identifier;
    }
    if (depth <= 0) return null;
    for (const key of nestedKeys) {
      const found = visit(record[key], depth - 1);
      if (found) return found;
    }
    return null;
  };
  for (const arg of args) {
    const found = visit(arg, 2);
    if (found) return found;
  }
  return null;
}

function newSpanId(): string {
  let spanId = randomBytes(8).toString("hex");
  while (/^0+$/.test(spanId)) spanId = randomBytes(8).toString("hex");
  return spanId;
}

interface OpenWorkerActivitySpan extends WorkerSpanStartInput {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

/** Attribute allowlist for exported worker spans: identifiers only. */
const correlationAttributeKeys = [
  "traceId",
  "w3cTraceId",
  "parentTraceId",
  "roomId",
  "paneId",
  "missionId",
  "roomAgentMissionId",
  "agentRunId",
  "agentSessionId",
  "actionId",
  "goalId",
  "dotId",
  "turnId",
  "cliTaskId",
  "revisionId"
] as const;

/**
 * Records one OTLP span per activity execution, continuing the W3C trace the
 * API (or parent workflow) put into the activity args. Activities without a
 * valid trace context record nothing — traces are never fabricated.
 */
export class WorkerActivitySpanRecorder implements ActivitySpanRecorder {
  constructor(private readonly exporter: SpanExporter) {}

  start(input: WorkerSpanStartInput): OpenWorkerActivitySpan | null {
    try {
      const traceparent = findTraceparent(input.args);
      const parsed = traceparent ? parseTraceparent(traceparent) : null;
      if (!parsed) return null;
      return {
        ...input,
        traceId: parsed.traceId,
        spanId: newSpanId(),
        parentSpanId: parsed.parentId
      };
    } catch {
      return null;
    }
  }

  finish(open: unknown, finish: WorkerSpanFinishInput): void {
    const span = open as Partial<OpenWorkerActivitySpan> | null | undefined;
    if (
      !span ||
      typeof span.traceId !== "string" ||
      typeof span.spanId !== "string" ||
      typeof span.startTimeUnixNano !== "bigint" ||
      typeof span.activityType !== "string" ||
      typeof span.activityId !== "string" ||
      !Array.isArray(span.args)
    ) {
      return;
    }
    try {
      const correlation = activityCorrelation(span.args);
      const attributes: Record<string, string | number> = {};
      for (const key of correlationAttributeKeys) {
        const value = correlation[key];
        if (value !== undefined) attributes[key] = value;
      }
      attributes["activity.type"] = logIdentifier(span.activityType) ?? "unknown";
      attributes["activity.id"] = span.activityId;
      if (span.workflowType) attributes["temporal.workflow_type"] = span.workflowType;
      if (finish.reasonCode) attributes["activity.reason_code"] = finish.reasonCode;
      const out: ServerSpan = {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId ?? null,
        name: `activity.${attributes["activity.type"]}`,
        startTimeUnixNano: span.startTimeUnixNano,
        endTimeUnixNano: finish.endTimeUnixNano,
        attributes,
        error: finish.outcome === "FAILED" || finish.outcome === "FAILED_RESULT"
      };
      this.exporter.record(out);
    } catch {
      // best effort: export must never break the activity
    }
  }
}

export type { SpanExporter };
