import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const cli = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [cli, "run", "tests/temporal-workflows.test.ts"], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1" }, stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
