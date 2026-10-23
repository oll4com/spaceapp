import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spaceMemoryMonthlyPath } from "@space/runtime";
import { searchDefaultSpaceMemory } from "../src/memory-search.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe("default Space Memory search root", () => {
  it("searches only the process-configured canonical root", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-memory-search-root-"));
    roots.push(root);
    const previousRoot = process.env.SPACE_MEMORY_ROOT;
    process.env.SPACE_MEMORY_ROOT = root;
    try {
      const marker = "source-stack-memory-root-probe";
      const indexPath = join(root, "gemini_history.md");
      const monthlyPath = spaceMemoryMonthlyPath(new Date().toISOString().slice(0, 7));
      await writeFile(indexPath, `# ${marker}\n`);
      await writeFile(monthlyPath, `## ${marker} monthly entry\n`);

      const entries = await searchDefaultSpaceMemory({ page: 1, pageSize: 25, sortOrder: "desc", q: marker });
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.provenance.startsWith(root))).toBe(true);
      expect(entries.some((entry) => entry.body.includes(marker))).toBe(true);
    } finally {
      if (previousRoot === undefined) delete process.env.SPACE_MEMORY_ROOT;
      else process.env.SPACE_MEMORY_ROOT = previousRoot;
    }
  });
});
