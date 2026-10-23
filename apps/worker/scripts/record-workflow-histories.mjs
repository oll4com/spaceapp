import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vitest = join(workerRoot, "../../node_modules/vitest/vitest.mjs");
const tests = readdirSync(join(workerRoot, "tests"))
  .filter((name) => name.startsWith("temporal-") && name.endsWith(".test.ts") && name !== "temporal-replay-real.test.ts")
  .sort()
  .map((name) => `tests/${name}`);
if (tests.length === 0) throw new Error("No real Temporal recording suites found");
const result = spawnSync(process.execPath, [vitest, "run", ...tests, "--maxWorkers=1", "--no-file-parallelism"], {
  cwd: workerRoot,
  env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1" },
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
