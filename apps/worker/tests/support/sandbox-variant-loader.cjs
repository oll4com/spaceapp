// Used only for recording a historical pre-patch branch and proving a replay
// failure. The normal test/replay bundle never uses this loader.
module.exports = function (source) {
  const { variant } = this.getOptions();
  const needle = variant === "legacy"
    ? 'if (!patched("room-background-continuation-v1"))'
    : '  let woken = false;';
  if (source.split(needle).length !== 2) throw new Error(`Historical/negative fixture selector changed: ${needle}`);
  return source.replace(needle, variant === "legacy" ? 'if (true)' :
    '  await (await import("@temporalio/workflow")).sleep("1 second");\n  let woken = false;');
};
