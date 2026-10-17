import {
  ContinueAsNew, TemporalFailure, isCancellation, patched, proxySinks, workflowInfo,
  type WorkflowInterceptors, type Sinks
} from "@temporalio/workflow";
import {
  parentFromArgs, parseParent, readTraceHeader, safeTraceAttributes, stableSpanId,
  writeTraceHeader, type TraceContext, type TraceRecord
} from "./tracing-protocol.js";

export interface TraceSinks extends Sinks { spaceTracing: { record(span: TraceRecord): void } }

/** Always install this interceptor, including when the host exporter is off. */
export function interceptors(): WorkflowInterceptors {
  const sink = proxySinks<TraceSinks>().spaceTracing;
  let active: TraceContext | null = null;
  let enabled = false;
  let continued = false;
  const scopes = new Map<string, { context: TraceContext; parent: TraceContext; startedAt: number; finished: boolean }>();
  const missions = new Map<string, TraceContext>();
  const missionFrom = (args: readonly unknown[], depth = 3): string | null => {
    for (const arg of args) {
      if (!arg || typeof arg !== "object" || Array.isArray(arg)) continue;
      const value = arg as Record<string, unknown>;
      const id = value.roomAgentMissionId ?? value.missionId;
      if (typeof id === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(id)) return id;
      if (depth > 0) {
        const nested = missionFrom([value.turn, value.item, value.input], depth - 1);
        if (nested) return nested;
      }
    }
    return null;
  };
  const scopeFor = (args: readonly unknown[]) => {
    if (!active || !enabled || workflowInfo().workflowType !== "roomAgentSupervisorWorkflow") return active;
    const parent = parentFromArgs(args);
    const mission = missionFrom(args);
    if (!parent) return (mission ? missions.get(mission) : null) ?? active;
    const key = parent.traceId + parent.spanId;
    let scope = scopes.get(key);
    if (!scope) {
      scope = { context: { traceId: parent.traceId, spanId: stableSpanId(workflowInfo().runId + ":request:" + key) },
        parent, startedAt: Date.now(), finished: false };
      scopes.set(key, scope);
      // Only finished scopes may be evicted. Unfinished work remains traceable.
      if (scopes.size > 256) for (const [oldKey, old] of scopes) {
        if (old.finished && oldKey !== key) { scopes.delete(oldKey); break; }
      }
    }
    if (mission) {
      missions.set(mission, scope.context);
      if (missions.size > 256) missions.delete(missions.keys().next().value!);
    }
    return scope.context;
  };
  return {
    inbound: [{
      async execute(input, next) {
        enabled = patched("space-otlp-workflow-v1");
        if (!enabled) return next(input);
        const info = workflowInfo();
        const parent: TraceContext | null = readTraceHeader(input.headers) ?? parseParent(info.memo?.traceparent) ?? parentFromArgs(input.args);
        // Work without an inbound trace still gets a stable root, not a random stream side effect.
        const traceId = parent?.traceId ?? stableSpanId(info.runId + ":trace:a") + stableSpanId(info.runId + ":trace:b");
        active = { traceId, spanId: stableSpanId(info.runId + ":workflow"), links: parent?.links ?? [] };
        const startedAt = info.startTime.getTime();
        let outcome = "COMPLETED";
        let terminal = true;
        try { return await next(input); }
        catch (error) {
          outcome = error instanceof ContinueAsNew ? "CONTINUED_AS_NEW" : isCancellation(error) ? "CANCELLED" : "FAILED";
          terminal = error instanceof ContinueAsNew || error instanceof TemporalFailure;
          throw error;
        } finally {
          // Ordinary workflow-task failures may retry. Emit terminal results only.
          if (terminal) {
            sink.record({ ...active, parentSpanId: parent?.root ? null : parent?.spanId ?? null,
              name: `workflow ${info.workflowType}`, startedAt, endedAt: Date.now(),
              attributes: safeTraceAttributes({ "space.workflow_type": info.workflowType,
                "space.workflow_id": info.workflowId, "space.run_id": info.runId,
                "space.outcome": continued ? "CONTINUED_AS_NEW" : outcome }), error: outcome === "FAILED" });
          }
        }
      },
      async handleSignal(input, next) {
        scopeFor(input.args);
        return next(input);
      }
    }],
    outbound: [{
      scheduleActivity(input, next) {
        const context = scopeFor(input.args);
        return next(context && enabled ? { ...input, headers: writeTraceHeader(input.headers, { traceId: context.traceId, spanId: context.spanId }) } : input);
      },
      scheduleLocalActivity(input, next) {
        return next(active && enabled ? { ...input, headers: writeTraceHeader(input.headers, { traceId: active.traceId, spanId: active.spanId }) } : input);
      },
      async startChildWorkflowExecution(input, next) {
        const requested = parentFromArgs(input.options.args ?? []);
        const context = scopeFor(input.options.args ?? []);
        if (context && active && context !== active) {
          const result = await next({ ...input, headers: writeTraceHeader(input.headers, context) });
          const scope = requested ? scopes.get(requested.traceId + requested.spanId) : null;
          if (scope) {
            const finish = (error: boolean) => {
              if (scope.finished) return;
              scope.finished = true;
              sink.record({ ...scope.context, parentSpanId: scope.parent.root ? null : scope.parent.spanId,
                links: [...(scope.parent.links ?? []), { traceId: active!.traceId, spanId: active!.spanId }],
                name: "workflow roomAgentSupervisorWorkflow request", startedAt: scope.startedAt, endedAt: Date.now(),
                attributes: safeTraceAttributes({ "space.workflow_type": "roomAgentSupervisorWorkflow",
                  "space.workflow_id": workflowInfo().workflowId, "space.run_id": workflowInfo().runId,
                  "space.outcome": error ? "FAILED" : "COMPLETED" }), error });
            };
            return [result[0], result[1].then(value => { finish(false); return value; }, error => { finish(true); throw error; })];
          }
          return result;
        }
        if (enabled && requested?.root) {
          return next({ ...input, headers: writeTraceHeader(input.headers, requested) });
        }
        return next(active && enabled ? { ...input, headers: writeTraceHeader(input.headers, { traceId: active.traceId, spanId: active.spanId }) } : input);
      },
      continueAsNew(input, next) {
        continued = true;
        if (!active || !enabled) return next(input);
        // The next run links to the completed run instead of treating it as its parent.
        return next({ ...input, headers: writeTraceHeader(input.headers, {
          ...active, root: true, links: [{ traceId: active.traceId, spanId: active.spanId }]
        }) });
      }
    }]
  };
}
