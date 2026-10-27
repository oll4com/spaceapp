import assert from "node:assert/strict";
import { mkdtemp, readdir, mkdir, copyFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
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
    assert.deepEqual(files, ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
      "roomAgentSupervisorWorkflow-legacy", "roomAgentActionWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"].map(name => `${name}.json`).sort());
    const destination = join(root, "tests/fixtures/workflow-histories");
    await mkdir(destination, { recursive: true });
    for (const file of files) await copyFile(join(output, file), join(destination, file));
    console.log(`Recorded ${files.length} synthetic histories after all sandbox assertions passed.`);
  }
} finally { await rm(output, { recursive: true, force: true }); }
