// Record the existing legacy implementation without a patch marker. The
// resulting real-server history is replayed against unmodified production code,
// where patched() must select the legacy branch from that marker-free history.
// This changes only the recorder's entry selector, never Temporal APIs or logic.
module.exports = function legacySupervisorSelector(source) {
  source = source.replace(/\r\n/g, "\n");
  const selector = 'if (!patched("room-background-continuation-v1")) return legacyRoomAgentSupervisorWorkflow(rawInput);\n  return continuingRoomAgentSupervisorWorkflow(rawInput);';
  if (source.split(selector).length !== 2) {
    throw new Error("Legacy supervisor selector changed; review the recorder instead of silently refreshing histories");
  }
  return source.replace(selector, "return legacyRoomAgentSupervisorWorkflow(rawInput);");
};
