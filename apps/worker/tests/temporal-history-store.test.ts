import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHistoryRecorder, loadHistories, type RecordedHistory } from "./temporal-history-store.js";

const directories: string[] = [];
const original = '{"workflowId":"old-run","history":{"events":[{"eventId":"1"}]}}\n';
const captured: RecordedHistory = { name: "dot-wake", workflowId: "new-run", history: { events: [] } };
async function fixture(withBaseline = true) {
  const directory = await mkdtemp(join(tmpdir(), "temporal-history-store-"));
  directories.push(directory);
  if (withBaseline) await writeFile(join(directory, "dot-wake.json"), original);
  return directory;
}
const passingReplay = async (histories: RecordedHistory[]) => histories.map(entry => ({ fixture: `${entry.name}.json` }));
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("immutable Temporal recording corpus", () => {
  it("records an initial empty corpus and refuses to replace it", async () => {
    const directory = await fixture(false);
    const replay = vi.fn(passingReplay);
    const record = await createHistoryRecorder({ directory, replay });
    await record([captured]);
    const initial = await readFile(join(directory, "dot-wake.json"), "utf8");
    expect(replay).not.toHaveBeenCalled();
    await expect(record([{ ...captured, workflowId: "replacement" }])).rejects.toThrow("Refusing to replace");
    expect(await readFile(join(directory, "dot-wake.json"), "utf8")).toBe(initial);
    expect(await loadHistories(directory)).toEqual([captured]);
  });

  it("requires a new version for a populated corpus without changing any file", async () => {
    const directory = await fixture();
    await expect(createHistoryRecorder({ directory, replay: passingReplay })).rejects.toThrow("use --version");
    expect(await readdir(directory)).toEqual(["dot-wake.json"]);
    expect(await readFile(join(directory, "dot-wake.json"), "utf8")).toBe(original);
  });

  it("replays the original corpus before returning a writer, then adds a distinct version", async () => {
    const directory = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const replay = vi.fn(async (histories: RecordedHistory[]) => {
      expect(histories[0]?.workflowId).toBe("old-run");
      expect(await readdir(directory)).toEqual(["dot-wake.json"]);
      await barrier;
      return passingReplay(histories);
    });
    let ready = false;
    const preparation = createHistoryRecorder({ directory, version: "patched-v2", replay }).then(record => { ready = true; return record; });
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    expect(ready).toBe(false);
    release();
    const record = await preparation;
    await record([captured]);
    expect(await readFile(join(directory, "dot-wake.json"), "utf8")).toBe(original);
    expect((await loadHistories(directory)).map(entry => entry.name)).toEqual(["dot-wake--patched-v2", "dot-wake"]);
    expect((await loadHistories(directory)).find(entry => entry.name.endsWith("--patched-v2"))?.workflowId).toBe("new-run");
  });

  it("rejects an incompatible existing history before a writer is available", async () => {
    const directory = await fixture();
    const error = new Error("nondeterministic timer");
    error.name = "DeterminismViolationError";
    await expect(createHistoryRecorder({ directory, version: "bad-change", replay: async () => [{ fixture: "dot-wake.json", error }] })).rejects.toThrow("Existing history replay failed (dot-wake.json)");
    expect(await readdir(directory)).toEqual(["dot-wake.json"]);
    expect(await readFile(join(directory, "dot-wake.json"), "utf8")).toBe(original);
  });

  it("propagates replay startup failure without writing", async () => {
    const directory = await fixture();
    await expect(createHistoryRecorder({ directory, version: "v2", replay: async () => { throw new Error("replay startup failed"); } })).rejects.toThrow("replay startup failed");
    expect(await readdir(directory)).toEqual(["dot-wake.json"]);
    expect(await readFile(join(directory, "dot-wake.json"), "utf8")).toBe(original);
  });

  it("refuses an incomplete replay result set", async () => {
    const directory = await fixture();
    await expect(createHistoryRecorder({ directory, version: "v2", replay: async () => [] })).rejects.toThrow("every result");
    expect(await readFile(join(directory, "dot-wake.json"), "utf8")).toBe(original);
  });

  it("rejects a reused version before writing any member of the batch", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "dot-wake--v2.json"), original);
    const record = await createHistoryRecorder({ directory, version: "v2", replay: passingReplay });
    await expect(record([{ ...captured, name: "new-name" }, captured])).rejects.toThrow("Refusing to replace");
    expect((await readdir(directory)).sort()).toEqual(["dot-wake--v2.json", "dot-wake.json"]);
    expect(await readFile(join(directory, "dot-wake--v2.json"), "utf8")).toBe(original);
  });

  it("preserves a colliding file created after recorder preparation", async () => {
    const directory = await fixture();
    const record = await createHistoryRecorder({ directory, version: "v2", replay: passingReplay });
    await writeFile(join(directory, "dot-wake--v2.json"), original);
    await expect(record([captured])).rejects.toThrow("Refusing to replace");
    expect(await readFile(join(directory, "dot-wake--v2.json"), "utf8")).toBe(original);
  });

  it("rejects unsafe names and duplicate batch names before writing", async () => {
    const directory = await fixture();
    const record = await createHistoryRecorder({ directory, version: "v2", replay: passingReplay });
    await expect(record([{ ...captured, name: "../escape" }])).rejects.toThrow("Unsafe fixture");
    await expect(record([captured, captured])).rejects.toThrow("Duplicate fixture");
    expect(await readdir(directory)).toEqual(["dot-wake.json"]);
  });

  it("rejects an unsafe version and keeps ordinary empty replay fail-closed", async () => {
    const directory = await fixture(false);
    await expect(createHistoryRecorder({ directory, version: "../escape", replay: passingReplay })).rejects.toThrow("History version");
    await expect(loadHistories(directory)).rejects.toThrow("No recorded histories");
    await expect(loadHistories(join(directory, "missing"))).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
});
