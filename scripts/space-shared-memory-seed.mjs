#!/usr/bin/env -S node --experimental-strip-types
// Release-only export. Run on the release host, review the diff, then commit the new seed before lab acceptance.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { screenSharedMemory, sharedMemorySeedSchema, sharedMemoryReleaseVersionSchema } from "../packages/contracts/src/nous-shared-memory.ts";

const seedUrl = new URL("../packages/contracts/src/nous-shared-memory-seed.json", import.meta.url);
const semver = (version) => { if (!sharedMemoryReleaseVersionSchema.safeParse(version).success) throw new Error("An exact release version is required."); return version.split(".").slice(0, 2).map(Number); };
const beforeFirstRelease = (version) => { const [major, minor] = semver(version); return major < 1 || (major === 1 && minor < 2); };
export function validateSeed(value, version, { allowStaged = false } = {}) {
  semver(version);
  const parsed = sharedMemorySeedSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid shared-memory seed format.");
  const seed = parsed.data;
  if (seed.releaseVersion !== version && !(allowStaged && beforeFirstRelease(version) && seed.releaseVersion === "1.2.0")) throw new Error("The shared-memory seed version does not match the release. Refresh and review the seed before release.");
  const keys = new Set();
  for (const entry of seed.entries) {
    if (keys.has(entry.key)) throw new Error("Duplicate shared-memory seed key.");
    keys.add(entry.key);
    const result = screenSharedMemory(entry);
    if (!result.ok) throw new Error(`Shared-memory seed refused: ${result.reason}`);
  }
  const identity = seed.entries.find((entry) => entry.key === "identity");
  if (!identity || !identity.body.includes("Nous") || !identity.body.includes("Νους") || !identity.body.includes("SpaceApp")) throw new Error("The shared-memory seed must include Nous's identity.");
  return true;
}
export function exportSeed(entries, version, now = new Date()) {
  const seed = { schemaVersion: 1, releaseVersion: version, reviewedAt: now.toISOString(), entries: entries.filter((entry) => entry.status === "ACTIVE" && !entry.deleted)
    .map((entry) => ({ key: entry.seedKey ?? `learned-${createHash("sha256").update(entry.id).digest("hex").slice(0, 20)}`, title: entry.title, body: entry.body, tags: entry.tags }))
    .sort((a, b) => Number(b.key === "identity") - Number(a.key === "identity") || a.key.localeCompare(b.key)) };
  validateSeed(seed, version); return seed;
}
function main(args) {
  const [op, ...rest] = args; const option = (key) => { const at = rest.indexOf(key); return at < 0 ? null : rest[at + 1]; };
  const version = option("--version"); if (!version) throw new Error("Use verify|export --version x.y.z [--allow-staged] [--input file] [--out file].");
  if (op === "verify") { validateSeed(JSON.parse(readFileSync(seedUrl, "utf8")), version, { allowStaged: rest.includes("--allow-staged") }); console.log("Shared Nous memory seed verified."); return; }
  if (op !== "export") throw new Error("Use verify or export.");
  const input = option("--input");
  const result = JSON.parse(input ? readFileSync(input, "utf8") : execFileSync(process.execPath, ["/opt/spaceapp/scripts/space-admin-action.mjs", "shared-memory-list"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }));
  const entries = Array.isArray(result) ? result : (result.body?.entries ?? result.entries);
  if (!Array.isArray(entries)) throw new Error("The shared-memory read returned no entries.");
  const seed = exportSeed(entries, version);
  writeFileSync(option("--out") ?? fileURLToPath(seedUrl), `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`Exported ${seed.entries.length} screened ACTIVE entries. Review the diff before committing.`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error instanceof Error ? error.message : "Shared-memory seed failed."); process.exitCode = 1; }
}
