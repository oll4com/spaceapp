import { describe, expect, it, vi } from "vitest";
import type { MemoryGraphNode } from "@space/contracts";
import { MemoryLabelCache } from "../src/features/memory-workspace/memory-label-cache.js";
import { MEMORY_LABEL_CANDIDATES, memoryLabelCandidates, memoryLabelsAtZoom } from "../src/features/memory-workspace/memory-webgl-data.js";

const nodes: MemoryGraphNode[] = Array.from({ length: 2000 }, (_, index) => ({
  id: `node:${index}`, type: index < 20 ? "SOURCE" : "MEMORY",
  label: index === 1000 ? "space.md" : `Node ${index}`, recordId: null, sourcePath: null
}));
const candidates = memoryLabelCandidates(nodes);

describe("memory label cache", () => {
  it("preserves core/source priority, zoom boundaries and focus changes while reusing stable lists", () => {
    const cache = new MemoryLabelCache(nodes, candidates);
    for (const zoom of [0.5, 1, 1.599, 1.6, 2, 1]) {
      for (const focus of [-1, 0, 1999, 1000, -1]) {
        const actual = cache.atZoom(zoom, focus);
        expect(actual).toEqual(memoryLabelsAtZoom(nodes, candidates, zoom, focus));
        expect(actual.length).toBeLessThanOrEqual(MEMORY_LABEL_CANDIDATES);
        expect(cache.atZoom(zoom, focus)).toBe(actual);
      }
    }
    const unzoomed = cache.atZoom(1, -1);
    expect(cache.atZoom(1.5, -1)).toBe(unzoomed);
    expect(unzoomed[0]).toBe(1000);
  });

  it("measures each cached title once and bounds retention when focus visits many nodes", () => {
    const cache = new MemoryLabelCache(nodes, candidates);
    const measure = vi.fn((text: string) => text.length * 5);
    const first = cache.measure(0, measure);
    expect(first).toEqual({ text: "Node 0", width: 30 });
    expect(cache.measure(0, measure)).toBe(first);
    expect(measure).toHaveBeenCalledTimes(1);
    for (let index = 1; index <= MEMORY_LABEL_CANDIDATES + 1; index++) cache.measure(index, measure);
    const calls = measure.mock.calls.length;
    cache.measure(MEMORY_LABEL_CANDIDATES + 1, measure);
    expect(measure).toHaveBeenCalledTimes(calls);
    cache.measure(0, measure);
    expect(measure).toHaveBeenCalledTimes(calls + 1);
  });

  it("measures the displayed truncated text and starts fresh for a replacement graph", () => {
    const measure = vi.fn((text: string) => text.length * 5);
    const long = new MemoryLabelCache([{ ...nodes[0]!, label: "a".repeat(49) }], [0]);
    expect(long.measure(0, measure)).toEqual({ text: `${"a".repeat(45)}…`, width: 230 });
    expect(measure).toHaveBeenLastCalledWith(`${"a".repeat(45)}…`);
    const replacement = new MemoryLabelCache([{ ...nodes[0]!, label: "New title" }], [0]);
    expect(replacement.measure(0, measure)).toEqual({ text: "New title", width: 45 });
  });
});
