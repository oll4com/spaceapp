import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function requireVersion(value, field) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`run-spaceapp package.json must declare a valid ${field}.`);
  }
  return value;
}

export const PACKAGE_VERSION = requireVersion(manifest.version, "version");
export const RUNTIME_VERSION = requireVersion(
  manifest.spaceappRuntimeVersion,
  "spaceappRuntimeVersion"
);
if (typeof manifest.spaceappHostRootRuntimeCompatible !== "boolean") {
  throw new Error(
    "run-spaceapp package.json must declare spaceappHostRootRuntimeCompatible as a boolean."
  );
}
export const HOST_ROOT_RUNTIME_COMPATIBLE =
  manifest.spaceappHostRootRuntimeCompatible;
export const LAUNCHER_DIST_TAG = PACKAGE_VERSION.includes("-hostroot.")
  ? "personal"
  : "latest";
export const UNIVERSAL_COMMAND = `npx --yes run-spaceapp@${LAUNCHER_DIST_TAG}`;
export const UNIVERSAL_INSTALL_COMMAND = `${UNIVERSAL_COMMAND} install`;
