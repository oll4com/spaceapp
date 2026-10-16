import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(root, "tests/fixtures/workflow-histories");
const args = process.argv.slice(2);
const initial = args.length === 1 && args[0] === "--initial";
const marker = args.length === 2 && args[0] === "--patched-change" ? args[1] : null;
if (!initial && (!marker || !/^[\w-]{1,100}$/.test(marker))) {
  throw new Error("Use --initial only for first fixture creation, or --patched-change <new-patch-id> together with a reviewed patched() change. Never regenerate to hide a replay failure.");
}
const existing = existsSync(fixtures) ? readdirSync(fixtures).filter(name => name.endsWith(".json")) : [];
if (initial && existing.length) throw new Error("Initial recording refuses to overwrite existing histories.");
if (marker) {
  const workflowSource = ["workflows.ts", "memory-maintenance-workflows.ts", "memory-mutation-workflows.ts"]
    .map(name => readFileSync(path.join(root, "src", name), "utf8")).join("\n");
  if (!workflowSource.includes(`patched("${marker}")`) && !workflowSource.includes(`patched('${marker}')`)) {
    throw new Error(`No patched() call for ${marker}; refusing fixture replacement.`);
  }
}
const require = createRequire(import.meta.url);
const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "tests/temporal-workflow-sandbox.test.ts"], {
  cwd: root, env: { ...process.env, RECORD_WORKFLOW_HISTORIES: "1" }, stdio: "inherit", timeout: 180_000
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("Recorded and replay-checked synthetic histories. Review the diff and the accompanying patch before committing.");
