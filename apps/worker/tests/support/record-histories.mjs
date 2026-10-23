import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [cli, "run", "tests/temporal-sandbox.test.ts"], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1" },
  stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
