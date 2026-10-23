/** Produce guarded historical or deliberately incompatible bundles for tests only.
 * Production files are never rewritten; missing injection points fail the build.
 */
module.exports = function (source) {
  const { variant } = this.getOptions();
  if (variant === 'legacy') {
    const marker = 'patched("room-background-continuation-v1")';
    if (!source.includes(marker)) throw new Error('Supervisor patch boundary moved; review historical fixture generation');
    return source.replace(marker, 'false');
  }
  if (variant === 'negative') {
    const marker = 'await recordDummyTurnStarted(input);';
    if (!source.includes(marker)) throw new Error('Negative replay injection point moved');
    const goalMarker = 'let woken = false;';
    if (!source.includes(goalMarker)) throw new Error('Dot negative replay injection point moved');
    source = source.replace(goalMarker, 'await replayBreakingSleep("1 second");\n' + goalMarker);
    return 'import { sleep as replayBreakingSleep } from "@temporalio/workflow";\n' + source.replace(marker, 'await replayBreakingSleep("1 second");\n' + marker);
  }
  throw new Error('Unknown history variant');
};
