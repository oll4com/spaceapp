import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const workflowNames = [
  "dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
  "roomAgentSupervisorWorkflow-legacy", "roomAgentActionWorkflow", "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow", "memoryMutationWorkflow"
];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRecorder() {
  const root = await mkdtemp(join(tmpdir(), "space-history-recorder-"));
  temporaryDirectories.push(root);
  const script = join(root, "scripts", "record-workflow-histories.mjs");
  const histories = join(root, "tests", "fixtures", "workflow-histories");
  const vitest = join(root, "node_modules", "vitest");
  await Promise.all([mkdir(join(root, "scripts")), mkdir(histories, { recursive: true }), mkdir(vitest, { recursive: true })]);
  await copyFile(new URL("../scripts/record-workflow-histories.mjs", import.meta.url), script);
  await writeFile(join(vitest, "package.json"), JSON.stringify({ name: "vitest", type: "module" }));
  // Replace only the scenario runner. Publication and archival use the actual recorder.
  await writeFile(join(vitest, "vitest.mjs"), `
    import { readFile, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const recording = JSON.parse(await readFile("recording.json", "utf8"));
    for (const [name, bytes] of Object.entries(recording.fixtures)) {
      await writeFile(join(process.env.SPACE_WORKFLOW_HISTORY_OUTPUT, name), bytes);
    }
    process.exitCode = recording.exitCode;
  `);
  return { root, script, histories };
}

function fixtures(generation: number) {
  return Object.fromEntries(workflowNames.map((name) => [
    `${name}.json`,
    JSON.stringify({ workflowId: `synthetic-${name}-${generation}`, history: { events: [{ eventId: String(generation) }] } }, null, 2) + "\n"
  ]));
}

async function record(
  recorder: Awaited<ReturnType<typeof createRecorder>>,
  contents: Record<string, string>,
  args: string[] = [],
  exitCode = 0,
  nodeArguments: string[] = []
) {
  await writeFile(join(recorder.root, "recording.json"), JSON.stringify({ fixtures: contents, exitCode }));
  return spawnSync(process.execPath, [...nodeArguments, recorder.script, ...args], {
    cwd: recorder.root,
    encoding: "utf8",
    timeout: 15_000
  });
}

async function recorderFaults(
  recorder: Awaited<ReturnType<typeof createRecorder>>,
  options: { publication?: boolean; archiveCleanup?: boolean; archiveWrite?: boolean; stagingCleanup?: boolean } = {}
) {
  const hook = join(recorder.root, "recorder-faults.mjs");
  await writeFile(hook, `
    import fs from "node:fs/promises";
    import crypto from "node:crypto";
    import { syncBuiltinESMExports } from "node:module";
    import { basename } from "node:path";
    crypto.randomUUID = () => "test-id";
    const open = fs.open;
    fs.open = async (path, flags, ...args) => {
      const handle = await open(path, flags, ...args);
      if (${Boolean(options.archiveWrite)} && flags === "wx" && String(path).endsWith("dotGoalWorkflow-pre-test-id.json")) {
        const writeFile = handle.writeFile.bind(handle);
        handle.writeFile = async () => {
          await writeFile("partial archive");
          throw Object.assign(new Error("archive-write-original-error"), { code: "EARCHIVE" });
        };
      }
      return handle;
    };
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      if (${Boolean(options.publication)} && String(target).endsWith("dotGoalWorkflow.json")) {
        throw Object.assign(new Error("fixture-publication-original-error"), { code: "EPUBLISH" });
      }
      return rename(source, target);
    };
    const rm = fs.rm;
    fs.rm = async (path, options) => {
      if (${Boolean(options.archiveCleanup)} && String(path).endsWith("dotGoalWorkflow-pre-test-id.json")) {
        throw Object.assign(new Error("archive-cleanup-secondary-error"), { code: "ECLEANUP" });
      }
      const result = await rm(path, options);
      if (${Boolean(options.stagingCleanup)} && basename(String(path)).startsWith(".record-")) {
        throw Object.assign(new Error("staging-cleanup-secondary-error"), { code: "ESTAGING" });
      }
      return result;
    };
    syncBuiltinESMExports();
  `);
  return ["--import", pathToFileURL(hook).href];
}

async function snapshot(directory: string) {
  const files = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(directory, file), "utf8")] as const)));
}

describe("workflow history recorder publication", () => {
  it("publishes an initial complete recording without archives", async () => {
    const recorder = await createRecorder();
    const initial = fixtures(1);
    const result = await record(recorder, initial);
    expect(result.status, result.stderr).toBe(0);
    expect(await snapshot(recorder.histories)).toEqual(initial);
  });

  it("refuses ordinary overwrites without changing existing histories", async () => {
    const recorder = await createRecorder();
    const initial = fixtures(1);
    expect((await record(recorder, initial)).status).toBe(0);
    const result = await record(recorder, fixtures(2));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Existing histories are compatibility contracts");
    expect(await snapshot(recorder.histories)).toEqual(initial);
  });

  it("keeps every older generation byte-for-byte in top-level replay discovery", async () => {
    const recorder = await createRecorder();
    const generations = [fixtures(1), fixtures(2), fixtures(3)];
    expect((await record(recorder, generations[0]!)).status).toBe(0);
    for (const generation of generations.slice(1)) {
      const result = await record(recorder, generation, ["--patched-change"]);
      expect(result.status, result.stderr).toBe(0);
    }
    const published = await snapshot(recorder.histories);
    // Replay discovers every top-level JSON, including archived histories.
    expect(Object.keys(published).filter((name) => name.endsWith(".json"))).toHaveLength(27);
    expect(Object.values(published).sort()).toEqual(generations.flatMap((generation) => Object.values(generation)).sort());
    for (const [name, bytes] of Object.entries(generations[2]!)) expect(published[name]).toBe(bytes);
    const workflowIds = Object.values(published).map((bytes) => JSON.parse(bytes).workflowId);
    expect(new Set(workflowIds).size).toBe(27);
  });

  it.each(["failed", "incomplete"])("leaves existing histories unchanged after a %s recording", async (failure) => {
    const recorder = await createRecorder();
    const initial = fixtures(1);
    expect((await record(recorder, initial)).status).toBe(0);
    const replacement = fixtures(2);
    if (failure === "incomplete") delete replacement["memoryMutationWorkflow.json"];
    const result = await record(recorder, replacement, ["--patched-change"], failure === "failed" ? 1 : 0);
    expect(result.status).not.toBe(0);
    expect(await snapshot(recorder.histories)).toEqual(initial);
  });

  it("removes only the newly created archive when publication fails", async () => {
    const recorder = await createRecorder();
    expect((await record(recorder, fixtures(1))).status).toBe(0);
    await writeFile(join(recorder.histories, "dotGoalWorkflow-pre-older-id.json"), fixtures(0)["dotGoalWorkflow.json"]!);
    const before = await snapshot(recorder.histories);
    const hook = await recorderFaults(recorder, { publication: true });
    const result = await record(recorder, fixtures(2), ["--patched-change"], 0, hook);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fixture-publication-original-error");
    expect(result.stderr).toContain("EPUBLISH");
    expect(await snapshot(recorder.histories)).toEqual(before);
  });

  it("retains a pre-existing archive when exclusive archival collides", async () => {
    const recorder = await createRecorder();
    expect((await record(recorder, fixtures(1))).status).toBe(0);
    await writeFile(join(recorder.histories, "dotGoalWorkflow-pre-test-id.json"), fixtures(0)["dotGoalWorkflow.json"]!);
    const before = await snapshot(recorder.histories);
    const hook = await recorderFaults(recorder);
    const result = await record(recorder, fixtures(2), ["--patched-change"], 0, hook);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EEXIST");
    expect(await snapshot(recorder.histories)).toEqual(before);
  });

  it("preserves the publication error if removing its new archive also fails", async () => {
    const recorder = await createRecorder();
    const initial = fixtures(1);
    expect((await record(recorder, initial)).status).toBe(0);
    const hook = await recorderFaults(recorder, { publication: true, archiveCleanup: true });
    const result = await record(recorder, fixtures(2), ["--patched-change"], 0, hook);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fixture-publication-original-error");
    expect(result.stderr).toContain("EPUBLISH");
    expect(result.stderr).not.toContain("archive-cleanup-secondary-error");
    expect(await snapshot(recorder.histories)).toEqual({
      ...initial,
      "dotGoalWorkflow-pre-test-id.json": initial["dotGoalWorkflow.json"]
    });
  });

  it("removes a partially written archive without changing live or older histories", async () => {
    const recorder = await createRecorder();
    expect((await record(recorder, fixtures(1))).status).toBe(0);
    await writeFile(join(recorder.histories, "dotGoalWorkflow-pre-older-id.json"), fixtures(0)["dotGoalWorkflow.json"]!);
    const before = await snapshot(recorder.histories);
    const hook = await recorderFaults(recorder, { archiveWrite: true });
    const result = await record(recorder, fixtures(2), ["--patched-change"], 0, hook);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("archive-write-original-error");
    expect(result.stderr).toContain("EARCHIVE");
    expect(await snapshot(recorder.histories)).toEqual(before);
  });

  it("preserves the publication error if staging cleanup also fails", async () => {
    const recorder = await createRecorder();
    expect((await record(recorder, fixtures(1))).status).toBe(0);
    await writeFile(join(recorder.histories, "dotGoalWorkflow-pre-older-id.json"), fixtures(0)["dotGoalWorkflow.json"]!);
    const before = await snapshot(recorder.histories);
    const hook = await recorderFaults(recorder, { publication: true, stagingCleanup: true });
    const result = await record(recorder, fixtures(2), ["--patched-change"], 0, hook);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("fixture-publication-original-error");
    expect(result.stderr).toContain("EPUBLISH");
    expect(result.stderr).not.toContain("staging-cleanup-secondary-error");
    expect(await snapshot(recorder.histories)).toEqual(before);
  });
});
