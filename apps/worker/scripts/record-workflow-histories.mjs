// Usage: npm run temporal:record-histories -w @space/worker [-- --patched-change]
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const replace = process.argv.slice(2).includes("--patched-change");
if (process.argv.slice(2).some((arg) => arg !== "--patched-change")) throw new Error("Unknown argument");
const directory = new URL("../tests/fixtures/workflow-histories/", import.meta.url);
const files = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
if (files.some((file) => file.endsWith(".json")) && !replace) {
  throw new Error("Existing histories are compatibility contracts. Use --patched-change only with a reviewed replay-safe patched() change; never to silence a replay failure.");
}
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const target = fileURLToPath(directory);
await mkdir(target, { recursive: true });
const staging = await mkdtemp(join(target, ".record-"));
if (dirname(staging) !== target.replace(/[\\/]$/, "")) throw new Error("Unexpected staging directory");
let finished = false;
try {
  const result = spawnSync(process.execPath, [cli, "run", "tests/temporal-turn-goal.test.ts", "tests/temporal-memory.test.ts", "tests/temporal-supervisor.test.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, SPACE_RECORD_WORKFLOW_HISTORIES: "1", SPACE_WORKFLOW_HISTORY_OUTPUT: staging, SPACE_REPLACE_PATCHED_HISTORIES: "0" },
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0) {
    const expected = ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow", "roomAgentSupervisorWorkflow-legacy", "roomAgentActionWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"].map((name) => `${name}.json`);
    const recorded = await readdir(staging);
    for (const file of expected) if (!recorded.includes(file)) throw new Error(`Recorder did not produce ${file}`);
    for (const file of expected) {
      let archive;
      let archiveHandle;
      try {
        if (files.includes(file)) {
          const bytes = await readFile(join(target, file));
          const candidate = join(target, `${file.slice(0, -5)}-pre-${randomUUID()}.json`);
          archiveHandle = await open(candidate, "wx");
          // Only a successful exclusive open gives us an archive to clean up.
          archive = candidate;
          await archiveHandle.writeFile(bytes);
          await archiveHandle.close();
          archiveHandle = undefined;
        }
        await rename(join(staging, file), join(target, file));
      } catch (error) {
        if (archiveHandle) await archiveHandle.close().catch(() => undefined);
        if (archive) await rm(archive, { force: true }).catch(() => undefined);
        throw error;
      }
    }
  }
  finished = true;
} finally {
  const cleanup = rm(staging, { recursive: true, force: true });
  // Keep the original recording or publication error if cleanup also fails.
  if (finished) await cleanup;
  else await cleanup.catch(() => undefined);
}
