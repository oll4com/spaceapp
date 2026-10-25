import { readFileSync } from "node:fs";

// Resolve relative to this module, not the service cwd or npm launcher.
const metadata: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!metadata || typeof metadata !== "object" || !("version" in metadata) || typeof metadata.version !== "string" || !metadata.version.trim()) {
  throw new Error("Space API package version is missing.");
}

export const apiPackageVersion = metadata.version;
