import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { preflightRecording, publishHistories, recordingVersion } from "../scripts/temporal-history-store.mjs";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "space-history-store-test-"));
  roots.push(root);
  const staging = join(root, "staging"), destination = join(root, "histories");
  await mkdir(staging); await mkdir(destination);
  const history = JSON.stringify({ workflowId: "synthetic", history: { events: [{ workflowTaskCompletedEventAttributes: {} }] } });
  return { staging, destination, history };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("rejects unsafe or ambiguous version arguments", () => {
  expect(recordingVersion([])).toBeNull();
  expect(recordingVersion(["--version", "continuation-v2"])).toBe("continuation-v2");
  for (const args of [["--force"], ["--version", "../escape"], ["--version", ""], ["--version", "x", "extra"]]) {
    expect(() => recordingVersion(args)).toThrow();
  }
});
it("fails fast on an accidental refresh or a reused version", async () => {
  const c = await fixture();
  await writeFile(join(c.destination, "goal--patch-v2.json"), c.history);
  await expect(preflightRecording(c.destination, null)).rejects.toThrow("Preserve");
  await expect(preflightRecording(c.destination, "patch-v2")).rejects.toThrow("already exists");
  const replay = vi.fn(async () => undefined);
  await expect(preflightRecording(c.destination, "patch-v3", replay)).resolves.toBeUndefined();
  expect(replay).toHaveBeenCalledExactlyOnceWith(["goal--patch-v2.json"]);
});
it("adds a new version without changing even one byte of an old history", async () => {
  const c = await fixture();
  await writeFile(join(c.destination, "goal.json"), "original oracle\n");
  await writeFile(join(c.staging, "goal.json"), c.history);
  expect(await publishHistories(c.staging, c.destination, "patch-v2")).toHaveLength(1);
  expect(await readFile(join(c.destination, "goal.json"), "utf8")).toBe("original oracle\n");
  expect(await readFile(join(c.destination, "goal--patch-v2.json"), "utf8")).toBe(c.history);
});
it("checks later conflicts before publishing earlier files", async () => {
  const c = await fixture();
  await writeFile(join(c.staging, "a.json"), c.history);
  await writeFile(join(c.staging, "z.json"), c.history);
  await writeFile(join(c.destination, "z.json"), "retained");
  await expect(publishHistories(c.staging, c.destination, null)).rejects.toThrow("Refusing");
  expect(await readdir(c.destination)).toEqual(["z.json"]);
  expect(await readFile(join(c.destination, "z.json"), "utf8")).toBe("retained");
});
it("rejects an empty or malformed recording without publishing", async () => {
  const c = await fixture();
  await expect(publishHistories(c.staging, c.destination, null)).rejects.toThrow("no histories");
  await writeFile(join(c.staging, "bad.json"), "{}");
  await expect(publishHistories(c.staging, c.destination, null)).rejects.toThrow("Invalid");
  expect(await readdir(c.destination)).toEqual([]);
});

it("requires actual replay for an existing corpus and preserves it on replay failure", async () => {
  const c = await fixture();
  await writeFile(join(c.destination, "goal.json"), c.history);
  await expect(preflightRecording(c.destination, "patch-v2")).rejects.toThrow("must pass replay");
  const failure = new Error("goal.json: DeterminismViolationError");
  const replay = vi.fn(async () => { throw failure; });
  await expect(preflightRecording(c.destination, "patch-v2", replay)).rejects.toBe(failure);
  expect(await readdir(c.destination)).toEqual(["goal.json"]);
  expect(await readFile(join(c.destination, "goal.json"), "utf8")).toBe(c.history);
  expect(await readdir(c.staging)).toEqual([]);
});
it("passes every retained history version to the pre-recording replay gate", async () => {
  const c = await fixture();
  for (const name of ["goal--patch-v2.json", "goal.json", "supervisor-legacy.json"]) {
    await writeFile(join(c.destination, name), c.history);
  }
  await writeFile(join(c.destination, "README.md"), "Recording policy");
  const replay = vi.fn(async () => undefined);
  await preflightRecording(c.destination, "patch-v3", replay);
  expect(replay).toHaveBeenCalledExactlyOnceWith(["goal--patch-v2.json", "goal.json", "supervisor-legacy.json"]);
});
it("permits the initial empty corpus without attempting an empty replay", async () => {
  const c = await fixture();
  const replay = vi.fn(async () => { throw new Error("Must not replay an empty corpus"); });
  await expect(preflightRecording(c.destination, null, replay)).resolves.toBeUndefined();
  expect(replay).not.toHaveBeenCalled();
});

async function recorderProcess(replayExit: number) {
  const root = await mkdtemp(join(tmpdir(), "space-recorder-cli-test-"));
  roots.push(root);
  const scripts = join(root, "apps/worker/scripts");
  const histories = join(root, "apps/worker/tests/fixtures/workflow-histories");
  const runner = join(root, "node_modules/vitest");
  await Promise.all([scripts, histories, runner].map(path => mkdir(path, { recursive: true })));
  for (const name of ["record-temporal-histories.mjs", "temporal-history-store.mjs"]) {
    await copyFile(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), join(scripts, name));
  }
  const history = JSON.stringify({ workflowId: "synthetic", history: { events: [{ workflowTaskCompletedEventAttributes: {} }] } });
  await writeFile(join(histories, "goal.json"), history);
  // Exercise the real recorder's process sequencing without running Temporal.
  // This stand-in records which gate was requested; it does not claim replay.
  await writeFile(join(runner, "vitest.mjs"), `
    import { appendFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const recording = process.env.SPACE_RECORD_TEMPORAL_HISTORIES === "1";
    appendFileSync("order.txt", recording ? "record\\n" : "replay\\n");
    if (!recording) {
      if (!process.argv.includes("tests/temporal-replay.test.ts") ||
          !process.argv.includes("^replays every committed history against current production workflows$")) process.exit(99);
      process.exit(${replayExit});
    }
    writeFileSync(join(process.env.SPACE_TEMPORAL_HISTORY_DIRECTORY, "goal.json"), ${JSON.stringify(history)});
  `);
  const result = spawnSync(process.execPath, [join(scripts, "record-temporal-histories.mjs"), "--version", "patch-v2"], { encoding: "utf8" });
  return { result, histories, history, order: await readFile(join(root, "apps/worker/order.txt"), "utf8") };
}

it("CLI stops before recording or publishing when the replay process fails", async () => {
  const c = await recorderProcess(42);
  expect(c.result.status).toBe(1);
  expect(c.result.stderr).toContain("Existing history replay failed (exit 42)");
  expect(c.order).toBe("replay\n");
  expect(await readdir(c.histories)).toEqual(["goal.json"]);
  expect(await readFile(join(c.histories, "goal.json"), "utf8")).toBe(c.history);
});

it("CLI replays first, then publishes a version without replacing the baseline", async () => {
  const c = await recorderProcess(0);
  expect(c.result.status, c.result.stderr).toBe(0);
  expect(c.order).toBe("replay\nrecord\n");
  expect((await readdir(c.histories)).sort()).toEqual(["goal--patch-v2.json", "goal.json"]);
  expect(await readFile(join(c.histories, "goal.json"), "utf8")).toBe(c.history);
  expect(await readFile(join(c.histories, "goal--patch-v2.json"), "utf8")).toBe(c.history);
});
