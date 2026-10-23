// Test-only source transform: execute the original pre-patch branch without
// recording a patch marker, so current production code must replay its history.
module.exports = function supervisorLegacyLoader(source) {
  const guard = 'if (!patched("room-background-continuation-v1"))';
  if (source.split(guard).length !== 2) {
    throw new Error("Expected exactly one supervisor continuation patch guard");
  }
  return source.replace(guard, "if (true)");
};
