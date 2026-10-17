// Test-only historical/invalid bundles. Never used by a production worker.
module.exports = function (source) {
  const { variant } = this.getOptions();
  const needle = variant === "legacy"
    ? 'patched("room-background-continuation-v1")'
    : 'return recordDummyTurnCompleted(input);';
  if (source.split(needle).length !== 2) throw new Error(`Workflow variant ${variant} no longer matches exactly once`);
  return source.replace(needle, variant === "legacy"
    ? "false /* test-only pre-patch implementation */"
    : 'await recordDummyTurnStarted(input); return recordDummyTurnCompleted(input);');
};
