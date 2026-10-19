import { defaultPayloadConverter } from "@temporalio/common";
import {
  proxySinks,
  workflowInfo,
  type Headers,
  type Sinks,
  type WorkflowInterceptorsFactory
} from "@temporalio/workflow";
import { formatTraceparent, parseTraceparent } from "@space/contracts";
import { SPAN_LINK_HEADER, TRACEPARENT_HEADER } from "./trace-headers.js";

/**
 * Workflow-side OTLP spans. Workflows cannot do I/O, so spans leave the sandbox
 * through a sink registered by the worker. The sink is called outside the
 * isolate and respects `callDuringReplay: false`.
 *
 * Only identifiers and bounded status fields are exported; prompt text, paths,
 * URLs and model output never reach this module.
 */

export interface WorkflowSpanLink {
  traceId: string;
  spanId: string;
}

export interface WorkflowSpanPayload {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
  error: boolean;
  kind: number;
  links?: WorkflowSpanLink[];
}

export interface WorkflowTelemetrySinks extends Sinks {
  spaceWorkflowTelemetry: {
    span(payload: WorkflowSpanPayload): void;
  };
}

const { spaceWorkflowTelemetry } = proxySinks<WorkflowTelemetrySinks>();

const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;
const traceIdPattern = /^[0-9a-f]{32}$/;
const spanIdPattern = /^[0-9a-f]{16}$/;

function findTraceparent(value: unknown, depth: number): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.traceparent === "string" && parseTraceparent(record.traceparent)) return record.traceparent;
  if (depth <= 0) return null;
  for (const key of nestedKeys) {
    const found = findTraceparent(record[key], depth - 1);
    if (found) return found;
  }
  return null;
}

function findTraceLink(value: unknown, depth: number): WorkflowSpanLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const link = record.traceLink;
  if (link && typeof link === "object") {
    const { traceId, spanId } = link as { traceId?: unknown; spanId?: unknown };
    if (typeof traceId === "string" && traceIdPattern.test(traceId) &&
        typeof spanId === "string" && spanIdPattern.test(spanId)) return { traceId, spanId };
  }
  if (depth <= 0) return null;
  for (const key of nestedKeys) {
    const found = findTraceLink(record[key], depth - 1);
    if (found) return found;
  }
  return null;
}

function decodeHeader(headers: Record<string, unknown>, name: string): string | null {
  const payload = headers[name];
  if (!payload || typeof payload !== "object") return null;
  try {
    const value = defaultPayloadConverter.fromPayload(payload as never);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function parseSpanLink(value: string | null): WorkflowSpanLink | null {
  if (!value) return null;
  const [traceId, spanId] = value.split(":");
  return typeof traceId === "string" && traceIdPattern.test(traceId) &&
    typeof spanId === "string" && spanIdPattern.test(spanId) ? { traceId, spanId } : null;
}

function inboundTraceparent(args: readonly unknown[], headers: Record<string, unknown>): string | null {
  const fromHeader = decodeHeader(headers, TRACEPARENT_HEADER);
  if (parseTraceparent(fromHeader)) return fromHeader;
  for (const arg of args) {
    const found = findTraceparent(arg, 2);
    if (found) return found;
  }
  const memo = workflowInfo().memo;
  const fromMemo = typeof memo?.traceparent === "string" ? memo.traceparent : null;
  return parseTraceparent(fromMemo) ? fromMemo : null;
}

function inboundLinks(args: readonly unknown[], headers: Record<string, unknown>): WorkflowSpanLink[] {
  const links: WorkflowSpanLink[] = [];
  const fromHeader = parseSpanLink(decodeHeader(headers, SPAN_LINK_HEADER));
  if (fromHeader) links.push(fromHeader);
  for (const arg of args) {
    const found = findTraceLink(arg, 2);
    if (found && !links.some(link => link.traceId === found.traceId && link.spanId === found.spanId)) links.push(found);
  }
  return links;
}

const identifierPattern = /^[A-Za-z0-9:._-]{1,240}$/;

function findIdentifier(value: unknown, keys: readonly string[], depth: number): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && identifierPattern.test(candidate)) return candidate;
  }
  if (depth <= 0) return null;
  for (const key of nestedKeys) {
    const found = findIdentifier(record[key], keys, depth - 1);
    if (found) return found;
  }
  return null;
}

/** Allowlisted room, pane and mission identifiers found in the workflow arguments. */
function correlationAttributes(args: readonly unknown[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  const lookups: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["space.room_id", ["roomId"]],
    ["space.pane_id", ["paneId"]],
    ["space.mission_id", ["missionId", "roomAgentMissionId"]]
  ];
  for (const [attribute, keys] of lookups) {
    for (const arg of args) {
      const found = findIdentifier(arg, keys, 2);
      if (found) { attributes[attribute] = found; break; }
    }
  }
  return attributes;
}

/** The first valid traceparent carried by a child workflow's arguments, if any. */
function childTraceparent(args: readonly unknown[] | undefined): string | null {
  for (const arg of args ?? []) {
    const found = findTraceparent(arg, 2);
    if (found) return found;
  }
  return null;
}

/**
 * Deterministic 16-hex span id per workflow run. Using the run id keeps the
 * value stable across replay, which a random id would not be.
 */
function spanIdFor(runId: string): string {
  const hex = runId.toLowerCase().replace(/[^0-9a-f]/g, "");
  const id = (hex + "0".repeat(16)).slice(0, 16);
  return /^0+$/.test(id) ? `${"0".repeat(15)}1` : id;
}

/**
 * Deterministic root trace for internal workflows (memory maintenance, internal
 * starts) that have no inbound traceparent. Keeps every worker process emitting
 * spans without inventing a random trace on replay.
 */
function rootTraceIdFor(runId: string): string {
  const hex = runId.toLowerCase().replace(/[^0-9a-f]/g, "");
  const id = (hex + "0".repeat(32)).slice(0, 32);
  return /^0+$/.test(id) ? `${"0".repeat(31)}1` : id;
}

function spanName(workflowType: string): string {
  return `workflow ${workflowType}`;
}

function traceHeaders(
  headers: Headers,
  trace: { traceId: string; flags: string },
  spanId: string,
  link: boolean
): Headers {
  return {
    ...headers,
    [TRACEPARENT_HEADER]: defaultPayloadConverter.toPayload(formatTraceparent(trace.traceId, spanId, trace.flags)),
    ...(link ? { [SPAN_LINK_HEADER]: defaultPayloadConverter.toPayload(`${trace.traceId}:${spanId}`) } : {})
  };
}

export const interceptors: WorkflowInterceptorsFactory = () => {
  const info = workflowInfo();
  const spanId = spanIdFor(info.runId);
  let trace: { traceId: string; parentId: string; flags: string } | null = null;
  let links: WorkflowSpanLink[] = [];
  let startedAt = 0;

  return {
    inbound: [{
      execute: async (input, next) => {
        const headers = input.headers as Record<string, unknown>;
        const inbound = parseTraceparent(inboundTraceparent(input.args, headers));
        trace = inbound ?? { traceId: rootTraceIdFor(info.runId), parentId: "", flags: "01" };
        links = inboundLinks(input.args, headers);
        const correlation = correlationAttributes(input.args);
        startedAt = Date.now();
        let status = "COMPLETED";
        try {
          return await next(input);
        } catch (error) {
          const name = (error as { name?: string } | null)?.name ?? "";
          status = /ContinueAsNew/.test(name) ? "CONTINUED" : /Cancel/.test(name) ? "CANCELLED" : "FAILED";
          throw error;
        } finally {
          const finishedAt = Date.now();
          spaceWorkflowTelemetry.span({
            traceId: trace.traceId,
            spanId,
            parentSpanId: inbound?.parentId ?? null,
            name: spanName(info.workflowType),
            startTimeUnixNano: `${BigInt(startedAt) * 1_000_000n}`,
            endTimeUnixNano: `${BigInt(finishedAt) * 1_000_000n}`,
            attributes: {
              "space.workflow_type": info.workflowType,
              "space.workflow_id": info.workflowId,
              "space.run_id": info.runId,
              "space.status": status,
              "space.duration_ms": Math.max(0, finishedAt - startedAt),
              ...correlation
            },
            error: status === "FAILED",
            kind: 1,
            ...(links.length ? { links } : {})
          });
        }
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => {
        if (!trace) return next(input);
        return next({
          ...input,
          headers: traceHeaders(input.headers as Headers, trace, spanId, false)
        });
      },
      startChildWorkflowExecution: (input, next) => {
        if (!trace) return next(input);
        const headers = input.headers as Headers;
        // A supervisor can run turns from different API requests. Keep the
        // turn's own request trace as the child's parent and link the workflow
        // span instead of overwriting the turn context.
        const inherited = childTraceparent(input.options.args);
        const parsed = parseTraceparent(inherited);
        // A background continuation starts a new trace and links to its source.
        const linkOnly = !parsed && (input.options.args ?? []).some(arg => findTraceLink(arg, 2));
        if (linkOnly) {
          return next({
            ...input,
            headers: {
              ...headers,
              [SPAN_LINK_HEADER]: defaultPayloadConverter.toPayload(`${trace.traceId}:${spanId}`)
            }
          });
        }
        if (parsed && parsed.traceId !== trace.traceId) {
          return next({
            ...input,
            headers: {
              ...headers,
              [TRACEPARENT_HEADER]: defaultPayloadConverter.toPayload(inherited as string),
              [SPAN_LINK_HEADER]: defaultPayloadConverter.toPayload(`${trace.traceId}:${spanId}`)
            }
          });
        }
        return next({
          ...input,
          headers: traceHeaders(headers, trace, spanId, false)
        });
      },
      continueAsNew: (input, next) => {
        if (!trace) return next(input);
        // The next run keeps the trace but links back to the run it replaced.
        return next({
          ...input,
          headers: traceHeaders(input.headers as Headers, trace, spanId, true)
        });
      }
    }]
  };
};
