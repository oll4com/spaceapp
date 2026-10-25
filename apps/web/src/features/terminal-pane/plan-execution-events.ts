export const PLAN_EXECUTION_UPDATED_EVENT = "space-plan-execution-updated";
export interface PlanExecutionUpdate { paneId: string; executionId: string; revision: number; }
/** Called only by the existing room feed; does not create a transport or execute stages. */
export function bridgePlanExecutionEvent(event: { type: string; paneId?: string | null; payload: Record<string, unknown> }) {
  if (event.type !== "PLAN_EXECUTION_UPDATED") return;
  const paneId = event.paneId ?? event.payload.paneId;
  const { executionId, revision } = event.payload;
  if (typeof paneId !== "string" || typeof executionId !== "string" || typeof revision !== "number") return;
  window.dispatchEvent(new CustomEvent<PlanExecutionUpdate>(PLAN_EXECUTION_UPDATED_EVENT, { detail: { paneId, executionId, revision } }));
}
