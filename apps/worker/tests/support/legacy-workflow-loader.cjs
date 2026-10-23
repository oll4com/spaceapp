const path = require("node:path");
/**
 * Build a pre-patch test bundle by replacing exactly one continuation guard with false.
 * Reject an unexpected guard count; return transformed source without writing production files.
 */
module.exports = function legacySupervisor(source) {
  if (!this.resourcePath.endsWith(path.join("src", "workflows.ts"))) return source;
  const guard = 'patched("room-background-continuation-v1")';
  if (source.split(guard).length !== 2) {
    throw new Error("Legacy fixture requires exactly one original continuation patch guard");
  }
  // Generate a genuine history without this patch marker. Current production
  // must replay it using Temporal's retained, pre-patch implementation.
  return source.replace(guard, "false");
};
