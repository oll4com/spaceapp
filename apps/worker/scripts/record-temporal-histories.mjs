import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerDirectory = fileURLToPath(new URL("../", import.meta.url));
const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [vitest, "run",
  "tests/temporal-dot-goal.test.ts",
  "tests/temporal-supervisor.test.ts",
  "tests/temporal-turn-memory.test.ts"
], {
  cwd: workerDirectory,
  env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1" },
  stdio: "inherit"
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`History recording interrupted by ${result.signal}`);
process.exitCode = result.status ?? 1;
