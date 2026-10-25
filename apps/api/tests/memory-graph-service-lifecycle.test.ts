// Snapshot cache lifecycle around canonical memory changes: a save or a
// deletion makes the cached graph stale, invalidation forces a rebuild, and an
// invalidation racing an in-flight build never yields a stale graph that is
// reported (or cached) as fresh.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calculateMemoryGraphSourceHash } from "@space/memory-graph";
import { createMemoryGraphService } from "../src/memory-graph-service.js";

const record = (id: string, title: string) => `<!-- space-memory:id=${id} -->\n## 2026-07-13 08:00 EEST - ${title}\n\n- body of ${title}\n`;

async function fixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `space-memory-lifecycle-${label}-`));
  const indexPath = join(root, "gemini_history.md");
  const monthlyPath = join(root, "gemini_history_2026-07.md");
  const index = "# History\n\n## Current month\n";
  await writeFile(indexPath, index, "utf8");
  const write = async (monthly: string) => {
    await writeFile(monthlyPath, monthly, "utf8");
    return calculateMemoryGraphSourceHash([
      { path: indexPath, kind: "INDEX", content: index },
      { path: monthlyPath, kind: "MONTHLY", content: monthly }
    ]);
  };
  const service = createMemoryGraphService({ rootDir: join(root, "graph"), indexPath, monthlyPath, now: () => new Date("2026-07-13T09:00:00.000Z") });
  return { service, write };
}

describe("memory graph snapshot lifecycle", () => {
  it("goes stale on save and on deletion, and rebuilds only the current records after invalidation", async () => {
    const { service, write } = await fixture("save-delete");
    const first = await write(`# July\n\n${record("memory:alpha", "Alpha")}`);
    const initial = await service.getSnapshot();
    expect(initial).toMatchObject({ isStale: false, snapshot: { sourceHash: first } });

    const saved = await write(`# July\n\n${record("memory:alpha", "Alpha")}\n${record("memory:beta", "Beta")}`);
    expect((await service.getSnapshot()).isStale).toBe(true);
    expect(await service.getCachedSnapshot()).toBeNull();
    await service.invalidateCachedSnapshot();
    const afterSave = await service.getSnapshot();
    expect(afterSave).toMatchObject({ isStale: false, snapshot: { sourceHash: saved } });
    expect(afterSave.snapshot.records.map((item) => item.id).sort()).toEqual(["memory:alpha", "memory:beta"]);

    const deleted = await write(`# July\n\n${record("memory:beta", "Beta")}`);
    expect((await service.getSnapshot()).isStale).toBe(true);
    await service.invalidateCachedSnapshot();
    const afterDelete = await service.getSnapshot();
    expect(afterDelete).toMatchObject({ isStale: false, snapshot: { sourceHash: deleted } });
    expect(afterDelete.snapshot.records.map((item) => item.id)).toEqual(["memory:beta"]);
    expect((await service.getCachedSnapshot())?.sourceHash).toBe(deleted);
  }, 30_000);

  it("never reports or caches a pre-save graph as fresh when invalidation races an in-flight build", async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { service, write } = await fixture(`race-${attempt}`);
      await write(`# July\n\n${record("memory:alpha", "Alpha")}`);
      const building = service.getSnapshot();
      const current = await write(`# July\n\n${record("memory:alpha", "Alpha")}\n${record("memory:gamma", "Gamma")}`);
      await Promise.all([building, service.invalidateCachedSnapshot()]);

      const state = await service.getSnapshot();
      if (state.snapshot.sourceHash !== current) expect(state.isStale).toBe(true);
      const cached = await service.getCachedSnapshot();
      if (cached) expect(cached.sourceHash).toBe(current);

      // One more invalidation always converges on the saved state.
      await service.invalidateCachedSnapshot();
      const converged = await service.getSnapshot();
      expect(converged).toMatchObject({ isStale: false, snapshot: { sourceHash: current } });
      expect(converged.snapshot.records.map((item) => item.id).sort()).toEqual(["memory:alpha", "memory:gamma"]);
    }
  }, 60_000);

  it("serves one shared build to concurrent readers and persists it once", async () => {
    const { service, write } = await fixture("readers");
    const hash = await write(`# July\n\n${record("memory:alpha", "Alpha")}`);
    const results = await Promise.all(Array.from({ length: 6 }, () => service.getSnapshot()));
    expect(new Set(results.map((result) => result.snapshot.revisionHash)).size).toBe(1);
    expect(results.every((result) => !result.isStale && result.snapshot.sourceHash === hash)).toBe(true);
  }, 30_000);
});
