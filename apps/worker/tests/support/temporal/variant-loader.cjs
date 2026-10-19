// Test-only historical/negative bundles. Never replace or mock the Temporal SDK.
module.exports = function (source) {
  const { variant } = this.getOptions();
  const target = variant === "legacy"
    ? 'if (!patched("room-background-continuation-v1"))'
    : 'export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {';
  if (source.split(target).length !== 2) throw new Error(`Expected one ${variant} variation site in production source`);
  if (variant === "legacy") return source.replace(target, "if (true)");
  if (variant === "nondeterministic") return 'import { sleep as extraUnpatchedTimer } from "@temporalio/workflow";\n' + source.replace(target, target + '\nawait extraUnpatchedTimer("1 second");');
  throw new Error(`Unknown test variant: ${variant}`);
};
