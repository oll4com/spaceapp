import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const require = createRequire(import.meta.url);
const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const args = process.argv.slice(2);
const versionIndex = args.indexOf("--version");
let version;
if (versionIndex !== -1) {
  version = args[versionIndex + 1];
  if (!version || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(version)) throw new Error("Use --version <new-patched-version>");
  args.splice(versionIndex, 2);
}
const result = spawnSync(process.execPath, [vitest, "run", "tests/temporal-sandbox.integration.test.ts", ...args], {
  stdio: "inherit", env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1", SPACE_TEMPORAL_HISTORY_VERSION: version ?? "" }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
