const numericIdentifier = "(?:0|[1-9]\\d*)";
const nonNumericIdentifier = "(?:\\d*[A-Za-z-][0-9A-Za-z-]*)";
const prereleaseIdentifier = `(?:${numericIdentifier}|${nonNumericIdentifier})`;
const versionPattern = new RegExp(
  `^${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier}` +
  `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?$`
);

export function isRegistrySafeReleaseVersion(version) {
  return (
    typeof version === "string" &&
    version.length <= 128 &&
    versionPattern.test(version)
  );
}
