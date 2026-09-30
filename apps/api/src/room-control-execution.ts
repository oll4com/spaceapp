import { controlExecuteSchema, controlOperationSchema } from "@space/contracts";

/** Only transport/receipt-persistence failures may retry an idempotent execute. */
export class RetryableRoomControlError extends Error {}

export class UnconfirmedRoomControlError extends Error {}

type Evidence = Record<string, unknown>;

export async function executeDurableRoomControl(options: {
  actionId: string;
  arguments: Evidence;
  evidence: Evidence;
  control: (tool: string, args: Evidence) => Promise<unknown>;
  checkpoint: (evidence: Evidence) => Promise<void>;
  assertCanContinue: () => Promise<void>;
  /** Request cancellation of a submitted operation before propagating a stop. */
  cancelOperation?: (operationId: string) => Promise<unknown>;
  pollIntervalMs: number;
  timeoutMs: number;
}): Promise<Evidence> {
  const requestId = `room-control:${options.actionId}`;
  // The persisted action owns the key, never a model-provided reusable ID.
  const command = controlExecuteSchema.parse({ ...options.arguments, requestId, waitForCompletion: false });
  let evidence: Evidence = { ...options.evidence, controlRequestId: requestId };
  const checkpoint = async (patch: Evidence) => {
    evidence = { ...evidence, ...patch };
    try { await options.checkpoint(evidence); }
    catch { throw new RetryableRoomControlError("Control checkpoint could not be persisted; recover the same request before continuing."); }
  };
  const call = async (tool: string, args: Evidence) => {
    try { return await options.control(tool, args); }
    catch { throw new RetryableRoomControlError("Control transport failed; recover the same request before continuing."); }
  };
  const receipt = async (raw: unknown) => {
    const parsed = controlOperationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.roomId !== command.roomId || parsed.data.requestId !== requestId ||
      (typeof evidence.controlOperationId === "string" && parsed.data.id !== evidence.controlOperationId)) {
      await checkpoint({ phase: "UNKNOWN" });
      throw new UnconfirmedRoomControlError("Control returned an invalid or mismatched receipt. Inspect before retrying.");
    }
    await checkpoint({ control: parsed.data, controlOperationId: parsed.data.id, phase: parsed.data.status });
    return parsed.data;
  };

  // A mission stop can race with a running control operation.  Preserve the
  // exact operation identity and ask the control service to cancel it before
  // allowing the worker to mark the action blocked.  Cancellation is
  // best-effort: if the receipt cannot be observed, the action remains
  // unconfirmed and recovery must inspect the same operation ID.
  const assertCanContinue = async () => {
    try {
      await options.assertCanContinue();
    } catch (error) {
      const operationId = evidence.controlOperationId;
      const phase = evidence.phase;
      if (typeof operationId === "string" && operationId.length > 0 &&
          phase !== "COMPLETED" && phase !== "FAILED" && phase !== "CANCELLED") {
        try {
          const cancelled = options.cancelOperation
            ? await options.cancelOperation(operationId)
            : await call("space_operations", { roomId: command.roomId, operation: "cancel", id: operationId });
          const parsed = controlOperationSchema.safeParse(cancelled);
          const matches = parsed.success && parsed.data.id === operationId &&
            parsed.data.roomId === command.roomId && parsed.data.requestId === requestId;
          await checkpoint({
            cancelRequested: true,
            ...(matches ? { control: parsed.data, phase: parsed.data.status } : { phase: "CANCEL_REQUESTED" })
          });
        } catch {
          await checkpoint({ cancelRequested: true, phase: "CANCEL_REQUESTED" }).catch(() => {});
        }
      }
      throw error;
    }
  };

  await assertCanContinue();
  if (evidence.phase === "UNKNOWN") throw new UnconfirmedRoomControlError("Control receipt needs operator inspection before retrying.");
  // Persist intent before crossing the API boundary. If the response was lost,
  // execute with the same key retrieves the operation rather than submitting twice.
  await checkpoint({ phase: evidence.phase ?? "SUBMITTING" });
  let operation = await receipt(typeof evidence.controlOperationId === "string"
    ? await call("space_operations", { roomId: command.roomId, operation: "get", id: evidence.controlOperationId })
    : await call("space_execute", command));
  const deadline = Date.now() + options.timeoutMs;
  while (operation.status === "RUNNING") {
    await assertCanContinue();
    if (Date.now() >= deadline) {
      await checkpoint({ phase: "UNKNOWN" });
      throw new UnconfirmedRoomControlError("Control is still running after the observation deadline. Inspect its operation; do not repeat it.");
    }
    await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs));
    await assertCanContinue();
    operation = await receipt(await call("space_operations", { roomId: command.roomId, operation: "get", id: operation.id }));
  }
  // Reject contradictory success as well as explicit pending/partial/failure.
  if (operation.status !== "COMPLETED" || operation.cancelRequested || operation.results.length === 0 ||
    operation.results.some(result => result.status !== "COMPLETED") ||
    command.actions.some((_, index) => !operation.results.some(result => result.index === index))) {
    throw new UnconfirmedRoomControlError(`Control did not reach verified completion (${operation.status}). Inspect its receipt before continuing.`);
  }
  return evidence;
}
