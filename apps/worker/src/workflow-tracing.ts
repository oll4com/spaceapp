import {
  ContinueAsNew,
  isCancellation,
  patched,
  proxySinks,
  workflowInfo,
  type Headers,
  type WorkflowInterceptors
} from "@temporalio/workflow";
import {
  WORKFLOW_TRACE_CONTEXT_HEADER,
  encodeTraceContextHeader,
  mergeTraceLinks,
  readTraceContextHeaders,
  safeTraceIdentifier,
  sanitizeTraceAttributes,
  traceContextFromArgs,
  traceContextFromMemo,
  traceCorrelationAttributes,
  traceLinksFromArgs,
  workflowSpanId,
  workflowTraceId,
  type SpaceTraceContext,
  type SpaceTraceLink,
  type SpaceTracingSinks
} from "./workflow-trace-context.js";

// Keep this gate while pre-tracing histories can still replay on these workers.
const tracingPatch = "space-worker-tracing-v1";

/**
 * Runs entirely in Temporal's deterministic sandbox. The host registers the
 * replay-suppressed sink; only the host can export or access the network.
 */
export function interceptors(): WorkflowInterceptors {
  const { spaceTracing } = proxySinks<SpaceTracingSinks>();
  let current: SpaceTraceContext | null = null;
  let requestParent: SpaceTraceLink | null = null;

  const headersWithContext = (headers: Headers, context: SpaceTraceContext, origin = requestParent): Headers => ({
    ...headers,
    [WORKFLOW_TRACE_CONTEXT_HEADER]: encodeTraceContextHeader({ ...context, ...(origin ? { requestParent: origin } : {}) })
  });

  return {
    inbound: [{
      async execute(input, next) {
        // An old run has no marker and must emit its original commands. This
        // also avoids taking an RNG draw that would shift business UUIDs.
        if (!patched(tracingPatch)) return next(input);
        const info = workflowInfo();
        const headerParent = readTraceContextHeaders(input.headers);
        const argsParent = traceContextFromArgs(input.args);
        const memoParent = traceContextFromMemo(info.memo);
        const parent = headerParent ?? argsParent ?? memoParent;
        // Preserve the API origin separately: a child's structural parent is
        // a workflow span, while its arguments can retain the same API span.
        // The header also keeps that origin across args-free continue-as-new.
        requestParent = headerParent?.requestParent ?? argsParent ?? memoParent ?? parent;
        current = {
          traceId: parent?.traceId ?? workflowTraceId(info.runId),
          spanId: workflowSpanId(info.runId),
          flags: parent?.flags ?? 1
        };
        const context = current;
        const links = mergeTraceLinks(parent?.links, traceLinksFromArgs(input.args));
        const startedAt = info.runStartTime.getTime();
        const workflowType = safeTraceIdentifier(info.workflowType) ?? "unknown";
        const attributes: Record<string, string | number> = {
          ...traceCorrelationAttributes(input.args, info.memo),
          workflowType,
          w3cTraceId: context.traceId
        };
        for (const key of ["workflowId", "runId", "taskQueue"] as const) {
          const value = safeTraceIdentifier(info[key]);
          if (value) attributes[key] = value;
        }
        let outcome = "COMPLETED";
        let error = false;
        try {
          const result = await next(input);
          if (result && typeof result === "object" && (result as { status?: unknown }).status === "FAILED") {
            outcome = "FAILED_RESULT";
            error = true;
          }
          return result;
        } catch (cause) {
          if (cause instanceof ContinueAsNew) outcome = "CONTINUED_AS_NEW";
          else if (isCancellation(cause)) outcome = "CANCELLED";
          else { outcome = "FAILED"; error = true; }
          throw cause;
        } finally {
          // Inspect replay state only for telemetry, never for commands. The
          // host's callDuringReplay:false is an additional suppression layer.
          if (!workflowInfo().unsafe.isReplaying) {
            try {
              spaceTracing.exportSpan({
                ...context,
                parentSpanId: parent?.spanId ?? null,
                name: `temporal.workflow.${workflowType}`,
                startTimeUnixNano: (BigInt(startedAt) * 1_000_000n).toString(),
                endTimeUnixNano: (BigInt(Math.max(startedAt, Date.now())) * 1_000_000n).toString(),
                attributes: sanitizeTraceAttributes({ ...attributes, outcome }),
                error,
                ...(links.length ? { links } : {})
              });
            } catch {
              // Telemetry must not replace a result, failure or ContinueAsNew.
            }
          }
        }
      }
    }],
    outbound: [{
      scheduleActivity(input, next) {
        return next(current ? { ...input, headers: headersWithContext(input.headers, current) } : input);
      },
      scheduleLocalActivity(input, next) {
        return next(current ? { ...input, headers: headersWithContext(input.headers, current) } : input);
      },
      startChildWorkflowExecution(input, next) {
        if (!current) return next(input);
        const args = input.options.args ?? [];
        const requestedParent = traceContextFromArgs(args);
        // A long-lived room supervisor also starts turns from later API
        // requests, including SERVER spans within the same distributed trace.
        // Compare the full original API identity, not the workflow's span ID.
        const differentRequest = requestedParent && (!requestParent
          || requestedParent.traceId !== requestParent.traceId || requestedParent.spanId !== requestParent.spanId);
        const parent = differentRequest ? requestedParent : current;
        const links = mergeTraceLinks(traceLinksFromArgs(args), differentRequest ? [current] : undefined);
        return next({
          ...input,
          headers: headersWithContext(input.headers, { ...parent, ...(links.length ? { links } : {}) }, differentRequest ? requestedParent : requestParent)
        });
      },
      continueAsNew(input, next) {
        if (!current) return next(input);
        // The next run's parent and link both name this actual exported run
        // span. No placeholder span or process-local registry is involved.
        return next({ ...input, headers: headersWithContext(input.headers, { ...current, links: [current] }) });
      }
    }]
  };
}
