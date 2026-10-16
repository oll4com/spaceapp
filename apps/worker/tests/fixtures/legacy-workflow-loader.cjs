// Test-only pre-patch recording. Keep imports and production source paths intact.
module.exports = function (source) {
  const needle = 'patched("room-background-continuation-v1")';
  if (source.split(needle).length !== 2) throw new Error("Expected exactly one supervisor patch gate");
  return source.replace(needle, "false");
};
