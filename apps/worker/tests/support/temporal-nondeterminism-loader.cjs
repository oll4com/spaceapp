// Test-only mutation. The production module on disk is never changed.
module.exports = function addIncompatibleTimer(source) {
  const signature = "export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {";
  if (!source.includes(signature)) throw new Error("Cannot locate dotGoalWorkflow for the replay negative control");
  return 'import { sleep as replayNegativeControlSleep } from "@temporalio/workflow";\n'
    + source.replace(signature, signature + '\n  await replayNegativeControlSleep("1 second");');
};
