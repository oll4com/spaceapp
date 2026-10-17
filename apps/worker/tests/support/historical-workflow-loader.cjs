// Test-only source transforms. Production files are never changed. The legacy
// variant records a history before the patch existed; the negative variant
// proves that inserting a command without a patch breaks replay.
/** Build historical or intentionally incompatible test variants without changing production files. */
module.exports = function (source) {
  const { variant } = this.getOptions();
  if (variant === "legacy") {
    const marker = 'patched("room-background-continuation-v1")';
    if (!source.includes(marker)) throw new Error("Historical patch marker moved; review the fixture generator.");
    return source.replace(marker, "false");
  }
  if (variant === "negative") {
    const marker = "await recordDummyTurnStarted(input);";
    if (!source.includes(marker)) throw new Error("Negative-control insertion point moved.");
    return 'import { sleep as replayBreakingSleep } from "@temporalio/workflow";\n' +
      source.replace(marker, 'await replayBreakingSleep("1 second");\n  ' + marker);
  }
  throw new Error(`Unknown historical variant: ${variant}`);
};
