import {
  AsyncLocalStorage,
  ContinueAsNew,
  isCancellation,
  proxySinks,
  TemporalFailure,
  workflowInfo,
  type Headers,
  type Sinks,
  type WorkflowInfo,
  type WorkflowInterceptors
} from "@temporalio/workflow";
import { isSafeErrorCode, type ParsedTraceparent } from "@space/contracts/observability";
import { ROOM_AGENT_SUPERVISOR_WORKFLOW_TYPE } from "@space/contracts/workflows";
import {
  backgroundMissionTraceContext,
  continuedTraceparentFromArgs,
  decodeActivityTraceContext,
  decodeTraceLink,
  deterministicWorkflowSpanId,
  deterministicWorkflowTraceId,
  encodeTraceHeaders,
  traceIdentifier,
  traceparentFromArgs,
  workflowTraceAttributes,
  type TraceSpanLink,
  type WorkflowSpanRecord,
  type WorkflowTraceOutcome
} from "./temporal-trace-context.js";

export interface WorkflowTracingSinks extends Sinks {
  spaceTracing: {
    record(span: WorkflowSpanRecord): void;
  };
}

interface TraceScope {
  context: ParsedTraceparent;
  parentSpanId: string | null;
  startTimeMs: number;
  operation?: WorkflowSpanRecord["operation"];
  attributes: Record<string, string>;
  links: TraceSpanLink[];
  /** A background mission's span identity is stable, so a paused pass must not export it. */
  stableIdentity?: boolean;
}

const scopes = new AsyncLocalStorage<TraceScope>();
const { spaceTracing } = proxySinks<WorkflowTracingSinks>();
let runScope: TraceScope | null = null;
let runInfo: WorkflowInfo | null = null;
let scopeSequence = 0;
// First start of each stable background span still waiting to be exported in this run.
let pendingStableStarts = new Map<string, number>();

/**
 * A supervisor serves many requests. Its run roots its own trace and only
 * links to the request that started it, so run-level work (monitoring polls,
 * signals and missions without context) never joins that first request's
 * trace. Each mission keeps its own request parent; continued runs (which
 * carry the link header) stay children of the preceding run.
 */
const requestIndependentWorkflowTypes = new Set<string>([ROOM_AGENT_SUPERVISOR_WORKFLOW_TYPE]);

function addLink(scope: TraceScope, context: ParsedTraceparent | null | undefined): void {
  if (!context || scope.links.length >= 16) return;
  if (context.traceId === scope.context.traceId && context.parentId === scope.context.parentId) return;
  if (scope.links.some((link) => link.traceId === context.traceId && link.spanId === context.parentId)) return;
  scope.links.push({ traceId: context.traceId, spanId: context.parentId });
}

function currentScope(): TraceScope | null {
  return scopes.getStore() ?? runScope;
}

function failureCode(error: unknown): string {
  let cause = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth += 1) {
    const record = cause as { code?: unknown; type?: unknown; name?: unknown; cause?: unknown };
    if (isSafeErrorCode(record.code)) return record.code as string;
    if (isSafeErrorCode(record.type)) return record.type as string;
    if (record.name === "TimeoutFailure") return "WORKFLOW_TIMEOUT";
    cause = record.cause;
  }
  return "WORKFLOW_ERROR";
}

function record(scope: TraceScope, outcome: WorkflowTraceOutcome, reasonCode?: string): void {
  try {
    spaceTracing.record({
      traceId: scope.context.traceId,
      spanId: scope.context.parentId,
      parentSpanId: scope.parentSpanId,
      startTimeMs: scope.startTimeMs,
      endTimeMs: Math.max(scope.startTimeMs, Date.now()),
      outcome,
      operation: scope.operation,
      attributes: scope.attributes,
      links: scope.links,
      reasonCode
    });
  } catch {
    // Sink/serialization failures must not replace a workflow's result or error.
  }
}

/**
 * `sdkEntry` marks the workflow function and signal/update handlers: a
 * non-Temporal error thrown there fails the workflow task (Temporal retries it),
 * so no completed span exists yet. Mission callbacks may have their errors caught.
 */
async function observe<T>(scope: TraceScope, execute: () => Promise<T>, sdkEntry = false): Promise<T> {
  let outcome: WorkflowTraceOutcome = "COMPLETED";
  let reasonCode: string | undefined;
  let invoked = false;
  let taskFailure = false;
  let paused = false;
  try {
    let result: T;
    try {
      result = await scopes.run(scope, () => {
        invoked = true;
        return execute();
      });
    } catch (error) {
      // An instrumentation setup failure still executes application code exactly once.
      if (invoked) throw error;
      result = await execute();
    }
    try {
      if (result && typeof result === "object") {
        const status = (result as { status?: unknown }).status;
        if (status === "FAILED") {
          outcome = "FAILED_RESULT";
          reasonCode = "WORKFLOW_FAILED_RESULT";
        } else if (status === "CANCELLED" || status === "INTERRUPTED") {
          outcome = "CANCELLED";
          reasonCode = "WORKFLOW_CANCELLED";
        } else if (status === "PAUSED") {
          paused = true;
        }
      }
    } catch {}
    return result;
  } catch (error) {
    try {
      if (error instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
      else if (isCancellation(error)) {
        outcome = "CANCELLED";
        reasonCode = "WORKFLOW_CANCELLED";
      } else if (sdkEntry && !(error instanceof TemporalFailure)) {
        // A non-Temporal error fails the workflow task, which Temporal retries;
        // the execution is still running, so no completed span exists yet.
        taskFailure = true;
      } else {
        outcome = "FAILED";
        reasonCode = failureCode(error);
      }
    } catch {
      outcome = "FAILED";
      reasonCode = "WORKFLOW_ERROR";
    }
    throw error;
  } finally {
    // A paused background mission is requeued under the same stable span identity:
    // export that span once, from the pass that finishes the mission.
    if (!taskFailure && !(paused && scope.stableIdentity)) {
      record(scope, outcome, reasonCode);
      if (scope.stableIdentity) pendingStableStarts.delete(scope.context.parentId);
    }
  }
}

function makeOperationScope(
  args: readonly unknown[],
  operation: NonNullable<WorkflowSpanRecord["operation"]>,
  headers?: Headers
): TraceScope | null {
  if (!runInfo || !runScope) return null;
  const enclosing = currentScope() ?? runScope;
  const incoming = decodeActivityTraceContext(headers) ?? traceparentFromArgs(args);
  const continued = decodeTraceLink(headers) ?? continuedTraceparentFromArgs(args);
  const background = operation === "mission" ? backgroundMissionTraceContext(args[0]) : null;
  // A background mission always roots its own trace. A legacy queued item may
  // still carry its source request's traceparent: keep that as a link only.
  const parent = background ? null : incoming ?? (continued ? null : enclosing.context);
  scopeSequence += 1;
  const context = background ?? {
    traceId: parent?.traceId ?? deterministicWorkflowTraceId(`${runInfo.runId}:${operation}:${scopeSequence}`),
    parentId: deterministicWorkflowSpanId(runInfo.runId, `${operation}:${scopeSequence}`),
    flags: parent?.flags ?? continued?.flags ?? "01"
  };
  // A stable background span covers every pass of its mission in this run.
  const startTimeMs = (background && pendingStableStarts.get(context.parentId)) || Date.now();
  if (background) pendingStableStarts.set(context.parentId, startTimeMs);
  const scope: TraceScope = {
    context,
    parentSpanId: parent?.parentId ?? null,
    startTimeMs,
    operation,
    attributes: workflowTraceAttributes(args),
    links: [],
    stableIdentity: background !== null
  };
  addLink(scope, continued);
  if (background) addLink(scope, incoming);
  if (parent?.parentId !== enclosing.context.parentId || parent?.traceId !== enclosing.context.traceId) {
    addLink(scope, enclosing.context);
  }
  return scope;
}

/**
 * A supervisor outlives the requests delivered through its signals. Give each
 * queued mission its own completed span and asynchronous propagation scope.
 * Importing this helper with tracing disabled adds no headers or sink calls.
 */
export async function withWorkflowTraceContext<T>(input: unknown, execute: () => Promise<T>): Promise<T> {
  let scope: TraceScope | null = null;
  try { scope = makeOperationScope([input], "mission"); } catch {}
  return scope ? observe(scope, execute) : execute();
}

function propagate<T extends { headers: Headers }>(input: T, continueRun = false): T {
  try {
    const scope = currentScope();
    if (scope) {
      return { ...input, headers: encodeTraceHeaders(input.headers, scope.context, continueRun ? runScope?.context : null) };
    }
  } catch {}
  return input;
}

/** Loaded only by an enabled worker's workflowModules; contains no host I/O. */
export function interceptors(): WorkflowInterceptors {
  runScope = null;
  runInfo = null;
  scopeSequence = 0;
  pendingStableStarts = new Map();
  return {
    inbound: [{
      async execute(input, next) {
        let scope: TraceScope | null = null;
        try {
          const info = workflowInfo();
          const incoming = decodeActivityTraceContext(input.headers)
            ?? traceparentFromArgs(input.args)
            ?? traceparentFromArgs([info.memo]);
          const continued = decodeTraceLink(input.headers) ?? continuedTraceparentFromArgs(input.args);
          const detached = requestIndependentWorkflowTypes.has(info.workflowType) && !decodeTraceLink(input.headers);
          const parent = detached ? null : incoming;
          scope = {
            context: {
              traceId: parent?.traceId ?? deterministicWorkflowTraceId(info.firstExecutionRunId),
              parentId: deterministicWorkflowSpanId(info.runId),
              flags: parent?.flags ?? incoming?.flags ?? continued?.flags ?? "01"
            },
            parentSpanId: parent?.parentId ?? null,
            startTimeMs: info.runStartTime.getTime(),
            // The starting request's memo ids describe one mission, not the supervisor.
            attributes: detached ? workflowTraceAttributes(input.args)
              : { ...workflowTraceAttributes([info.memo]), ...workflowTraceAttributes(input.args) },
            links: []
          };
          addLink(scope, continued);
          if (detached) addLink(scope, incoming);
          if (!continued && info.continuedFromExecutionRunId) {
            addLink(scope, {
              traceId: scope.context.traceId,
              parentId: deterministicWorkflowSpanId(info.continuedFromExecutionRunId),
              flags: scope.context.flags
            });
          }
          runInfo = info;
          runScope = scope;
        } catch {}
        return scope ? observe(scope, () => next(input), true) : next(input);
      },
      async handleSignal(input, next) {
        let scope: TraceScope | null = null;
        try {
          scope = makeOperationScope(input.args, "signal", input.headers);
          const name = traceIdentifier(input.signalName);
          if (scope && name) scope.attributes["space.signal_name"] = name;
        } catch {}
        return scope ? observe(scope, () => next(input), true) : next(input);
      },
      async handleUpdate(input, next) {
        let scope: TraceScope | null = null;
        try {
          scope = makeOperationScope(input.args, "update", input.headers);
          const name = traceIdentifier(input.name);
          if (scope && name) scope.attributes["space.update_name"] = name;
        } catch {}
        return scope ? observe(scope, () => next(input), true) : next(input);
      }
    }],
    outbound: [{
      scheduleActivity: (input, next) => next(propagate(input)),
      scheduleLocalActivity: (input, next) => next(propagate(input)),
      startChildWorkflowExecution: (input, next) => next(propagate(input)),
      signalWorkflow: (input, next) => next(propagate(input)),
      continueAsNew: (input, next) => next(propagate(input, true))
    }]
  };
}
