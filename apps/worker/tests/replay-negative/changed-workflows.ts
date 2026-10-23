import { sleep } from "@temporalio/workflow";

/**
 * Intentionally modified workflow variant introducing an extra sleep timer
 * to verify that Worker.runReplayHistories detects nondeterminism and throws DeterminismViolationError.
 *
 * @returns Status string after sleeping.
 */
export async function replayDeterminismFixtureWorkflow(): Promise<string> {
  await sleep("1 second");
  return "ok";
}
