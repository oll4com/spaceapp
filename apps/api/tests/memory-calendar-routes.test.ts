import { describe, expect, it } from "vitest";
import type { MemoryGraphSnapshot } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createApp } from "../src/app.js";
import { createCsrfToken, signSession } from "../src/auth.js";
import { getApiConfig } from "../src/config.js";

const sessionSecret = "test-secret-with-enough-length";
const sessionToken = signSession(
  { id: "user:operator", email: "operator@space.test", role: "OPERATOR" },
  sessionSecret
);
const cookie = `space_session=${sessionToken}`;

function sampleArchiveSnapshot(): MemoryGraphSnapshot {
  return {
    version: 1 as const,
    generatedAt: "2026-10-01T21:00:00.000Z",
    sourceHash: "a".repeat(64),
    records: [
      {
        id: "memory:item-1",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-10.md",
        sectionId: "section:item-1",
        title: "SpaceApp 1.1.0 Release",
        body: "## SpaceApp 1.1.0 Release\nDocker containers published token=secret-pass-value",
        createdAt: "2026-10-01T21:00:00.000Z",
        scope: "SYSTEM" as const,
        roomId: null,
        provenance: "operator",
        contentHash: "b".repeat(64),
        lifecycleStatus: "ACTIVE" as const,
        tags: ["release", "docker"]
      },
      {
        id: "memory:item-2",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-10.md",
        sectionId: "section:item-2",
        title: "SEO and Telemetry setup",
        body: "GA4 and rich snippets verified",
        createdAt: "2026-10-01T22:30:00.000Z",
        scope: "SYSTEM" as const,
        roomId: null,
        provenance: "operator",
        contentHash: "c".repeat(64),
        lifecycleStatus: "ACTIVE" as const,
        tags: ["seo"]
      },
      {
        id: "memory:item-3",
        sourcePath: "/opt/spaceapp/docs/gemini_history_2026-09.md",
        sectionId: "section:item-3",
        title: "September Maintenance",
        body: "Cleaned up old test fixtures",
        createdAt: "2026-09-28T14:00:00.000Z",
        scope: "SYSTEM" as const,
        roomId: null,
        provenance: "operator",
        contentHash: "d".repeat(64),
        lifecycleStatus: "ACTIVE" as const,
        tags: ["maintenance"]
      }
    ],
    nodes: [],
    edges: [],
    issues: [],
    summary: { sourceCount: 2, recordCount: 3, nodeCount: 0, edgeCount: 0, issueCount: 0 }
  };
}

async function testApp(archiveSnapshot: MemoryGraphSnapshot) {
  return createApp({
    store: new InMemorySpaceStore(),
    config: getApiConfig({
      SPACE_MEMORY_GRAPH_ENABLED: "true",
      SPACE_BROWSER_EVIDENCE_ENABLED: "false"
    }),
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    canonicalMemory: {
      async list() { return []; },
      async save() { throw new Error("not used"); }
    },
    memoryGraphService: {
      async getSnapshot() {
        return { snapshot: archiveSnapshot, isStale: false };
      },
      async getCachedSnapshot() {
        return archiveSnapshot;
      },
      async invalidateCachedSnapshot() {},
      async getArchiveSnapshot() {
        return archiveSnapshot;
      },
      async listAvailableMonths() {
        return ["2026-09", "2026-10"];
      }
    }
  });
}

describe("GET /api/admin/memory/calendar", () => {
  it("returns calendar statistics, heatmap and month records", async () => {
    const app = await testApp(sampleArchiveSnapshot());
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/memory/calendar?month=2026-10",
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toBeDefined();
    expect(body.data.month).toBe("2026-10");
    expect(body.data.year).toBe(2026);
    expect(body.data.availableMonths).toEqual(["2026-09", "2026-10"]);
    expect(body.data.availableYears).toContain(2026);

    // Stats
    expect(body.data.stats.totalMemories).toBe(3);
    expect(body.data.stats.activeDays).toBe(2); // 2026-10-01 and 2026-09-28
    expect(body.data.stats.maxDailyCount).toBe(2);

    // Heatmap entries
    expect(body.data.heatMap["2026-10-01"]).toEqual({ count: 2, bytes: expect.any(Number) });
    expect(body.data.heatMap["2026-09-28"]).toEqual({ count: 1, bytes: expect.any(Number) });

    // Month records should only contain October records
    expect(body.data.records).toHaveLength(2);
    expect(body.data.records[0].id).toBe("memory:item-2"); // newest first
    expect(body.data.records[1].id).toBe("memory:item-1");

    // Redaction verified
    expect(body.data.records[1].excerpt).not.toContain("secret-pass-value");
  });

  it("filters records by specific date", async () => {
    const app = await testApp(sampleArchiveSnapshot());
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/memory/calendar?date=2026-09-28",
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.selectedDate).toBe("2026-09-28");
    expect(body.data.records).toHaveLength(1);
    expect(body.data.records[0].id).toBe("memory:item-3");
    expect(body.data.records[0].title).toBe("September Maintenance");
  });

  it("calculates yearMemories for the selected year", async () => {
    const app = await testApp(sampleArchiveSnapshot());
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/memory/calendar?year=2026",
      headers: { cookie }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.stats.yearMemories).toBe(3);
  });
});
