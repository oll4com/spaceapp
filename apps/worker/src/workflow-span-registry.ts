/**
 * In-memory registry mapping Temporal workflow execution runIds to their active span context.
 * Used by the worker process so activity interceptors can automatically parent activity
 * spans to their workflow span without needing traceparent explicitly in activity arguments.
 */
export interface RegisteredWorkflowSpan {
  traceId: string;
  spanId: string;
  workflowType: string;
}

export class WorkflowSpanRegistry {
  private readonly spans = new Map<string, RegisteredWorkflowSpan>();

  constructor(private readonly capacity = 8192) {}

  register(runId: string, span: RegisteredWorkflowSpan): void {
    if (!runId) return;
    this.spans.delete(runId);
    this.spans.set(runId, span);
    while (this.spans.size > this.capacity) {
      const oldest = this.spans.keys().next().value;
      if (oldest === undefined) break;
      this.spans.delete(oldest);
    }
  }

  lookup(runId: string | null | undefined): RegisteredWorkflowSpan | null {
    if (!runId) return null;
    return this.spans.get(runId) ?? null;
  }

  evict(runId: string | null | undefined): void {
    if (runId) this.spans.delete(runId);
  }

  clear(): void {
    this.spans.clear();
  }

  get size(): number {
    return this.spans.size;
  }
}

export const workflowSpanRegistry = new WorkflowSpanRegistry();
