// Recording-only build of the supervisor before room-background-continuation-v1.
// Remove just the patch decision, never mock Temporal or edit recorded events.
module.exports = function legacySupervisor(source) {
  const decision = 'if (!patched("room-background-continuation-v1"))';
  if (source.split(decision).length !== 2) {
    throw new Error("The legacy supervisor recording adapter needs review: patch decision changed.");
  }
  return source.replace(decision, "if (true)");
};
