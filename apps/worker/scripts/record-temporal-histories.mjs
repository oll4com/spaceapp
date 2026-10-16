import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This is an explicit maintenance operation, never a normal test fallback.
// Re-record only alongside a reviewed patched() workflow change; see the fixture README.
const require = createRequire(import.meta.url);
const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "tests/temporal-sandbox.integration.test.ts"], {
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  env: { ...process.env, SPACE_TEMPORAL_RECORD_HISTORIES: "1" },
  stdio: "inherit"
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`History recording terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
