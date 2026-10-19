import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import type { MemoryGraphSnapshot } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const enabled = process.env.MEMORY_3D_BENCH === "1";

describe.skipIf(!enabled)("memory overview limit benchmark", () => {
  it("measures a 50,000 node overview", async () => {
    const sessionSecret = "benchmark-secret-with-enough-length";
    const sessionToken = signSession({ id: "user:operator", email: "operator@space.test", role: "OPERATOR" }, sessionSecret);
    const nodeCount = 50_000;
    const edgeCount = 150_000;
    const buildStarted = performance.now();
    const nodes = [{
      id: "source:gemini.md",
      type: "SOURCE" as const,
      label: "gemini.md",
      sourcePath: "/opt/spaceapp/docs/gemini.md",
      recordId: null
    }];
    for (let index = 1; index < nodeCount; index++) {
      const id = `memory:${String(index).padStart(8, "0")}`;
      nodes.push({ id, type: "MEMORY", label: `Memory ${index}`, sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null });
    }
    const edges: MemoryGraphSnapshot["edges"] = [];
    for (let index = 1; index < nodeCount && edges.length < edgeCount; index++) {
      edges.push({
        id: `edge:contains:${String(index).padStart(8, "0")}`,
        type: "CONTAINS",
        source: "source:gemini.md",
        target: `memory:${String(index).padStart(8, "0")}`
      });
    }
    let semantic = 0;
    while (edges.length < edgeCount) {
      const source = (semantic % (nodeCount - 2)) + 1;
      const target = ((semantic + 17) % (nodeCount - 2)) + 1;
      if (source !== target) {
        edges.push({
          id: `edge:semantic:${String(semantic + 1).padStart(8, "0")}`,
          type: "SEMANTICALLY_RELATED",
          source: `memory:${String(source).padStart(8, "0")}`,
          target: `memory:${String(target).padStart(8, "0")}`,
          origin: "DETERMINISTIC_TFIDF",
          confidence: 0.42,
          evidence: "Benchmark semantic link."
        });
      }
      semantic += 1;
    }
    const snapshot: MemoryGraphSnapshot = {
      version: 1,
      generatedAt: "2026-07-16T08:00:00.000Z",
      sourceHash: "a".repeat(64),
      records: [],
      nodes,
      edges,
      issues: [],
      summary: { sourceCount: 1, recordCount: 0, nodeCount, edgeCount: edges.length, issueCount: 0 }
    };
    const app = await createApp({
      store: new InMemorySpaceStore(),
      config: getApiConfig({
        SPACE_MEMORY_GRAPH_ENABLED: "true",
        SPACE_MEMORY_MAINTENANCE_ENABLED: "false",
        SPACE_MEMORY_MUTATIONS_ENABLED: "false",
        SPACE_BROWSER_EVIDENCE_ENABLED: "false"
      }),
      auth: { sessionSecret, devLogin: false, secureCookies: false },
      canonicalMemory: { async list() { return []; }, async save() { throw new Error("unused"); } },
      memoryGraphService: {
        async getSnapshot() { return { snapshot, isStale: false }; },
        async getCachedSnapshot() { return snapshot; },
        async invalidateCachedSnapshot() {},
        async getArchiveSnapshot() { return snapshot; },
        async listAvailableMonths() { return ["2026-07"]; },
        async getSourceContent() { throw new Error("unused"); }
      }
    });
    const cookie = `space_session=${sessionToken}`;
    const results = [];
    for (const limit of [2_000, 50_000]) {
      const started = performance.now();
      const response = await app.inject({
        method: "GET",
        url: `/api/admin/memory/graph/overview?limit=${limit}`,
        headers: { cookie }
      });
      const serverMs = performance.now() - started;
      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      results.push({
        limit,
        status: response.statusCode,
        bytes: Buffer.byteLength(response.body),
        serverMs: Math.round(serverMs * 100) / 100,
        nodes: data.nodes.length,
        edges: data.edges.length,
        truncated: data.truncated
      });
      expect(data.nodes.length).toBeLessThanOrEqual(limit);
      expect(data.edges.length).toBeLessThanOrEqual(limit * 3);
    }
    await app.close();
    const report = {
      snapshotBuildMs: Math.round((performance.now() - buildStarted) * 100) / 100,
      snapshotNodes: nodeCount,
      snapshotEdges: edges.length,
      results
    };
    writeFileSync("/tmp/memory-3d-api.json", JSON.stringify(report, null, 2));
    expect(results[1]?.nodes).toBe(50_000);
    expect(results[1]?.edges).toBe(150_000);
  }, 180_000);
});
