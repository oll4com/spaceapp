import assert from "node:assert/strict";
import { constants } from "node:fs";
import { mkdtemp, readdir, mkdir, copyFile, rm, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 2 && args[0] === "--output", "Usage: temporal:record-histories [--output new-directory]");
const destination = args.length ? resolve(args[1]) : join(root, "tests/fixtures/workflow-histories");
const expected = ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
  "roomAgentSupervisorWorkflow-legacy", "roomAgentActionWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"].map(name => `${name}.json`).sort();
// Refuse before starting the server, including existing symlinks or directories.
for (const file of expected) {
  const existing = await lstat(join(destination, file)).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing) throw new Error(`Refusing to overwrite workflow history: ${join(destination, file)}. Use --output with a new directory and preserve earlier baselines.`);
}
const output = await mkdtemp(join(tmpdir(), "spaceapp-workflow-histories-"));
try {
  const cli = fileURLToPath(new URL("./vitest.mjs", import.meta.resolve("vitest/package.json")));
  const result = spawnSync(process.execPath, [cli, "run", "tests/workflow-sandbox.test.ts"], {
    cwd: root, stdio: "inherit", env: { ...process.env, SPACE_RECORD_WORKFLOW_HISTORIES: output }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const files = (await readdir(output)).sort();
    assert.deepEqual(files, expected);
    await mkdir(destination, { recursive: true });
    // Exclusive creation also protects against a file appearing after the preflight.
    for (const file of files) await copyFile(join(output, file), join(destination, file), constants.COPYFILE_EXCL);
    console.log(`Recorded ${files.length} synthetic histories after all sandbox assertions passed.`);
  }
} finally { await rm(output, { recursive: true, force: true }); }
