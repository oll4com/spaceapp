// Test-only reconstruction of the pre-patch supervisor. Do not mock patched():
// removing this one branch records a genuine history without a patch marker.
module.exports = function (source) {
  const needle = 'if (!patched("room-background-continuation-v1"))';
  if (source.split(needle).length !== 2) throw new Error("Historical supervisor anchor changed; review the recording fixture");
  return source.replace(needle, "if (true)");
};
