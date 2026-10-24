// Only used by tests. Never changes production source on disk.
module.exports = function(source) {
  const { variant } = this.getOptions();
  const marker = 'patched("room-background-continuation-v1")';
  if (variant === "legacy") {
    if (!source.includes(marker)) throw new Error("Legacy patch point moved; review the fixture recorder");
    return source.replace(marker, "false");
  }
  if (variant === "nondeterministic") {
    const start = "export async function dotGoalWorkflow(input:";
    if (!source.includes(start)) throw new Error("Negative-test workflow moved");
    return 'import { sleep as negativeTestSleep } from "@temporalio/workflow";\n' +
      source.replace('  let woken = false;', '  await negativeTestSleep("1 second");\n  let woken = false;');
  }
  throw new Error(`Unknown test variant: ${variant}`);
};
