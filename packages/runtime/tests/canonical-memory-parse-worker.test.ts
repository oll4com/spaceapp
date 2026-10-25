import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanonicalSpaceMemoryBridge } from "../src/shared-state.js";

// Counts the parse workers the memory reader starts: one for the process, not one per source (2026-10-25).
const started = vi.hoisted(() => ({ workers: 0 }));
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  class CountedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      started.workers += 1;
    }
  }
  return { ...actual, Worker: CountedWorker };
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const query = { page: 1, pageSize: 25, sortOrder: "desc" as const, searchMode: "keyword" as const };

describe("canonical memory parse worker", () => {
  it("parses every source and every later read in one long-lived worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-worker-")); roots.push(root);
    const paths = { indexPath: join(root, "space_memory.md"), monthlyPath: join(root, "space_memory_2026-10.md") };
    await writeFile(paths.indexPath, "# Space Memory\n\n- IndexOnly reference\n");
    await writeFile(join(root, "space_memory_2026-09.md"), "# September\n\n## 2026-09-12 - SeptemberFact\n\n- Older month body\n");
    await writeFile(paths.monthlyPath, "# October\n\n## 2026-10-12 - OctoberFact\n\n- Current month body\n");
    const bridge = createCanonicalSpaceMemoryBridge(paths);
    expect(await bridge.list({ ...query, q: "SeptemberFact" })).toHaveLength(1);
    await appendFile(paths.monthlyPath, "\n## 2026-10-13 - LaterFact\n\n- Written after the first read\n");
    expect(await bridge.list({ ...query, q: "LaterFact" })).toHaveLength(1);
    expect(started.workers).toBe(1);
  }, 15_000);
});
