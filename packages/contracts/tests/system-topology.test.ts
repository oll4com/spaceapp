import { describe, expect, it } from "vitest";
import {
  systemTopologySnapshotSchema,
  type SystemTopologySnapshot,
} from "../src/index.js";

describe("systemTopologySnapshotSchema", () => {
  it("validates a healthy system topology snapshot correctly", () => {
    const validSnapshot: SystemTopologySnapshot = {
      sampledAt: new Date().toISOString(),
      nodes: [
        {
          id: "api",
          label: "Space API Gateway",
          type: "gateway",
          group: "core",
          status: "healthy",
          detail: "Fastify running on port 4911",
          host: "public-host",
          metrics: [
            { label: "Uptime", value: "3600 s" },
            { label: "Heap", value: "128 MiB" },
          ],
        },
        {
          id: "database",
          label: "PostgreSQL Database",
          type: "database",
          group: "core",
          status: "healthy",
          detail: "Connection pool active",
          host: "public-host",
          metrics: [{ label: "Pool", value: "Active" }],
        },
      ],
      edges: [
        {
          id: "edge-api-db",
          source: "api",
          target: "database",
          label: "SQL Pool",
          protocol: "TCP/Postgres",
          status: "active",
          direction: "forward",
        },
      ],
      summary: {
        totalNodes: 2,
        healthyNodes: 2,
        warningNodes: 0,
        criticalNodes: 0,
        activeEdges: 1,
      },
    };

    const parsed = systemTopologySnapshotSchema.safeParse(validSnapshot);
    expect(parsed.success).toBe(true);
  });
});
