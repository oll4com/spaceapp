import { SpaceConflictError } from "@space/runtime";

/** The owner's OPERATOR messages to Nous (`person`: a person wrote it, not a proof or automation session such as space-admin-action nous-ask). */
export type OperatorMessageRefs = (owner: string) => Promise<Array<{ id: string; createdAt: string; person: boolean }>>;
export const OPERATOR_ORDER_MAX_AGE_MS = 48 * 3_600_000;

/**
 * nous_msg:8f84e7e6 (5/11: the operator asked to write to Criteria about a test that closed mid-way; mailmem:HkyoywEn0sDc refused the review):
 * a copilot review may name the operator's order. It counts only as a message a person wrote to Nous in the last 48 hours; anything else
 * refuses the review. A verified order lets a forbidding memory pass (the review still waits for approval), returning the line the review carries.
 */
export async function operatorOrder(refs: OperatorMessageRefs | undefined, owner: string, id: string | undefined, now = Date.now()): Promise<string | undefined> {
  if (!id) return undefined;
  const message = (await refs?.(owner))?.find((ref) => ref.id === id);
  if (!message?.person || now - Date.parse(message.createdAt) > OPERATOR_ORDER_MAX_AGE_MS) {
    throw new SpaceConflictError(`operatorOrder ${id} is not a message the operator wrote to Nous in the last 48 hours; nothing was recorded.`);
  }
  return id;
}
export const operatorOrderOverride = (order: string, memoryId: string) => `operator order ${order} overrides memory ${memoryId}`;
