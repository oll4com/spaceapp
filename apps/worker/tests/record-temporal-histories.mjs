import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const require = createRequire(import.meta.url);
const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("-") || args.lastIndexOf(name) !== index) throw new Error(`Use ${name} <value> once`);
  args.splice(index, 2);
  return value;
}
const version = option("--version");
if (version !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(version)) throw new Error("Use --version <new-patched-version>");
const outputDirectory = option("--output-dir");
const result = spawnSync(process.execPath, [vitest, "run", "tests/temporal-sandbox.integration.test.ts", ...args], {
  stdio: "inherit", env: {
    ...process.env,
    SPACE_RECORD_TEMPORAL_HISTORIES: "1",
    SPACE_TEMPORAL_HISTORY_VERSION: version ?? "",
    SPACE_TEMPORAL_HISTORY_DIRECTORY: outputDirectory ? resolve(outputDirectory) : ""
  }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
