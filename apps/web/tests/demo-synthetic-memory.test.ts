import { describe, expect, it } from "vitest";
import { memoryGraphNodeDetailSchema, memoryGraphOverviewPayloadSchema, memoryGraphPayloadSchema } from "@space/contracts";
import { createSyntheticMemoryGraph } from "../src/demo/synthetic-memory.js";
import { DemoStore } from "../src/demo/DemoStore.js";

describe("synthetic demo memory graph (issue #62)", () => {
  it("generates deterministic, contract-valid graphs at 2k, 10k and 50k nodes", () => {
    for (const size of [2000, 10000, 50000]) {
      const first = createSyntheticMemoryGraph(size);
      const second = createSyntheticMemoryGraph(size);
      expect(first).toEqual(second);
      expect(first.nodes.length).toBe(size);
      expect(first.summary.sourceCount).toBeLessThanOrEqual(24);
      expect(first.edges.length).toBeGreaterThan(0);
      expect(first.edges.length).toBeLessThanOrEqual(150000);
      // Synthetic graphs are served through the overview payload schema.
      const parsed = memoryGraphOverviewPayloadSchema.parse({ ...first, totalMatchingNodes: first.nodes.length, totalMatchingEdges: first.edges.length, truncated: false });
      expect(parsed.nodes).toEqual(first.nodes);
      expect(parsed.edges).toEqual(first.edges);
      expect(parsed.summary).toEqual(first.summary);
    }
  });

  it("keeps the curated fixture for the default view and serves synthetic graphs when the limit is raised", async () => {
    const store = new DemoStore();
    const standard = await store.api.memoryGraphOverview();
    expect(standard.data.nodes.length).toBeLessThan(2000);

    const demo2k = await store.api.memoryGraphOverview({ limit: 2000 });
    expect(demo2k.data.nodes).toHaveLength(2000);
    expect(memoryGraphOverviewPayloadSchema.parse(demo2k.data)).toEqual(demo2k.data);

    const overview = await store.api.memoryGraphOverview({ limit: 10000 });
    expect(overview.data.nodes).toHaveLength(10000);
    expect(memoryGraphOverviewPayloadSchema.parse(overview.data)).toEqual(overview.data);

    const raised = await store.api.memoryGraphOverview({ limit: 50000 });
    expect(raised.data.nodes).toHaveLength(50000);
    expect(memoryGraphOverviewPayloadSchema.parse(raised.data)).toEqual(raised.data);

    const node = overview.data.nodes[5]!;
    const detail = await store.api.memoryGraphNode(node.id);
    expect(memoryGraphNodeDetailSchema.parse(detail)).toEqual(detail);
    expect(detail.node.id).toBe(node.id);
  });
});
