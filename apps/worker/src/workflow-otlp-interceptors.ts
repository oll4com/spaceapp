/**
 * Replay-safe Temporal workflow trace bridge.
 *
 * The workflow isolate never performs network I/O. Its only side effect is a
 * Temporal sink, registered with callDuringReplay:false by each real worker.
 */
import {
  ContinueAsNew, defaultPayloadConverter, proxySinks, workflowInfo,
  type WorkflowInterceptors, type WorkflowInboundCallsInterceptor,
  type WorkflowOutboundCallsInterceptor, type Sinks
} from "@temporalio/workflow";
import type { Headers } from "@temporalio/common";
import { formatTraceparent, parseTraceparent } from "@space/contracts";

export const TRACE_HEADER = "space-otlp-traceparent";

export interface WorkflowTraceReport {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  workflowType: string;
  workflowId: string;
  runId: string;
  startMs: number;
  endMs: number;
  error: boolean;
  continuedFromRunId?: string;
  /** Link to a predecessor's W3C context when a new background trace starts. */
  links?: ReadonlyArray<{ traceId: string; spanId: string }>;
}

interface WorkflowTraceSinks extends Sinks {
  spaceOtlp: { finished(report: WorkflowTraceReport): void };
}

/** A stable nonzero span ID from Temporal's randomly assigned workflow run UUID. */
export function workflowRunSpanId(runId: string): string {
  const hex = runId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return "0000000000000001";
  const id = hex.slice(-16);
  return /^0{16}$/.test(id) ? "0000000000000001" : id;
}

/**
 * A repeatable W3C trace identifier for Temporal-only roots, which have no
 * originating API traceparent. Use a domain-separated 128-bit FNV-style mix
 * of the public workflow ID, never user text or a random value that changes
 * on a workflow replay or continue-as-new run.
 */
export function workflowRootTraceId(workflowId: string): string {
  const mask = (1n << 64n) - 1n;
  const hash = (seed: bigint) => {
    let state = seed;
    for (let i = 0; i < workflowId.length; i++) {
      state = ((state ^ BigInt(workflowId.charCodeAt(i))) * 0x100000001b3n) & mask;
    }
    return state.toString(16).padStart(16, "0");
  };
  const id = hash(0xcbf29ce484222325n) + hash(0x84222325cbf29cen);
  return /^0+$/.test(id) ? "00000000000000000000000000000001" : id;
}

function headerTrace(headers: Headers): string | null {
  const encoded = headers[TRACE_HEADER];
  if (!encoded) return null;
  try {
    const value = defaultPayloadConverter.fromPayload(encoded);
    return typeof value === "string" && parseTraceparent(value) ? value : null;
  } catch {
    return null;
  }
}

/** Never descend into prompt/content fields. Read only named, bounded context. */
function argTrace(args: readonly unknown[]): string | null {
  for (const value of args) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const o = value as Record<string, unknown>;
    if (typeof o.traceparent === "string" && parseTraceparent(o.traceparent)) return o.traceparent;
    for (const nested of ["turn", "item", "input"] as const) {
      const n = o[nested];
      if (!n || typeof n !== "object" || Array.isArray(n)) continue;
      const v = (n as Record<string, unknown>).traceparent;
      if (typeof v === "string" && parseTraceparent(v)) return v;
    }
  }
  return null;
}

function backgroundTraceLink(args: readonly unknown[]): { traceId: string; spanId: string } | null {
  for (const arg of args) {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;
    const outer = arg as Record<string, unknown>;
    const turn = outer.turn && typeof outer.turn === "object" && !Array.isArray(outer.turn)
      ? outer.turn as Record<string, unknown> : outer;
    const continuation = turn.roomAgentContinuation;
    if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) continue;
    const parent = parseTraceparent((continuation as Record<string, unknown>).sourceTraceparent);
    if (parent) return { traceId: parent.traceId, spanId: parent.parentId };
  }
  return null;
}

export function interceptors(): WorkflowInterceptors {
  const { spaceOtlp } = proxySinks<WorkflowTraceSinks>();
  let outgoingTrace: string | null = null;
  const inbound: WorkflowInboundCallsInterceptor = {
    async execute(input, next) {
      const original = headerTrace(input.headers) ?? argTrace(input.args);
      const parent = parseTraceparent(original);
      const info = workflowInfo();
      const spanId = workflowRunSpanId(info.runId);
      // Traced HTTP requests keep their original W3C ancestry. Long-lived
      // worker roots started by Temporal itself get an independent stable
      // trace instead of silently losing all workflow/activity spans.
      const traceId = parent?.traceId ?? workflowRootTraceId(info.workflowId);
      outgoingTrace = formatTraceparent(traceId, spanId, parent?.flags ?? "01");
      const startMs = Date.now();
      let error = false;
      try {
        return await next(input);
      } catch (cause) {
        error = !(cause instanceof ContinueAsNew);
        throw cause;
      } finally {
        spaceOtlp.finished({
          traceId, spanId, parentSpanId: parent?.parentId ?? null,
          workflowType: info.workflowType, workflowId: info.workflowId,
          runId: info.runId, startMs, endMs: Date.now(), error,
          continuedFromRunId: info.continuedFromExecutionRunId,
          ...(backgroundTraceLink(input.args) ? { links: [backgroundTraceLink(input.args)!] } : {})
        });
      }
    }
  };
  const withTrace = (headers: Headers): Headers => {
    if (!outgoingTrace) return headers;
    const payload = defaultPayloadConverter.toPayload(outgoingTrace);
    return payload ? { ...headers, [TRACE_HEADER]: payload } : headers;
  };
  const outbound: WorkflowOutboundCallsInterceptor = {
    scheduleActivity: (input, next) => next({ ...input, headers: withTrace(input.headers) }),
    scheduleLocalActivity: (input, next) => next({ ...input, headers: withTrace(input.headers) }),
    startChildWorkflowExecution: (input, next) => next({ ...input, headers: withTrace(input.headers) }),
    continueAsNew: (input, next) => next({ ...input, headers: withTrace(input.headers) })
  };
  return { inbound: [inbound], outbound: [outbound] };
}
