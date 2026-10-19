/**
 * Temporal header names shared by the workflow tracing interceptors (sandbox)
 * and the activity interceptor (worker process). Both carry W3C traceparents
 * only, never data.
 */

/** The span that work started from a workflow nests under. */
export const TRACEPARENT_HEADER = "space-traceparent";
/** Set on continue-as-new: the span of the run that finished. */
export const LINK_TRACEPARENT_HEADER = "space-link-traceparent";
