import { describe, expect, it } from "vitest";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import { layoutMemoryNetwork } from "../src/features/memory-workspace/memory-network-layout.js";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";

const node = (id: string, type: MemoryGraphNode["type"] = "MEMORY"): MemoryGraphNode => ({ id, type, label: id, recordId: type === "MEMORY" ? id : null, sourcePath: null });
const edge = (id: string, source: string, target: string, type: MemoryGraphEdge["type"] = "TAGGED_WITH"): MemoryGraphEdge => ({ id, source, target, type, origin: "EXPLICIT_TAG" });

describe("Memory atlas data integrity", () => {
  it("preserves source files, memories, isolates and real provenance links", () => {
    const nodes = [node("a"), node("b"), node("isolated"), node("tag", "TOPIC"), node("file", "SOURCE")];
    const edges = [edge("at", "a", "tag"), edge("bt", "b", "tag"), edge("source", "file", "a", "CONTAINS")];
    const atlas = createMemoryAtlas(nodes, edges, true, 2);
    expect(atlas.nodes.map(n => n.id)).toEqual(["a", "b", "isolated", "tag", "file"]);
    expect(atlas.edges.map(e => e.id)).toEqual(["at", "bt", "source"]);
    expect(atlas.topics[0]).toMatchObject({ id: "tag", count: 2, explicit: true });
    expect(atlas.positions.get("a")?.color).toBe(atlas.positions.get("tag")?.color);
    expect(atlas.positions.has("isolated")).toBe(true);
  });
  it("does not fabricate relationships and produces finite stable positions for large graphs", () => {
    const nodes = Array.from({ length: 2000 }, (_, i) => node(`memory:${i}`));
    const atlas = createMemoryAtlas(nodes, []);
    expect(atlas.edges).toEqual([]);
    expect(atlas.nodes).toHaveLength(2000);
    expect(atlas.positions).toEqual(createMemoryAtlas([...nodes].reverse(), []).positions);
    expect([...atlas.positions.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
  it("derives positions from real edges and anchors the actual entrypoint", () => {
    const root = { ...node("root", "SOURCE"), label: "gemini.md" };
    const nodes = [root, node("a"), node("b")];
    const unlinked = layoutMemoryNetwork(nodes, []);
    const linked = layoutMemoryNetwork(nodes, [edge("link", "root", "a", "CONTAINS")]);
    expect(linked.get("root")).toEqual({ x: 0, y: 0 });
    expect(linked.get("a")).not.toEqual(unlinked.get("a"));
    const distance = (p: { x: number; y: number }) => Math.hypot(p.x, p.y);
    expect(distance(linked.get("a")!)).toBeLessThan(distance(unlinked.get("a")!));
  });
  it("keeps structural search results usable when no memories are returned", () => {
    const atlas = createMemoryAtlas([node("source", "SOURCE")], []);
    expect(atlas.nodes).toHaveLength(1);
    expect(atlas.positions.has("source")).toBe(true);
  });
  it("labels derived topics separately and ignores dangling edge endpoints", () => {
    const atlas = createMemoryAtlas([node("a"), node("b"), node("theme", "TOPIC")], [
      { ...edge("a", "a", "theme"), origin: "DERIVED_TFIDF" },
      { ...edge("b", "b", "theme"), origin: "DERIVED_TFIDF" },
      edge("missing", "missing", "theme")
    ]);
    expect(atlas.topics[0]).toMatchObject({ explicit: false, count: 2 });
    expect(atlas.edges).toHaveLength(2);
  });
  it("uses real source months for distinct labeled groups when tags are absent", () => {
    const nodes = [
      { ...node("may"), sourcePath: "/opt/spaceapp/docs/gemini_history_2026-05.md" },
      { ...node("june"), sourcePath: "/opt/spaceapp/docs/gemini_history_2026-06.md" },
      node("undated")
    ];
    const atlas = createMemoryAtlas(nodes, []);
    expect(atlas.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "May 2026", kind: "month", count: 1 }),
      expect.objectContaining({ label: "Jun 2026", kind: "month", count: 1 }),
      expect.objectContaining({ label: "Other knowledge", kind: "archive" })
    ]));
    expect(atlas.positions.get("may")?.color).not.toBe(atlas.positions.get("june")?.color);
    expect(atlas.positions.get("may")?.groupId).toBe("month:2026-05");
    expect(atlas.edges).toEqual([]);
  });
  it("colors real themes inside one cloud without duplicate tags consuming the palette", () => {
    const nodes = [node("a"), node("b"), node("c"), node("space", "TOPIC"), node("alias", "TOPIC"), node("other", "TOPIC")];
    const atlas = createMemoryAtlas(nodes, [edge("a1", "a", "space"), edge("b1", "b", "space"), edge("a2", "a", "alias"), edge("b2", "b", "alias"), edge("c1", "c", "other")], true, 1);
    expect(atlas.topics).toHaveLength(2);
    expect(atlas.groups).toHaveLength(2);
    expect(atlas.positions.get("a")?.color).not.toBe(atlas.positions.get("c")?.color);
    expect([...atlas.positions.values()].every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
  });
  it("ignores tags with fewer than 10 records by default", () => {
    const nodes = [
      ...Array.from({ length: 9 }, (_, i) => node(`mem:${i}`)),
      node("rare-tag", "TOPIC")
    ];
    const edges = Array.from({ length: 9 }, (_, i) => edge(`e:${i}`, `mem:${i}`, "rare-tag"));
    const atlas = createMemoryAtlas(nodes, edges);
    expect(atlas.topics).toHaveLength(0);
    expect(atlas.groups.some(g => g.id === "rare-tag")).toBe(false);
  });
  it("includes tags with 10 or more records by default", () => {
    const nodes = [
      ...Array.from({ length: 10 }, (_, i) => node(`mem:${i}`)),
      node("frequent-tag", "TOPIC")
    ];
    const edges = Array.from({ length: 10 }, (_, i) => edge(`e:${i}`, `mem:${i}`, "frequent-tag"));
    const atlas = createMemoryAtlas(nodes, edges);
    expect(atlas.topics).toHaveLength(1);
    expect(atlas.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "frequent-tag", kind: "tag", count: 10 })
    ]));
  });
});
