// This subpath has no Node imports or exporter timers and is safe in a workflow bundle.
export { SPAN_ATTRIBUTE_ALLOWLIST, allowlistSpanAttributes } from "@space/runtime/span-attributes";
export { parseTraceparent, formatTraceparent } from "@space/contracts";
export { TRACEPARENT_HEADER as TRACE_HEADER, LINK_TRACEPARENT_HEADER as LINK_HEADER } from "../workflow-tracing-headers.js";
