import { MessageChannel } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMemoryArchive } from "../src/features/memory-workspace/memory-archive-worker.js";
import type { MemoryArchiveMessage } from "../src/features/memory-workspace/memory-archive-protocol.js";

describe("large memory graph worker protocol", () => {
  let messages: MemoryArchiveMessage[];
  beforeEach(() => {
    messages = [];
    vi.stubGlobal("MessageChannel", MessageChannel);
    vi.stubGlobal("self", { postMessage: (message: MemoryArchiveMessage, options: { transfer: ArrayBuffer[] }) => {
      messages.push(structuredClone(message, { transfer: options.transfer }));
    } });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads a bounded, network-free demo and transfers complete layout frames", async () => {
    await loadMemoryArchive({ kind: "archive", demo: true, count: 2100, query: "" });
    expect(fetch).not.toHaveBeenCalled();
    expect(messages.some(message => message.kind === "error")).toBe(false);
    const nodes = messages.filter(message => message.kind === "nodes");
    const edges = messages.filter(message => message.kind === "edges");
    const positions = messages.filter(message => message.kind === "positions");
    expect(nodes.reduce((count, chunk) => count + chunk.nodes.length, 0)).toBe(2100);
    expect(edges.reduce((count, chunk) => count + chunk.edges.length, 0)).toBe(6300);
    expect(nodes.every(chunk => chunk.nodes.length <= 1000)).toBe(true);
    expect(edges.every(chunk => chunk.edges.length <= 3000)).toBe(true);
    expect(positions.every(chunk => chunk.positions.length <= 1000)).toBe(true);
    const ready = messages.find(message => message.kind === "ready");
    expect(ready?.model.neighborOffsets).toHaveLength(2101);
    expect(ready?.model.neighborIndices).toHaveLength(12600);
    const frames = messages.filter(message => message.kind === "frame");
    expect(frames[0]?.step).toBe(0);
    expect(frames.at(-1)).toMatchObject({ step: 180, done: true });
    expect(frames.every(frame => frame.xyz.length === 6300 && frame.xyz.every(Number.isFinite))).toBe(true);
    expect(frames[0]?.xyz).not.toEqual(frames.at(-1)?.xyz);
  });

  it("uses the admin endpoint with same-origin credentials and reports failure without partial graph", async () => {
    const request = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    vi.stubGlobal("fetch", request);
    await loadMemoryArchive({ kind: "archive", demo: false, count: 50000, query: "release notes" });
    expect(request).toHaveBeenCalledWith("/api/admin/memory/graph/overview?month=all&relationMode=RELATIONS&limit=50000&q=release+notes", { credentials: "same-origin", cache: "no-store" });
    expect(messages).toEqual([{ kind: "error", message: "Memory graph request failed (403)." }]);
  });

  it("filters demo queries before transferring nodes and keeps only matching endpoints", async () => {
    await loadMemoryArchive({ kind: "archive", demo: true, count: 80, query: "space.md" });
    const nodes = messages.filter(message => message.kind === "nodes").flatMap(message => message.nodes);
    const ids = new Set(nodes.map(node => node.id));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.label).toBe("space.md");
    expect(messages.filter(message => message.kind === "edges").flatMap(message => message.edges).every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
  });
});
