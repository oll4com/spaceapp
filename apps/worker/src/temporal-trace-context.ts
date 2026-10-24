// Leaf entry points keep the workflow sandbox from evaluating every contract schema per workflow.
import { formatTraceparent, parseTraceparent, type ParsedTraceparent } from "@space/contracts/observability";
import type { Headers } from "@temporalio/workflow";

/** Private Temporal headers contain only W3C identifiers, never workflow inputs. */
export const TRACEPARENT_HEADER = "space-traceparent";
export const TRACE_LINK_HEADER = "space-trace-link";

export interface TraceSpanLink {
  traceId: string;
  spanId: string;
}

export type WorkflowTraceOutcome = "COMPLETED" | "FAILED_RESULT" | "FAILED" | "CANCELLED" | "CONTINUED_AS_NEW";

/** Plain, bounded data copied from the workflow isolate to the worker sink. */
export interface WorkflowSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  startTimeMs: number;
  endTimeMs: number;
  outcome: WorkflowTraceOutcome;
  operation?: "mission" | "signal" | "update";
  attributes: Readonly<Record<string, string | number>>;
  links?: readonly TraceSpanLink[];
  reasonCode?: string;
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function decodeHeader(headers: Headers | null | undefined, key: string): ParsedTraceparent | null {
  try {
    const data = headers?.[key]?.data;
    if (!data || data.length > 512) return null;
    let value = "";
    for (const byte of data) {
      if (byte > 127) return null;
      value += String.fromCharCode(byte);
    }
    // Accept both our binary/plain payload and clients using the SDK JSON converter.
    if (value.startsWith('"')) return parseTraceparent(JSON.parse(value));
    return parseTraceparent(value);
  } catch {
    return null;
  }
}

/** Header propagation also reaches activities with positional or no arguments. */
export function decodeActivityTraceContext(headers: Headers | null | undefined): ParsedTraceparent | null {
  return decodeHeader(headers, TRACEPARENT_HEADER) ?? decodeHeader(headers, "traceparent");
}

export function decodeTraceLink(headers: Headers | null | undefined): ParsedTraceparent | null {
  return decodeHeader(headers, TRACE_LINK_HEADER);
}

/** Preserve other interceptors' headers; callers pass the span that actually exists. */
export function encodeTraceHeaders(headers: Headers, parent: ParsedTraceparent, link?: ParsedTraceparent | null): Headers {
  const encoded: Headers = {
    ...headers,
    [TRACEPARENT_HEADER]: {
      metadata: { encoding: ascii("binary/plain") },
      data: ascii(formatTraceparent(parent.traceId, parent.parentId, parent.flags))
    }
  };
  // An incoming continue-as-new link describes this run, not every future child.
  delete encoded[TRACE_LINK_HEADER];
  if (link) {
    encoded[TRACE_LINK_HEADER] = {
      metadata: { encoding: ascii("binary/plain") },
      data: ascii(formatTraceparent(link.traceId, link.parentId, link.flags))
    };
  }
  return encoded;
}

const nestedKeys = ["turn", "item", "bridge", "input", "turnInput"] as const;

function readTraceparent(value: unknown, key: "traceparent" | "continuedTraceparent", depth: number): ParsedTraceparent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const direct = parseTraceparent(record[key]);
  if (direct) return direct;
  if (depth === 0) return null;
  for (const nested of nestedKeys) {
    const found = readTraceparent(record[nested], key, depth - 1);
    if (found) return found;
  }
  return null;
}

export function traceparentFromArgs(args: readonly unknown[]): ParsedTraceparent | null {
  for (const arg of args.slice(0, 8)) {
    const found = readTraceparent(arg, "traceparent", 2);
    if (found) return found;
  }
  return null;
}

export function continuedTraceparentFromArgs(args: readonly unknown[]): ParsedTraceparent | null {
  for (const arg of args.slice(0, 8)) {
    const found = readTraceparent(arg, "continuedTraceparent", 2);
    if (found) return found;
  }
  return null;
}

/** Hash only stable identifiers; do not advance Temporal's application random stream. */
function stableId(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(value.charCodeAt(index))) * 0x100000001b3n);
  }
  return (hash === 0n ? 1n : hash).toString(16).padStart(16, "0");
}

export function deterministicWorkflowSpanId(runId: string, scope = "run"): string {
  return stableId(`space.workflow:${runId}:${scope}`);
}

/** A root or background trace without an API parent still has replay-stable identity. */
export function deterministicWorkflowTraceId(identity: string): string {
  return stableId(`space.trace:0:${identity}`) + stableId(`space.trace:1:${identity}`);
}

const identifierPattern = /^[A-Za-z0-9:._-]{1,200}$/;

export function traceIdentifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value) ? value : null;
}

const correlationKeys = {
  traceId: "space.trace_id",
  spaceTraceId: "space.trace_id",
  requestId: "space.request_id",
  parentSpaceTraceId: "space.request_id",
  roomId: "space.room_id",
  paneId: "space.pane_id",
  missionId: "space.mission_id",
  roomAgentMissionId: "space.mission_id",
  agentRunId: "space.agent_run_id",
  agentSessionId: "space.agent_session_id",
  actionId: "space.action_id",
  goalId: "space.goal_id",
  dotId: "space.dot_id",
  turnId: "space.turn_id",
  cliTaskId: "space.cli_task_id",
  revisionId: "space.revision_id"
} as const;

function readAttributes(value: unknown, into: Record<string, string>, depth: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const [source, target] of Object.entries(correlationKeys)) {
    if (into[target] !== undefined) continue;
    const identifier = traceIdentifier(record[source]);
    if (identifier) into[target] = identifier;
  }
  if (depth === 0) return;
  for (const key of nestedKeys) readAttributes(record[key], into, depth - 1);
}

/** Only named identifier fields are examined; free text is never serialized. */
export function workflowTraceAttributes(args: readonly unknown[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const arg of args.slice(0, 8)) readAttributes(arg, attributes, 2);
  return attributes;
}

/**
 * Background mission identity survives supervisor run rotation. The host can
 * reference this exact span when enqueueing the next background continuation.
 */
export function backgroundMissionTraceContext(input: unknown): ParsedTraceparent | null {
  const attributes = workflowTraceAttributes([input]);
  const traceId = attributes["space.trace_id"];
  if (!traceId?.startsWith("trace:bg-")) return null;
  const identity = attributes["space.agent_run_id"] ?? traceId;
  return {
    traceId: deterministicWorkflowTraceId(`background:${identity}`),
    parentId: deterministicWorkflowSpanId(identity, "background-mission"),
    flags: continuedTraceparentFromArgs([input])?.flags ?? "01"
  };
}

/**
 * Space correlation values are generated identifiers shaped `<kind>:<token>`
 * (for example `room:V1StGXR8_Z5j` or `trace:bg-<uuid>`). Exported spans accept
 * only that shape, so text, file names, paths and URLs placed in an identifier
 * field are dropped. This narrows, but cannot prove, where a value came from.
 */
const correlationIdentifierPattern = /^[a-z][a-z0-9_]{0,63}:[A-Za-z0-9_-]{1,128}(?::[A-Za-z0-9_-]{1,128}){0,3}$/;

export function correlationIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length <= 200 && correlationIdentifierPattern.test(value) ? value : null;
}

const correlationAttributeKeys = new Set<string>(Object.values(correlationKeys));
const operationNameKeys = ["space.signal_name", "space.update_name"] as const;

/** Apply the allowlist again, with the stricter identifier shape, at the host-side export boundary. */
export function sanitizeWorkflowTraceAttributes(attributes: Readonly<Record<string, unknown>>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of correlationAttributeKeys) {
    const identifier = correlationIdentifier(attributes[key]);
    if (identifier) safe[key] = identifier;
  }
  for (const key of operationNameKeys) {
    const name = traceIdentifier(attributes[key]);
    if (name) safe[key] = name;
  }
  return safe;
}
