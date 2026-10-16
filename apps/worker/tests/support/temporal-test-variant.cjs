// Test-only historical/negative bundles. Never used by the production worker.
module.exports = function temporalTestVariant(source) {
  const { variant } = this.getOptions();
  if (variant === "legacy") {
    for (const id of ["room-background-continuation-v1", "room-background-action-failure-v1"]) {
      const marker = `patched("${id}")`;
      if (!source.includes(marker)) throw new Error(`Missing historical patch boundary: ${id}`);
      source = source.replace(marker, "false");
    }
    return source;
  }
  if (variant === "negative") {
    const declaration = 'export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {';
    if (!source.includes(declaration)) throw new Error("dotGoalWorkflow signature changed; update the negative fixture deliberately");
    return source.replace(declaration, declaration + '\n  await condition(() => false, "1 second");');
  }
  throw new Error(`Unknown test workflow variant: ${variant}`);
};
