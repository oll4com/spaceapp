import {
  defaultPayloadConverter,
  proxySinks,
  uuid4,
  workflowInfo,
  type ActivityInput,
  type ContinueAsNewInput,
  type StartChildWorkflowExecutionInput,
  type WorkflowExecuteInput,
  type WorkflowInboundCallsInterceptor,
  type WorkflowInterceptors,
  type WorkflowOutboundCallsInterceptor
} from "@temporalio/workflow";
import { formatTraceparent, parseTraceparent, type ParsedTraceparent } from "@space/contracts";
import type { WorkflowTraceSinks } from "./workflow-sinks.js";

const { trace } = proxySinks<WorkflowTraceSinks>();

interface ActiveTraceContext {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
}

export class TracingWorkflowInboundInterceptor implements WorkflowInboundCallsInterceptor {
  private activeContext: ActiveTraceContext | null = null;

  getActiveContext(): ActiveTraceContext | null {
    return this.activeContext;
  }

  async execute(input: WorkflowExecuteInput, next: (input: WorkflowExecuteInput) => Promise<unknown>): Promise<unknown> {
    const info = workflowInfo();
    const startedAtMs = info.runStartTime.getTime();

    let parentParsed: ParsedTraceparent | null = null;

    if (input.headers.traceparent) {
      try {
        const raw = defaultPayloadConverter.fromPayload(input.headers.traceparent);
        parentParsed = parseTraceparent(raw);
      } catch {}
    }

    if (!parentParsed && typeof info.memo?.traceparent === "string") {
      parentParsed = parseTraceparent(info.memo.traceparent);
    }

    if (!parentParsed && input.args[0] && typeof input.args[0] === "object") {
      const arg = input.args[0] as Record<string, unknown>;
      const candidate = arg.traceparent ?? (arg.turn as Record<string, unknown> | undefined)?.traceparent ?? (arg.bridge as Record<string, unknown> | undefined)?.traceparent;
      if (typeof candidate === "string") {
        parentParsed = parseTraceparent(candidate);
      }
    }

    if (!parentParsed && input.headers.continuationTraceparent) {
      try {
        const raw = defaultPayloadConverter.fromPayload(input.headers.continuationTraceparent);
        parentParsed = parseTraceparent(raw);
      } catch {}
    }

    if (parentParsed) {
      const workflowSpanId = uuid4().replace(/-/g, "").slice(0, 16);
      this.activeContext = {
        traceId: parentParsed.traceId,
        spanId: workflowSpanId,
        parentSpanId: parentParsed.parentId
      };

      trace.recordWorkflowStart({
        traceId: this.activeContext.traceId,
        spanId: this.activeContext.spanId,
        parentSpanId: this.activeContext.parentSpanId,
        workflowType: info.workflowType,
        workflowId: info.workflowId,
        runId: info.runId,
        startedAtMs
      });
    }

    try {
      const result = await next(input);
      if (this.activeContext) {
        trace.recordWorkflowSpan({
          ...this.activeContext,
          workflowType: info.workflowType,
          workflowId: info.workflowId,
          runId: info.runId,
          startedAtMs,
          endedAtMs: Date.now(),
          status: "COMPLETED"
        });
      }
      return result;
    } catch (error) {
      if (this.activeContext) {
        trace.recordWorkflowSpan({
          ...this.activeContext,
          workflowType: info.workflowType,
          workflowId: info.workflowId,
          runId: info.runId,
          startedAtMs,
          endedAtMs: Date.now(),
          status: "FAILED",
          errorName: error instanceof Error ? error.name : "WorkflowError"
        });
      }
      throw error;
    }
  }
}

export class TracingWorkflowOutboundInterceptor implements WorkflowOutboundCallsInterceptor {
  constructor(private readonly inbound: TracingWorkflowInboundInterceptor) {}

  scheduleActivity(input: ActivityInput, next: (input: ActivityInput) => Promise<unknown>): Promise<unknown> {
    const ctx = this.inbound.getActiveContext();
    if (ctx) {
      const traceparent = formatTraceparent(ctx.traceId, ctx.spanId);
      const headers = {
        ...input.headers,
        traceparent: defaultPayloadConverter.toPayload(traceparent)
      };
      return next({ ...input, headers });
    }
    return next(input);
  }

  startChildWorkflowExecution(
    input: StartChildWorkflowExecutionInput,
    next: (input: StartChildWorkflowExecutionInput) => Promise<[Promise<string>, Promise<unknown>]>
  ): Promise<[Promise<string>, Promise<unknown>]> {
    const ctx = this.inbound.getActiveContext();
    if (ctx) {
      const traceparent = formatTraceparent(ctx.traceId, ctx.spanId);
      const headers = {
        ...input.headers,
        traceparent: defaultPayloadConverter.toPayload(traceparent)
      };
      return next({ ...input, headers });
    }
    return next(input);
  }

  continueAsNew(input: ContinueAsNewInput, next: (input: ContinueAsNewInput) => Promise<never>): Promise<never> {
    const ctx = this.inbound.getActiveContext();
    if (ctx) {
      const traceparent = formatTraceparent(ctx.traceId, ctx.spanId);
      const headers = {
        ...input.headers,
        continuationTraceparent: defaultPayloadConverter.toPayload(traceparent)
      };
      return next({ ...input, headers });
    }
    return next(input);
  }
}

export function interceptors(): WorkflowInterceptors {
  const inbound = new TracingWorkflowInboundInterceptor();
  const outbound = new TracingWorkflowOutboundInterceptor(inbound);
  return {
    inbound: [inbound],
    outbound: [outbound]
  };
}
