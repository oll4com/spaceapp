import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCanonicalSpaceMemoryBridge, defaultCanonicalSpaceMemoryPaths, resolveCanonicalSpaceMemoryPaths } from "../src/shared-state.js";
import { SPACE_MEMORY_DIRECTORY, usesLegacyMemoryFiles } from "../src/space-memory-files.js";

describe("canonical Space Memory paths", () => {
  it("uses the Athens calendar month and one shared default lock", () => {
    const paths = resolveCanonicalSpaceMemoryPaths({}, new Date("2026-06-30T22:30:00.000Z"));
    const name = usesLegacyMemoryFiles(SPACE_MEMORY_DIRECTORY) ? "gemini_history" : "space_memory";

    expect(paths).toEqual({
      indexPath: `/opt/spaceapp/docs/${name}.md`,
      monthlyPath: `/opt/spaceapp/docs/${name}_2026-07.md`,
      lockPath: `/opt/spaceapp/docs/${name}_2026-07.md.lock`
    });
  });

  it("keeps every explicit canonical path on the same lock contract", () => {
    expect(resolveCanonicalSpaceMemoryPaths({
      SPACE_GEMINI_MEMORY_INDEX_PATH: "/tmp/index.md",
      SPACE_GEMINI_MEMORY_MONTHLY_PATH: "/tmp/monthly.md",
      SPACE_GEMINI_MEMORY_LOCK_PATH: "/tmp/canonical-memory.lock"
    })).toEqual({
      indexPath: "/tmp/index.md",
      monthlyPath: "/tmp/monthly.md",
      lockPath: "/tmp/canonical-memory.lock"
    });
  });

  it("keeps source-stack canonical reads and writes under SPACE_MEMORY_ROOT", () => {
    const root = "/tmp/owned-source-stack/memory";
    const paths = resolveCanonicalSpaceMemoryPaths({ SPACE_MEMORY_ROOT: root }, new Date("2026-06-30T22:30:00.000Z"));
    expect(paths).toEqual({
      indexPath: `${root}/gemini_history.md`,
      monthlyPath: `${root}/gemini_history_2026-07.md`,
      lockPath: `${root}/gemini_history_2026-07.md.lock`
    });
  });

  it("uses the process root for default canonical paths", () => {
    const previousRoot = process.env.SPACE_MEMORY_ROOT;
    process.env.SPACE_MEMORY_ROOT = "/tmp/owned-process-memory";
    try {
      expect(defaultCanonicalSpaceMemoryPaths(new Date("2026-06-30T22:30:00.000Z"))).toEqual({
        indexPath: "/tmp/owned-process-memory/gemini_history.md",
        monthlyPath: "/tmp/owned-process-memory/gemini_history_2026-07.md",
        lockPath: "/tmp/owned-process-memory/gemini_history_2026-07.md.lock"
      });
    } finally {
      if (previousRoot === undefined) delete process.env.SPACE_MEMORY_ROOT;
      else process.env.SPACE_MEMORY_ROOT = previousRoot;
    }
  });

  it("writes a stable marker that matches the returned canonical memory id", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "space-canonical-memory-"));
    const monthlyPath = join(rootDir, "gemini_history_2026-07.md");
    const bridge = createCanonicalSpaceMemoryBridge({
      indexPath: join(rootDir, "gemini_history.md"),
      monthlyPath,
      lockPath: join(rootDir, "gemini_history.lock")
    });

    try {
      const entry = await bridge.save({
        scope: "SYSTEM",
        roomId: null,
        title: "Stable marker",
        body: "The marker and returned entry must identify the same canonical block.",
        provenance: "runtime-test",
        tags: ["Space-Agent", "Μνήμη έργου"]
      });
      const canonical = await readFile(monthlyPath, "utf8");

      expect(canonical).toContain(`<!-- space-memory:id=${entry.id} -->\n## `);
      expect(canonical).toContain("- Tags: Space-Agent, Μνήμη έργου\n");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
