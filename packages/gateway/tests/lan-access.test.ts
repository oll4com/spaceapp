import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { loadGatewayConfig } from "../src/config.js";
import {
  isLoopback, isPrivateCidr, lanDecision, lanPathAllowed, loadLanAccess, parseCidr, plainIpv4, sourceAllowed, withLanEnvFile
} from "../src/lan-access.js";
import { createGatewayServer } from "../src/server.js";

const lan = { host: "10.20.0.207", port: 4925, allowedSources: [parseCidr("10.20.0.0/24")] };

describe("LAN access rules", () => {
  it("parses IPv4 ranges and keeps only private ones", () => {
    expect(parseCidr("10.20.0.9/24")).toMatchObject({ text: "10.20.0.9/24", network: parseCidr("10.20.0.0/24").network });
    expect(() => parseCidr("10.20.0.0/33")).toThrow();
    expect(() => parseCidr("example.com/24")).toThrow();
    expect(isPrivateCidr(parseCidr("10.20.0.0/24"))).toBe(true);
    expect(isPrivateCidr(parseCidr("192.168.1.10"))).toBe(true);
    expect(isPrivateCidr(parseCidr("172.31.0.0/16"))).toBe(true);
    expect(isPrivateCidr(parseCidr("172.32.0.0/16"))).toBe(false);
    expect(isPrivateCidr(parseCidr("10.0.0.0/7"))).toBe(false);
    expect(isPrivateCidr(parseCidr("0.0.0.0/0"))).toBe(false);
    expect(isPrivateCidr(parseCidr("8.8.8.8"))).toBe(false);
  });

  it("matches socket addresses, including IPv4-mapped IPv6", () => {
    expect(plainIpv4("::ffff:10.20.0.5")).toBe("10.20.0.5");
    expect(plainIpv4("fe80::1")).toBeNull();
    expect(sourceAllowed("10.20.0.5", lan.allowedSources)).toBe(true);
    expect(sourceAllowed("::ffff:10.20.0.5", lan.allowedSources)).toBe(true);
    expect(sourceAllowed("10.20.1.5", lan.allowedSources)).toBe(false);
    expect(sourceAllowed("fe80::1", lan.allowedSources)).toBe(false);
    expect(sourceAllowed(undefined, lan.allowedSources)).toBe(false);
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("10.254.240.1")).toBe(false);
  });

  it("serves the LAN only the proxy routes, to allowed sources", () => {
    for (const path of ["/health", "/v1/chat/completions", "/v1/models?x=1", "/backend-api/codex/responses", "/api/codex/weekly-remaining"]) {
      expect(lanPathAllowed(path)).toBe(true);
    }
    // The Antigravity relay takes no gateway key, so it stays on loopback.
    for (const path of ["/antigravity/v1internal:generateContent", "/stats", "/readyz", "/__space-gateway/status", "/__space-gateway/admin/codex/device", "/v10", "/"]) {
      expect(lanPathAllowed(path)).toBe(false);
    }
    expect(lanDecision("127.0.0.1", "10.254.240.11", "/stats", lan)).toBe("allow");
    expect(lanDecision(undefined, undefined, "/stats", lan)).toBe("allow");
    expect(lanDecision("10.20.0.207", "10.20.0.5", "/v1/responses", lan)).toBe("allow");
    expect(lanDecision("10.20.0.207", "10.20.0.5", "/__space-gateway/status", lan)).toBe("not_found");
    expect(lanDecision("10.20.0.207", "100.64.1.2", "/v1/responses", lan)).toBe("forbidden");
    expect(lanDecision("10.20.0.207", "10.20.0.5", "/v1/responses", null)).toBe("forbidden");
  });

  it("reads LAN settings from the environment and refuses public ranges", () => {
    expect(loadLanAccess({})).toBeNull();
    expect(loadLanAccess({ SPACE_GATEWAY_LAN_HOST: "10.20.0.207", SPACE_GATEWAY_LAN_ALLOWED_SOURCES: "10.20.0.0/24, 192.168.5.0/24" }))
      .toMatchObject({ host: "10.20.0.207", port: 4925, allowedSources: [{ text: "10.20.0.0/24" }, { text: "192.168.5.0/24" }] });
    expect(() => loadLanAccess({ SPACE_GATEWAY_LAN_HOST: "10.20.0.207" })).toThrow(/ALLOWED_SOURCES/);
    expect(() => loadLanAccess({ SPACE_GATEWAY_LAN_HOST: "10.20.0.207", SPACE_GATEWAY_LAN_ALLOWED_SOURCES: "0.0.0.0/0" })).toThrow(/private/);
    expect(() => loadLanAccess({ SPACE_GATEWAY_LAN_HOST: "0.0.0.0", SPACE_GATEWAY_LAN_ALLOWED_SOURCES: "10.0.0.0/8" })).toThrow(/private IPv4/);
    expect(() => loadLanAccess({ SPACE_GATEWAY_LAN_HOST: "10.1.1.1", SPACE_GATEWAY_LAN_PORT: "80", SPACE_GATEWAY_LAN_ALLOWED_SOURCES: "10.0.0.0/8" })).toThrow();
    // A bad LAN setting turns LAN access off; it never stops the loopback gateway.
    const config = loadGatewayConfig({ SPACE_GATEWAY_LAN_HOST: "203.0.113.5", SPACE_GATEWAY_LAN_ALLOWED_SOURCES: "10.0.0.0/8" });
    expect(config).toMatchObject({ host: "127.0.0.1", port: 4920, lan: null });
    expect(config.lanError).toMatch(/private IPv4/);
    expect(loadGatewayConfig({})).toMatchObject({ lan: null, lanError: null });
  });

  it("takes the LAN settings from the env file, so a reload can change or remove them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-lan-env-"));
    const file = join(directory, ".env");
    writeFileSync(file, "SPACE_DATABASE_URL=postgres://x\nSPACE_GATEWAY_LAN_HOST=10.20.0.207\nSPACE_GATEWAY_LAN_ALLOWED_SOURCES=\"10.20.0.0/24\"\n");
    const env = { SPACE_DATABASE_URL: "postgres://from-unit", SPACE_GATEWAY_LAN_PORT: "4999" };
    expect(await withLanEnvFile(env, file)).toEqual({
      SPACE_DATABASE_URL: "postgres://from-unit", SPACE_GATEWAY_LAN_HOST: "10.20.0.207", SPACE_GATEWAY_LAN_ALLOWED_SOURCES: "10.20.0.0/24"
    });
    writeFileSync(file, "SPACE_DATABASE_URL=postgres://x\n");
    expect(await withLanEnvFile({ ...env, SPACE_GATEWAY_LAN_HOST: "10.20.0.207" }, file)).toEqual({ SPACE_DATABASE_URL: "postgres://from-unit" });
    expect(await withLanEnvFile(env, join(directory, "missing"))).toBe(env);
  });
});

const lanAddress = Object.values(networkInterfaces()).flat().find((item) => item?.family === "IPv4" && !item.internal && isPrivateCidr(parseCidr(item.address)))?.address;

async function get(host: string, port: number, path: string, localAddress?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host, port, path, localAddress }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

describe.skipIf(!lanAddress)("LAN listener on a real interface", () => {
  it("admits allowed sources to proxy routes only, while loopback stays unrestricted", async () => {
    const address = lanAddress!;
    const allowed = { host: address, port: 0, allowedSources: [parseCidr(`${address}/32`)] };
    const repository = new InMemoryGatewayRepository();
    const gateway = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => false, lan: allowed });
    await gateway.app.listen({ host: "127.0.0.1", port: 0 });
    const lanServer = createServer((request, response) => gateway.app.server.emit("request", request, response));
    await new Promise<void>((resolve) => lanServer.listen(0, address, () => resolve()));
    const loopbackPort = (gateway.app.server.address() as { port: number }).port;
    const lanPort = (lanServer.address() as { port: number }).port;
    try {
      expect((await get("127.0.0.1", loopbackPort, "/__space-gateway/status")).status).toBe(200);
      expect((await get(address, lanPort, "/health")).body).toBe('{"status":"ok"}');
      expect((await get(address, lanPort, "/v1/models")).status).toBe(401);
      const stats = await get(address, lanPort, "/__space-gateway/status");
      expect(stats.status).toBe(404);
      expect(JSON.parse(stats.body).error.code).toBe("not_found");

      const closed = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => false, lan: { ...allowed, allowedSources: [parseCidr("192.168.254.0/24")] } });
      await closed.app.ready();
      const closedLan = createServer((request, response) => closed.app.server.emit("request", request, response));
      await new Promise<void>((resolve) => closedLan.listen(0, address, () => resolve()));
      try {
        const refused = await get(address, (closedLan.address() as { port: number }).port, "/v1/models");
        expect(refused.status).toBe(403);
        expect(JSON.parse(refused.body).error.code).toBe("source_not_allowed");
      } finally {
        await new Promise<void>((resolve) => closedLan.close(() => resolve()));
        await closed.app.close();
      }
    } finally {
      lanServer.closeAllConnections();
      await new Promise<void>((resolve) => lanServer.close(() => resolve()));
      await gateway.app.close();
    }
  });
});
