import { defaultPayloadConverter, type Payload } from "@temporalio/common";
import { formatTraceparent, parseTraceparent, workflowTraceReference, type WorkflowTraceReference } from "@space/contracts";

export const WORKFLOW_TRACE_HEADER = "space-workflow-trace-v1";
export const WORKFLOW_TRACE_PATCH = "space-workflow-trace-v1";

export interface WorkflowTraceCarrier {
  traceparent: string;
  requestTraceparent?: string;
  links?: WorkflowTraceReference[];
}

export function readTraceCarrier(headers: Record<string, Payload>): WorkflowTraceCarrier | null {
  const payload = headers[WORKFLOW_TRACE_HEADER];
  if (!payload || !payload.data || payload.data.length > 2048) return null;
  try {
    const raw = defaultPayloadConverter.fromPayload(payload) as WorkflowTraceCarrier;
    const parent = parseTraceparent(raw?.traceparent);
    if (!parent) return null;
    const request = parseTraceparent(raw.requestTraceparent);
    return {
      traceparent: formatTraceparent(parent.traceId, parent.parentId, parent.flags),
      ...(request ? { requestTraceparent: formatTraceparent(request.traceId, request.parentId, request.flags) } : {}),
      links: Array.isArray(raw.links) ? raw.links.slice(0, 8).flatMap(link => workflowTraceReference(link) ?? []) : []
    };
  } catch { return null; }
}

export function traceHeaders(headers: Record<string, Payload>, carrier: WorkflowTraceCarrier): Record<string, Payload> {
  return { ...headers, [WORKFLOW_TRACE_HEADER]: defaultPayloadConverter.toPayload(carrier)! };
}

/** Read only correlation fields at known input locations, never user content. */
export function inputTrace(args: readonly unknown[]): { traceparent?: string; link?: WorkflowTraceReference } {
  let traceparent: string | undefined;
  let link: WorkflowTraceReference | undefined;
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const parsed = parseTraceparent(record.traceparent);
    if (!traceparent && parsed) traceparent = formatTraceparent(parsed.traceId, parsed.parentId, parsed.flags);
    link ??= workflowTraceReference(record.traceLink) ?? undefined;
    if (depth) for (const key of ["turn", "input", "item", "bridge"]) visit(record[key], depth - 1);
  };
  for (const arg of args) visit(arg, 2);
  return { traceparent, link };
}

export interface WorkflowSpanEvent {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startedAt: number;
  endedAt: number;
  outcome: "COMPLETED" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";
  links: WorkflowTraceReference[];
  correlation: Record<string, string>;
}

export function traceCorrelationAttributes(args: readonly unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  const keys: Record<string, string> = { roomId: "space.room_id", paneId: "space.pane_id", missionId: "space.mission_id",
    roomAgentMissionId: "space.mission_id", traceId: "space.trace_id" };
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const raw = value as Record<string, unknown>;
    for (const [key, attribute] of Object.entries(keys)) {
      const id = raw[key];
      if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(id)) result[attribute] ??= id;
    }
    if (depth) for (const key of ["turn", "input", "item", "bridge"]) visit(raw[key], depth - 1);
  };
  for (const value of args) visit(value, 2);
  return result;
}
