import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalSpaceMemoryBridge, resolveCanonicalGeminiMemoryPaths, resolveCanonicalSpaceMemoryPaths } from "../src/shared-state.js";
import {
  isMemoryCoreFile,
  isMonthlyMemoryFile,
  monthOfMemoryFile,
  spaceAgentCorePath,
  spaceMemoryIndexPath,
  spaceMemoryMonthlyPath,
  usesLegacyMemoryFiles
} from "../src/space-memory-files.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "space-memory-files-"));
  roots.push(root);
  return root;
}
const query = { page: 1, pageSize: 25, sortOrder: "desc" as const, searchMode: "keyword" as const };

describe("Space Memory files", () => {
  it("keeps the legacy gemini_history files until the index is renamed", async () => {
    const root = await directory();
    await writeFile(join(root, "gemini_history.md"), "# History\n");
    await writeFile(join(root, "gemini.md"), "# Core\n");
    expect(usesLegacyMemoryFiles(root)).toBe(true);
    expect(spaceMemoryIndexPath(root)).toBe(join(root, "gemini_history.md"));
    expect(spaceMemoryMonthlyPath("2026-10", root)).toBe(join(root, "gemini_history_2026-10.md"));
    expect(spaceAgentCorePath(root)).toBe(join(root, "gemini.md"));

    await writeFile(join(root, "space_memory.md"), "# Space Memory\n");
    await writeFile(join(root, "space.md"), "# Core\n");
    expect(usesLegacyMemoryFiles(root)).toBe(false);
    expect(spaceMemoryIndexPath(root)).toBe(join(root, "space_memory.md"));
    expect(spaceMemoryMonthlyPath("2026-10", root)).toBe(join(root, "space_memory_2026-10.md"));
    expect(spaceAgentCorePath(root)).toBe(join(root, "space.md"));
  });

  it("recognizes both file name sets", () => {
    expect(monthOfMemoryFile("/opt/spaceapp/docs/space_memory_2026-10.md")).toBe("2026-10");
    expect(monthOfMemoryFile("/opt/spaceapp/docs/gemini_history_2026-09.md")).toBe("2026-09");
    expect(monthOfMemoryFile("/opt/spaceapp/docs/spaceapp_release_memory.md")).toBeNull();
    expect(isMonthlyMemoryFile("space_memory.md")).toBe(false);
    expect(isMemoryCoreFile("space.md") && isMemoryCoreFile("gemini.md")).toBe(true);
    expect(isMemoryCoreFile("space_tool_selection.md")).toBe(false);
  });

  it("prefers SPACE_MEMORY_* and still reads the legacy SPACE_GEMINI_MEMORY_* names", () => {
    expect(resolveCanonicalSpaceMemoryPaths({
      SPACE_MEMORY_INDEX_PATH: "/tmp/index.md",
      SPACE_GEMINI_MEMORY_INDEX_PATH: "/tmp/legacy-index.md",
      SPACE_GEMINI_MEMORY_MONTHLY_PATH: "/tmp/monthly.md"
    })).toEqual({ indexPath: "/tmp/index.md", monthlyPath: "/tmp/monthly.md", lockPath: "/tmp/monthly.md.lock" });
    expect(resolveCanonicalGeminiMemoryPaths).toBe(resolveCanonicalSpaceMemoryPaths);
  });

  it("saves space_memory ids and reads renamed and legacy monthly files together", async () => {
    const root = await directory();
    const paths = { indexPath: join(root, "space_memory.md"), monthlyPath: join(root, "space_memory_2026-10.md") };
    await writeFile(paths.indexPath, "# Space Memory\n");
    await writeFile(join(root, "gemini_history_2026-09.md"), "# September\n\n## 2026-09-30 10:00 EEST — Legacy month entry\n\n- Kept readable after the rename.\n");
    const bridge = createCanonicalSpaceMemoryBridge(paths);
    const saved = await bridge.save({ scope: "SYSTEM", title: "Renamed month entry", body: "Written to the Space Memory file.", provenance: "test" });
    expect(saved.id).toMatch(/^space_memory:/);
    expect(saved.provenance).toBe(paths.monthlyPath);
    const titles = (await bridge.list(query)).map((entry) => entry.title);
    expect(titles).toEqual(expect.arrayContaining(["Renamed month entry", "Legacy month entry"]));
  }, 15_000); // reads parse each source in a fresh worker thread (about a second per source)
});
