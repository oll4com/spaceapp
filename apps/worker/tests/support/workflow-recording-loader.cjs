// Test-only bundles. Production files and the Temporal SDK are never mocked.
/** Select the legacy branch for recording, or add a timer to prove replay rejects drift. */
module.exports = function (source) {
  const { mode } = this.getOptions();
  if (mode === "legacy") {
    const selector = 'if (!patched("room-background-continuation-v1")) return legacyRoomAgentSupervisorWorkflow(rawInput);\n  return continuingRoomAgentSupervisorWorkflow(rawInput);';
    if (!source.includes(selector)) throw Error("Legacy recording selector changed; review compatibility before recording.");
    return source.replace(selector, "return legacyRoomAgentSupervisorWorkflow(rawInput);");
  }
  const signature = 'export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {';
  if (!source.includes(signature)) throw Error("Negative replay fixture no longer matches dotGoalWorkflow.");
  return 'import { sleep as replayDriftSleep } from "@temporalio/workflow";\n' +
    source.replace(signature, signature + '\n  await replayDriftSleep("1 second");');
};
