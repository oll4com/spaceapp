import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath, [require.resolve("vitest/vitest.mjs"), "run", "tests/temporal-sandbox.integration.test.ts"], {
  stdio: "inherit", env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1" }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
