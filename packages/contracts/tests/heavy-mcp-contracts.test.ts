import { describe, expect, it } from "vitest";
import { heavyMcpGatewayReadyV2Schema } from "../src/heavy-mcp.js";

describe("heavy MCP versioned contracts", () => {
  // The committed catalog manifests (deploy/mcp-catalogs, not in the public tree): heavy-mcp-catalogs.test.ts.
  it("accepts listener/catalog readiness while both upstreams remain idle", () => {
    const server = (serverId: string) => ({
      endpoint: `http://127.0.0.1:43123/mcp/${serverId}`,
      catalogHash: "a".repeat(64),
      catalogMode: "LAZY_MANIFEST" as const,
      upstreamState: "IDLE" as const,
      fallbackReason: null
    });
    const ready = heavyMcpGatewayReadyV2Schema.parse({
      contract: "HeavyMcpGatewayReadyV2",
      schemaVersion: 2,
      ok: true,
      pid: 1234,
      listenerState: "LISTENING",
      catalogReady: true,
      host: "127.0.0.1",
      port: 43123,
      catalogHash: "b".repeat(64),
      servers: { capturelab: server("capturelab"), devtools: server("devtools") },
      startedAt: "2026-07-16T10:00:00.000Z",
      startedMonotonicNs: "123456789"
    });
    expect(Object.values(ready.servers).every((item) => item.upstreamState === "IDLE")).toBe(true);
  });

  it("rejects non-loopback endpoints and unknown fields", () => {
    const result = heavyMcpGatewayReadyV2Schema.safeParse({
      contract: "HeavyMcpGatewayReadyV2",
      schemaVersion: 2,
      ok: true,
      pid: 1,
      listenerState: "LISTENING",
      catalogReady: true,
      host: "0.0.0.0",
      port: 43123,
      catalogHash: null,
      servers: {},
      startedAt: "2026-07-16T10:00:00.000Z",
      startedMonotonicNs: "1",
      arbitraryCommand: "/bin/sh"
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing or unknown heavy-server readiness entries", () => {
    const server = (serverId: string) => ({
      endpoint: `http://127.0.0.1:43123/mcp/${serverId}`,
      catalogHash: "a".repeat(64),
      catalogMode: "LAZY_MANIFEST" as const,
      upstreamState: "IDLE" as const,
      fallbackReason: null
    });
    const payload = {
      contract: "HeavyMcpGatewayReadyV2" as const,
      schemaVersion: 2 as const,
      ok: true,
      pid: 1234,
      listenerState: "LISTENING" as const,
      catalogReady: true,
      host: "127.0.0.1" as const,
      port: 43123,
      catalogHash: "b".repeat(64),
      startedAt: "2026-07-16T10:00:00.000Z",
      startedMonotonicNs: "123456789"
    };

    expect(heavyMcpGatewayReadyV2Schema.safeParse({
      ...payload,
      servers: { devtools: server("devtools") }
    }).success).toBe(false);
    expect(heavyMcpGatewayReadyV2Schema.safeParse({
      ...payload,
      servers: {
        capturelab: server("capturelab"),
        devtools: server("devtools"),
        arbitrary: server("arbitrary")
      }
    }).success).toBe(false);
  });
});
