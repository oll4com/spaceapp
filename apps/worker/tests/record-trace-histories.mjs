import { spawnSync } from "node:child_process";
// Normal tests never write histories. This explicit first-baseline operation
// refuses to replace any existing JSON fixture, even when tests fail.
const result = spawnSync(process.execPath, ["../../node_modules/vitest/vitest.mjs", "run", "tests/workflow-trace-contracts.test.ts", "--maxWorkers=1"], {
  stdio: "inherit", env: { ...process.env, SPACEAPP_RECORD_HISTORIES: "1" }
});
process.exit(result.status ?? 1);
