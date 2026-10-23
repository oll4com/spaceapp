import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "tests/fixtures/workflow-histories");
const existing = await readdir(fixtures).catch(() => []);
const patch = process.argv[2] === "--patched-change" ? process.argv[3] : undefined;
if (patch && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(patch)) throw new Error("Use a filename-safe patch ID");
if (existing.some(name => name.endsWith(".json")) &&
    !patch) {
  throw new Error("Refusing to overwrite replay baselines. Re-record only with a reviewed patched() change: --patched-change PATCH_ID. Never re-record to silence a failing replay.");
}
const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const recording = spawnSync(process.execPath, [vitest, "run", "tests/temporal-sandbox.test.ts", "--reporter=verbose"], {
  cwd: root, stdio: "inherit", env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1", SPACE_TEMPORAL_HISTORY_PATCH: patch ?? "" }
});
if (recording.status !== 0) process.exit(recording.status ?? 1);
const replay = spawnSync(process.execPath, [vitest, "run", "tests/temporal-sandbox.test.ts", "-t", "replay|nondeterministic"], {
  cwd: root, stdio: "inherit", env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "0" }
});
process.exit(replay.status ?? 1);
