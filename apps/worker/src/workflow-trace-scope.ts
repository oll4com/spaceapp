// Workflow-isolate-local hooks. With tracing disabled they are no-ops. They
// change no Temporal command, input, timer, retry policy or business result.
type RequestTracer = (input: unknown, execute: () => Promise<unknown>) => Promise<unknown>;
let tracer: RequestTracer | undefined;
export function installWorkflowRequestTracer(value: RequestTracer): void { tracer = value; }
export async function traceWorkflowRequest<T>(input: unknown, execute: () => Promise<T>): Promise<T> {
  return (tracer ? tracer(input, execute) : execute()) as Promise<T>;
}
