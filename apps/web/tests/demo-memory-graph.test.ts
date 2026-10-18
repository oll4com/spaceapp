import { memoryGraphNodeDetailSchema, memoryGraphOverviewPayloadSchema } from "@space/contracts";
import { describe, expect, it, vi } from "vitest";
import { DemoStore } from "../src/demo/DemoStore.js";
import { demoMemoryNodeCount } from "../src/demo/demo-memory-graph.js";

describe("large local memory demo", () => {
  it.each([2000, 10_000, 50_000] as const)("generates a deterministic %i-node graph without network services", async count => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Demo must remain offline"));
    try {
      const store = new DemoStore(undefined, { memoryNodes: count });
      const response = await store.api.memoryGraphOverview({ limit: 50_000, month: "all", relationMode: "RELATIONS" });
      expect(response.data.nodes).toHaveLength(count);
      expect(response.data.edges).toHaveLength((count - 9) * 3);
      expect(response.data.truncated).toBe(false);
      expect(response.data.summary.nodeCount).toBe(count);
      const ids = new Set(response.data.nodes.map(node => node.id));
      expect(response.data.edges.every(edge => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
      expect(memoryGraphOverviewPayloadSchema.safeParse(response.data).success).toBe(true);
      const again = await store.api.memoryGraphOverview({ limit: 50_000, month: "all", relationMode: "RELATIONS" });
      expect(again).toBe(response);
      const detail = await store.api.memoryGraphNode("memory:synthetic:100");
      expect(memoryGraphNodeDetailSchema.safeParse(detail).success).toBe(true);
      expect(detail.record?.body).toContain("Synthetic demo memory");
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });

  it("bounds the default overview and supports local search and node detail", async () => {
    const store = new DemoStore(undefined, { memoryNodes: 10_000 });
    const overview = await store.api.memoryGraphOverview();
    expect(overview.data.nodes).toHaveLength(2000);
    expect(overview.data.edges.length).toBeLessThanOrEqual(6000);
    expect(overview.data).toMatchObject({ totalMatchingNodes: 10_000, truncated: true });
    const search = await store.api.memoryGraphOverview({ q: "Design memory 100", limit: 50_000, relationMode: "CLUSTERED" });
    expect(search.data.nodes.length).toBeGreaterThan(0);
    expect(search.data.nodes.every(node => node.label.includes("Design memory 100"))).toBe(true);
    expect((await store.api.memoryGraphNode(search.data.nodes[0]!.id)).node.id).toBe(search.data.nodes[0]!.id);
    await expect(store.api.memoryGraphNode("memory:synthetic:999999")).rejects.toMatchObject({ status: 404 });
  });

  it("accepts only the documented fixture sizes", () => {
    expect(demoMemoryNodeCount("2000")).toBe(2000);
    expect(demoMemoryNodeCount("10000")).toBe(10_000);
    expect(demoMemoryNodeCount("50000")).toBe(50_000);
    expect(demoMemoryNodeCount("50001")).toBeUndefined();
    expect(demoMemoryNodeCount(null)).toBeUndefined();
  });
});
