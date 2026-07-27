import { readFileSync } from "node:fs";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

export const PACKAGE_VERSION = manifest.version;
export const LAUNCHER_DIST_TAG = PACKAGE_VERSION.includes("-hostroot.")
  ? "personal"
  : "latest";
export const UNIVERSAL_COMMAND = `npx --yes run-spaceapp@${LAUNCHER_DIST_TAG}`;
export const UNIVERSAL_INSTALL_COMMAND = `${UNIVERSAL_COMMAND} install`;
