import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { systemTopologySnapshotSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createCsrfToken, signSession } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { SystemTopologyService } from "../src/system-topology-service.js";

const sessionSecret = "system-topology-api-test-secret";
const apps: FastifyInstance[] = [];

function authHeaders(role: "OPERATOR" | "ADMIN") {
  const session = signSession(
    { id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role },
    sessionSecret
  );
  return {
    cookie: `space_session=${session}`,
    "x-space-csrf-token": createCsrfToken(session, sessionSecret)!
  };
}

async function setup() {
  const store = new InMemorySpaceStore();
  const topologyService = new SystemTopologyService({
    getHealthSnapshot: async () => ({
      sampledAt: new Date().toISOString(),
      uptimeSeconds: 1200,
      coreCount: 4,
      metrics: [],
      requests: {
        windowSeconds: 300,
        requestCount: 50,
        errorCount: 0,
        errorRatePercent: 0,
        p95Ms: 15,
        sampledAt: new Date().toISOString()
      },
      services: [
        { id: "api", label: "Space API", status: "healthy", detail: "API is responding", checkedAt: new Date().toISOString(), values: [] },
        { id: "database", label: "Database", status: "healthy", detail: "Database query succeeded", checkedAt: new Date().toISOString(), values: [] },
        { id: "worker", label: "Worker", status: "healthy", detail: "Temporal ready", checkedAt: new Date().toISOString(), values: [] }
      ]
    })
  });

  const app = await createApp({
    store,
    auth: { sessionSecret, devLogin: false, secureCookies: false },
    systemTopologyService: topologyService,
    config: getApiConfig({})
  });

  apps.push(app);
  return app;
}

afterEach(async () => {
  while (apps.length) {
    const app = apps.pop()!;
    await app.close();
  }
});

describe("GET /api/admin/system-analytics/topology", () => {
  it("rejects unauthenticated requests with 401/403", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/system-analytics/topology"
    });
    expect([401, 403]).toContain(res.statusCode);
  });

  it("returns validated topology snapshot for ADMIN", async () => {
    const app = await setup();
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/system-analytics/topology",
      headers: authHeaders("ADMIN")
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const parsed = systemTopologySnapshotSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.edges.length).toBeGreaterThan(0);
    expect(body.nodes.find((n: { id: string }) => n.id === "api-gateway")).toBeDefined();
    expect(body.nodes.find((n: { id: string }) => n.id === "database")).toBeDefined();
    expect(body.edges.find((e: { id: string }) => e.id === "edge-api-db")).toBeDefined();
  });
});

describe("SystemTopologyService operator infrastructure", () => {
  // Review F11 (2026-10-14): the fixed Proxmox host description appears only on the operator's own installs.
  it("leaves the Proxmox node and its edge out unless the install includes operator infrastructure", async () => {
    const getHealthSnapshot = async () => ({
      sampledAt: new Date().toISOString(), uptimeSeconds: 1, coreCount: 1, metrics: [],
      requests: { windowSeconds: 300, requestCount: 0, errorCount: 0, errorRatePercent: 0, p95Ms: 0, sampledAt: new Date().toISOString() },
      services: []
    });
    const publicTopology = await new SystemTopologyService({ getHealthSnapshot }).snapshot();
    expect(publicTopology.nodes.some((node) => node.id === "proxmox-infra")).toBe(false);
    expect(publicTopology.edges.some((edge) => edge.target === "proxmox-infra")).toBe(false);
    const operatorTopology = await new SystemTopologyService({ getHealthSnapshot, includeOperatorInfrastructure: true }).snapshot();
    expect(operatorTopology.nodes.some((node) => node.id === "proxmox-infra")).toBe(true);
  });
});
