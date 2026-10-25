import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runContributorSmoke } from "../contributor-smoke.mjs";

test("offline smoke executes, reconnects and deduplicates real PTY input, then cleans its fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-test-"));
  try {
    const result = await runContributorSmoke({ temporaryRoot: root });
    assert.deepEqual(result, {
      mode: "SIMULATED_RUNTIME", transport: "REAL_PTY_UNIX_IPC", passed: true,
      completedTasks: 2, sameProcessAfterReconnect: true, duplicateInputSuppressed: true, cleaned: true
    });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline smoke rejects a wrong task result instead of reporting execution as quality", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-test-"));
  const fixture = join(root, "wrong.mjs");
  await writeFile(fixture, `import { createInterface } from 'node:readline';
process.stdin.setRawMode(true);
const rl = createInterface({ input: process.stdin, terminal: false });
process.stdout.write('OFFLINE_READY\\n');
rl.on('line', line => { const request = JSON.parse(line); process.stdout.write('OFFLINE_RESULT:' + JSON.stringify({ id: request.id, total: 99, executionCount: 1 }) + '\\n'); });
`);
  try {
    await assert.rejects(runContributorSmoke({ temporaryRoot: root, fixturePath: fixture }), /acceptance failed/);
    assert.deepEqual(await readdir(root), ["wrong.mjs"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline smoke cleans resources after the synthetic runtime exits before readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "sc-test-"));
  const fixture = join(root, "exit.mjs");
  await writeFile(fixture, "process.exit(7);\n");
  try {
    await assert.rejects(runContributorSmoke({ temporaryRoot: root, fixturePath: fixture }), /exited before/);
    assert.deepEqual(await readdir(root), ["exit.mjs"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
