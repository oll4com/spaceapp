"use strict";

/**
 * Webpack source loader used only by test workers in `apps/worker/tests/`:
 * - mode="pre-patch": forces `patched("room-background-continuation-v1")` to
 *   evaluate to `false` without emitting a patch marker, producing genuine
 *   pre-patch `roomAgentSupervisorWorkflow` executions and histories while
 *   keeping `src/workflows.ts` untouched.
 * - mode="inject-sleep": injects `await sleep("1 second")` at the start of
 *   `dotGoalWorkflow` to verify that `Worker.runReplayHistories` rejects
 *   nondeterministic workflow changes with `DeterminismViolationError`.
 * - mode="inject-activity": injects an extra `recordDummyTurnStarted(input)`
 *   call in `dummyTurnWorkflow` to verify that an extra activity command fails
 *   replay with `DeterminismViolationError`.
 */
module.exports = function prePatchWorkflowLoader(source) {
  const options = typeof this.getOptions === "function" ? this.getOptions() : {};
  const mode = options.mode || "pre-patch";
  if (mode === "pre-patch") {
    return source.replace(
      /patched\(\s*["']room-background-continuation-v1["']\s*\)/g,
      "false"
    );
  }
  if (mode === "inject-sleep") {
    return source.replace(
      "export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {",
      'import { sleep as __injectedSleep } from "@temporalio/workflow";\nexport async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {\n  await __injectedSleep("1 second");'
    );
  }
  if (mode === "inject-activity") {
    return source.replace(
      "export async function dummyTurnWorkflow(input: DummyTurnInput): Promise<DummyTurnResult> {",
      "export async function dummyTurnWorkflow(input: DummyTurnInput): Promise<DummyTurnResult> {\n  await recordDummyTurnStarted(input);"
    );
  }
  return source;
};
