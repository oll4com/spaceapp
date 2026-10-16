import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Use the locked local Vitest, not npx/a downloaded runner. Ordinary tests never
// set this flag and therefore cannot replace a failing compatibility baseline.
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url)),
  "run", "tests/temporal-workflows.test.ts"
], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, SPACE_TEMPORAL_RECORD_HISTORIES: "1" },
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
