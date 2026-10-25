import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { buildMemoryGraphSnapshot } from "@space/memory-graph";
import { createMemorySourceTopology } from "../src/memory-source-topology.js";

describe("canonical file topology", () => {
  it("follows existing local references, preserves record provenance and rejects external symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-topology-"));
    const outside = await mkdtemp(join(tmpdir(), "memory-topology-outside-"));
    try {
      const indexPath = join(root, "gemini_history.md");
      const monthPath = join(root, "gemini_history_2026-09.md");
      const indexContent = "# History\nRead `gemini_history_2026-09.md`.\n";
      const monthContent = "# History\n\n## 2026-09-30 10:00 EEST - A memory\n\nA durable fact.\n";
      await writeFile(join(root, "gemini.md"), "# Core\nRead `gemini_history.md`, `rules.md`, `missing.md` and `external.md`.\n");
      await writeFile(indexPath, indexContent);
      await writeFile(monthPath, monthContent);
      await writeFile(join(root, "rules.md"), "# Rules\nRead `gemini.md`.\n");
      await writeFile(join(outside, "external.md"), "Private external content");
      await symlink(join(outside, "external.md"), join(root, "external.md"));
      const original = buildMemoryGraphSnapshot({ generatedAt: "2026-09-30T10:00:00Z", sources: [{ path: indexPath, kind: "INDEX", content: indexContent }, { path: monthPath, kind: "MONTHLY", content: monthContent }] });
      const enriched = await createMemorySourceTopology(indexPath)(original);
      const source = (label: string) => enriched.nodes.find(node => node.type === "SOURCE" && node.label === label)!;
      expect(source("gemini.md")).toBeDefined();
      expect(source("rules.md")).toBeDefined();
      expect(source("missing.md")).toBeUndefined();
      expect(source("external.md")).toBeUndefined();
      expect(enriched.edges).toContainEqual(expect.objectContaining({ source: source("gemini.md").id, target: source("gemini_history.md").id, type: "DERIVED_FROM", evidence: "gemini.md references gemini_history.md." }));
      expect(enriched.edges).toContainEqual(expect.objectContaining({ source: source("gemini_history_2026-09.md").id, target: original.records[0]!.id, type: "CONTAINS" }));
      expect(enriched.records).toBe(original.records);
      expect(original.nodes.some(node => node.label === "gemini.md")).toBe(false);
      expect(new Set(enriched.edges.map(edge => edge.id)).size).toBe(enriched.edges.length);
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
});
