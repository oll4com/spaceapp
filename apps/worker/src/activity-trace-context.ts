import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkflowTraceReference } from "@space/contracts";

/** The parent workflow span, available while recording a durable turn outcome. */
export const activityWorkflowTrace = new AsyncLocalStorage<WorkflowTraceReference | undefined>();
/** The activity's own exported span, for outbound HTTP traceparent headers. */
export const activitySpanTrace = new AsyncLocalStorage<WorkflowTraceReference | undefined>();
