import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const workerDirectory = dirname(fileURLToPath(import.meta.url));
const workerPackage = resolve(workerDirectory, "..");
const repositoryRoot = resolve(workerPackage, "../..");
const vitest = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
const childEnv = { ...process.env, TEMPORAL_RECORD_WORKFLOW_HISTORIES: "1" };
const result = spawnSync(process.execPath, [vitest, "run", "tests/temporal-workflows.test.ts"], {
  cwd: workerPackage,
  stdio: "inherit",
  env: childEnv
});
if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
