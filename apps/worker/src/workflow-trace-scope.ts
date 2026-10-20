type ScopeTracer = (args: readonly unknown[], work: () => Promise<unknown>) => Promise<unknown>;
let tracer: ScopeTracer | null = null;

/** Set only by the optional interceptor, in this workflow isolate. */
export function installWorkflowScopeTracer(value: ScopeTracer): void { tracer = value; }

/** The supervisor processes one mission at a time; signals only enqueue data.
 * Give that serial mission its own completed span, even while the supervisor
 * remains open or receives another API request. Export-off is a direct call.
 */
export function traceWorkflowScope<T>(input: unknown, work: () => Promise<T>): Promise<T> {
  return tracer ? tracer([input], work) as Promise<T> : work();
}
