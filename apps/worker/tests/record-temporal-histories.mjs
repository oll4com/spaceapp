import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
const require = createRequire(import.meta.url);
const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "tests/temporal-sandbox.integration.test.ts", ...process.argv.slice(2)], {
  stdio: "inherit", env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1" }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
