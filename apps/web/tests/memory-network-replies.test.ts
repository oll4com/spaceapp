// @vitest-environment node
import type { MemoryGraphNode } from "@space/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryAtlas } from "../src/features/memory-workspace/memory-atlas.js";
import { applyMemoryNetworkReply, memoryReplyTransferables, packMemoryAtlas, packMemoryDepth } from "../src/features/memory-workspace/memory-network-replies.js";
import type { MemoryNetworkLayoutMessage } from "../src/features/memory-workspace/memory-network-layout-protocol.js";

const makeNodes = (count: number): MemoryGraphNode[] => Array.from({ length: count }, (_, index) => ({
  id: `node:${count - index}`, type: index === 0 ? "SOURCE" : "MEMORY", label: index === 0 ? "gemini.md" : `Memory ${index}`,
  sourcePath: "/demo/space_memory_2026-10.md", recordId: null
}));
const initialReply = (nodes: MemoryGraphNode[]) => {
  const atlas = createMemoryAtlas(nodes, [], false, undefined, true);
  const points = new Map(nodes.map((node, index) => [node.id, { x: index + Math.PI, y: -index / 3, z: index / 7 }]));
  const message: MemoryNetworkLayoutMessage = { atlas: { ...atlas, nodes: [], edges: [], positions: new Map() }, rawGraph: true,
    packedAtlas: packMemoryAtlas(nodes, atlas.positions), packedDepth: packMemoryDepth(nodes, points), done: false, progress: 0 };
  return { atlas, points, message };
};

describe("packed memory layout replies", () => {
  afterEach(() => vi.restoreAllMocks());

  it("round trips raw topology order, colors, groups, months and hub flags through transferable buffers", async () => {
    const nodes = makeNodes(2101), { atlas, points, message } = initialReply(nodes);
    const buffers = memoryReplyTransferables(message);
    expect(buffers).toHaveLength(6);
    const received = structuredClone(message, { transfer: buffers });
    expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(received.atlas!.positions.size).toBe(0);
    expect(received.depth).toBeUndefined();
    const result = await applyMemoryNetworkReply(nodes, [], received, null);
    expect(result!.atlas.nodes).toBe(nodes);
    expect(result!.positions).toEqual(atlas.positions);
    expect(result!.atlas.positions).toBe(result!.positions);
    for (const node of nodes) {
      const point = points.get(node.id)!;
      expect(result!.depth.get(node.id)).toEqual({ x: Math.fround(point.x), y: Math.fround(point.y), z: Math.fround(point.z) });
    }
    expect(result!.depth.size).toBe(nodes.length);
    expect(result!.done).toBe(false);
  });

  it("keeps prior snapshots immutable and preserves atlas metadata when final coordinates arrive", async () => {
    const nodes = makeNodes(2101), { message } = initialReply(nodes);
    const previous = (await applyMemoryNetworkReply(nodes, [], message, null))!;
    const points = new Map(nodes.map((node, index) => [node.id, { x: index / 8, y: index / 4, z: index / 2 }]));
    const packedDepth = packMemoryDepth(nodes, points), packedPositions = new Float32Array(nodes.length * 2);
    nodes.forEach((_, index) => packedPositions.set([packedDepth[index * 3]!, packedDepth[index * 3 + 1]!], index * 2));
    const next = (await applyMemoryNetworkReply(nodes, [], { packedDepth, packedPositions, done: true, progress: 1 }, previous))!;
    expect(next.atlas).toBe(previous.atlas);
    expect(next.positions).not.toBe(previous.positions);
    expect(next.depth).not.toBe(previous.depth);
    for (const node of nodes) {
      const point = points.get(node.id)!;
      expect(next.positions.get(node.id)).toEqual({ ...previous.positions.get(node.id), x: point.x, y: point.y });
      expect(next.depth.get(node.id)).toEqual(point);
    }
    expect(previous.depth.get(nodes[0]!.id)!.x).toBe(Math.fround(Math.PI));
    expect(next).toMatchObject({ done: true, progress: 1 });
  });

  it("yields during large reply application and cancels without publishing a partial map", async () => {
    const nodes = makeNodes(3000), { message } = initialReply(nodes);
    let clock = 0, cancelled = false, heartbeat = false;
    vi.spyOn(performance, "now").mockImplementation(() => clock += 10);
    setTimeout(() => { heartbeat = true; cancelled = true; }, 0);
    expect(await applyMemoryNetworkReply(nodes, [], message, null, () => cancelled)).toBeNull();
    expect(heartbeat).toBe(true);
  });

  it("rejects coordinate buffers that do not match the known topology", async () => {
    const nodes = makeNodes(2), { message } = initialReply(nodes);
    await expect(applyMemoryNetworkReply(nodes, [], { ...message, packedDepth: new Float32Array(3) }, null)).rejects.toThrow("topology");
    await expect(applyMemoryNetworkReply(nodes, [], { ...message, packedPositions: new Float32Array(1) }, null)).rejects.toThrow("topology");
  });
});
