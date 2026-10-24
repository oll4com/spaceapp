import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightRecording, publishHistories, recordingVersion } from "./temporal-history-store.mjs";

const version = recordingVersion(process.argv.slice(2));
const directory = fileURLToPath(new URL("../tests/fixtures/workflow-histories/", import.meta.url));
const vitest = fileURLToPath(new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../", import.meta.url));
// Reject refreshes and replay the committed corpus before allocating staging or
// starting recording scenarios. An incompatible baseline must stay visible.
await preflightRecording(directory, version, histories => {
  console.log(`Checking ${histories.length} saved histories before recording any additions.`);
  const result = spawnSync(process.execPath, [vitest, "run", "tests/temporal-replay.test.ts",
    "--testNamePattern", "^replays every committed history against current production workflows$"], {
    cwd, env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "0" }, stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Existing history replay failed (exit ${result.status ?? result.signal}); no histories were recorded or published.`);
  }
});
const staging = await mkdtemp(join(tmpdir(), "space-temporal-histories-"));
try {
  const result = spawnSync(process.execPath, [vitest, "run",
    "tests/temporal-sandbox-core.test.ts", "tests/temporal-sandbox-supervisor-rollover.test.ts",
    "tests/temporal-sandbox-supervisor-races.test.ts"], {
    cwd,
    env: { ...process.env, SPACE_RECORD_TEMPORAL_HISTORIES: "1", SPACE_TEMPORAL_HISTORY_DIRECTORY: staging }, stdio: "inherit"
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0) {
    const created = await publishHistories(staging, directory, version);
    console.log(`Published ${created.length} synthetic histories; retained every existing fixture.`);
  }
} finally { await rm(staging, { recursive: true, force: true }); }
