// The monitoring collector's scrape (plan clipboard:xkCJ9CeYZq4D Phase 5): GET /api/metrics/scrape answers the aggregate metrics and
// the server's load only to the collector's token from a private-network address; a missing or short token file, a public address
// or a wrong token get 403, and the load gauges follow Nous's thresholds.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createScrapeAuth, isPrivateNetworkAddress, parseMeminfo, registerMetricsScrape, renderLoadMetrics } from "../src/metrics-scrape.js";

const token = "a".repeat(40);
const GiB = 1024 ** 3;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function app(tokenText: string | null) {
  const server = Fastify({ trustProxy: true });
  const dir = await mkdtemp(join(tmpdir(), "space-metrics-"));
  roots.push(dir);
  const tokenFile = join(dir, "token");
  if (tokenText !== null) await writeFile(tokenFile, `${tokenText}\n`);
  registerMetricsScrape(server, { tokenFile, routeOptions: {}, render: () => "space_http_requests_total 1\n", meminfo: async () => "MemAvailable:   16777216 kB\nSwapTotal:      1048576 kB\nSwapFree:        524288 kB\n" });
  return server;
}
const scrape = (server: Awaited<ReturnType<typeof app>>, from: string, auth?: string) =>
  server.inject({ method: "GET", url: "/api/metrics/scrape", headers: { "x-forwarded-for": from, ...(auth ? { authorization: auth } : {}) } });

describe("metrics scrape", () => {
  it("knows private-network addresses", () => {
    for (const ip of ["10.20.0.210", "::ffff:10.20.0.210", "172.16.4.1", "172.31.255.255", "192.168.10.1"]) expect(isPrivateNetworkAddress(ip), ip).toBe(true);
    for (const ip of ["127.0.0.1", "192.0.2.10", "172.32.0.1", "8.8.8.8", "::1", undefined, "10.20.0"]) expect(isPrivateNetworkAddress(ip), String(ip)).toBe(false);
  });

  it("serves the collector's token from a private address and refuses everything else", async () => {
    const server = await app(token);
    const ok = await scrape(server, "10.20.0.210", `Bearer ${token}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("space_http_requests_total 1");
    expect(ok.body).toMatch(/space_server_load_level [012]\n/);
    expect(ok.body).toContain("space_server_mem_available_bytes 17179869184");
    expect(ok.body).toContain("space_server_swap_used_percent 50");
    expect((await scrape(server, "192.0.2.10", `Bearer ${token}`)).statusCode).toBe(403);
    expect((await scrape(server, "10.20.0.210", `Bearer ${"b".repeat(40)}`)).statusCode).toBe(403);
    expect((await scrape(server, "10.20.0.210")).statusCode).toBe(403);
    await server.close();
    // No token file, or one too short to be a secret: the scrape stays closed.
    for (const text of [null, "short"]) {
      const closed = await app(text);
      expect((await scrape(closed, "10.20.0.210", `Bearer ${text ?? token}`)).statusCode).toBe(403);
      await closed.close();
    }
  });

  it("reads a rotated token within a minute", async () => {
    let current = token;
    let clock = 0;
    const auth = createScrapeAuth({ tokenFile: "/unused", now: () => clock, read: async () => current });
    const request = (value: string) => ({ ip: "10.20.0.210", headers: { authorization: `Bearer ${value}` } }) as never;
    expect(await auth.allows(request(token))).toBe(true);
    current = "c".repeat(40);
    expect(await auth.allows(request(current))).toBe(false);
    clock += 61_000;
    expect(await auth.allows(request(current))).toBe(true);
    expect(await auth.allows(request(token))).toBe(false);
  });

  it("renders the load with Nous's thresholds", () => {
    expect(parseMeminfo("MemAvailable:   1048576 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n")).toEqual({ memAvailableBytes: GiB, swapPercent: 0 });
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: 30 * GiB, swapPercent: 10 })).toContain("space_server_load_level 0\n");
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: 6 * GiB, swapPercent: 10 })).toContain("space_server_load_level 1\n");
    expect(renderLoadMetrics({ load5: 31, cores: 20, memAvailableBytes: 30 * GiB, swapPercent: 10 })).toContain("space_server_load_level 2\n");
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: null, swapPercent: null })).not.toContain("space_server_mem_available_bytes");
  });
});
