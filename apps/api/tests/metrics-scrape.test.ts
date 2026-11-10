// The monitoring collector's scrape (plan clipboard:xkCJ9CeYZq4D Phase 5): GET /api/metrics/scrape answers the aggregate metrics and
// the server's load only to the collector's token from a private-network address; a missing or short token file, a public address
// or a wrong token get 403, and the load gauges follow Nous's thresholds.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { apiDomainMetrics, recordNousTurn } from "../src/api-metrics.js";
import { createScrapeAuth, isPrivateNetworkAddress, parseMeminfo, readSpaceMetrics, registerMetricsScrape, renderLoadMetrics, renderSpaceMetrics, WORKER_METRICS_TARGETS } from "../src/metrics-scrape.js";

const token = "a".repeat(40);
const GiB = 1024 ** 3;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function app(tokenText: string | null, targets?: Record<string, number>, space?: () => Promise<string>) {
  const server = Fastify({ trustProxy: true });
  const dir = await mkdtemp(join(tmpdir(), "space-metrics-"));
  roots.push(dir);
  const tokenFile = join(dir, "token");
  if (tokenText !== null) await writeFile(tokenFile, `${tokenText}\n`);
  registerMetricsScrape(server, { tokenFile, routeOptions: {}, render: () => "space_http_requests_total 1\n", meminfo: async () => "MemAvailable:   16777216 kB\nSwapTotal:      1048576 kB\nSwapFree:        524288 kB\n", targets, space });
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
    const pve = (percent: number | null) => ({ percent, host: "pve", at: null, error: null });
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: 30 * GiB, swapPercent: 10, host: pve(44.2) })).toContain("space_server_load_level 0\n");
    // Operator 3/11: only the physical host's swap past 90% is overloaded; public-host's full swap and low RAM are gauges only.
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: 3 * GiB, swapPercent: 100, host: pve(44.2) })).toContain("space_server_load_level 0\n");
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: 30 * GiB, swapPercent: 10, host: pve(91) })).toContain("space_server_load_level 2\n");
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: 30 * GiB, swapPercent: 10, host: pve(91) })).toContain("space_host_swap_used_percent 91\n");
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: 30 * GiB, swapPercent: 10, host: pve(null) })).not.toContain("space_host_swap_used_percent");
    // Operator 31/10 22:31 BKK: the load average alone holds nothing.
    expect(renderLoadMetrics({ load5: 31, cores: 20, memAvailableBytes: 30 * GiB, swapPercent: 10, host: pve(44.2) })).toContain("space_server_load_level 0\n");
    expect(renderLoadMetrics({ load5: 2, cores: 20, memAvailableBytes: null, swapPercent: null, host: null })).not.toContain("space_server_mem_available_bytes");
  });

  // Plan Y7FuQ4vP5z2j step 45: the merge queues, Space Gateway and Nous's turns for the collector's rules and the pane's charts.
  it("adds the merge queues, Space Gateway and Nous's turns, and a failed read never fails the scrape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-queue-"));
    roots.push(dir);
    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    await mkdir(join(dir, "tickets"));
    await writeFile(join(dir, "state.json"), JSON.stringify({ heartbeatAt: new Date().toISOString(), paused: { reason: "fixing", at: tenMinutesAgo },
      current: { batchId: "b-1", phase: "DEPLOYING", tickets: ["q-1"] } }));
    await writeFile(join(dir, "tickets", "q-1.json"), JSON.stringify({ id: "q-1", status: "DEPLOYING", submittedAt: tenMinutesAgo, updatedAt: tenMinutesAgo }));
    await writeFile(join(dir, "tickets", "q-2.json"), JSON.stringify({ id: "q-2", status: "QUEUED", submittedAt: tenMinutesAgo }));
    await writeFile(join(dir, "tickets", "q-3.json"), JSON.stringify({ id: "q-3", status: "DEPLOYED", submittedAt: tenMinutesAgo }));
    const gateway = createServer((request, response) => { response.writeHead(request.url === "/health" ? 200 : 404).end("ok"); });
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
    const text = await readSpaceMetrics({ queueRoots: { stable: dir, dev: join(dir, "missing") }, gatewayUrl });
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    expect(text).toContain('space_merge_queue_readable{queue="stable"} 1\n');
    expect(text).toContain('space_merge_queue_readable{queue="dev"} 0\n');
    expect(text).toContain('space_merge_queue_daemon_up{queue="stable"} 1\n');
    expect(text).toContain('space_merge_queue_paused{queue="stable"} 1\n');
    expect(text).toContain('space_merge_queue_active_tickets{queue="stable"} 2\n');
    expect(Number(/space_merge_queue_batch_phase_seconds\{queue="stable"\} (\d+)/.exec(text)?.[1])).toBeGreaterThanOrEqual(600);
    // An unreadable queue says only that; the gateway's /health decides space_gateway_up.
    expect(text).not.toContain('space_merge_queue_paused{queue="dev"}');
    expect(text).toContain("space_gateway_up 1\n");
    expect(await readSpaceMetrics({ queueRoots: {}, gatewayUrl: "http://127.0.0.1:1" })).toContain("space_gateway_up 0\n");
    // A public install has neither: nothing is added.
    expect(renderSpaceMetrics({ queues: [], gatewayUp: null, now: 0 })).toBe("");

    recordNousTurn("OPERATOR", "DONE");
    expect(apiDomainMetrics.renderLines({ includeDropped: false }).join("\n")).toMatch(/space_nous_turns_total\{reason="OPERATOR",status="DONE"\} [1-9]/);

    const server = await app(token, undefined, async () => text);
    const ok = await scrape(server, "10.20.0.210", `Bearer ${token}`);
    expect(ok.body).toContain("space_server_load_level");
    expect(ok.body.endsWith("space_gateway_up 1\n")).toBe(true);
    await server.close();
    const failing = await app(token, undefined, async () => { throw new Error("queue unreadable"); });
    const still = await scrape(failing, "10.20.0.210", `Bearer ${token}`);
    expect(still.statusCode).toBe(200);
    expect(still.body).toContain("space_server_load_level");
    await failing.close();
  });

  // OBS-001: the collector cannot reach public-host's loopback, so the API relays each worker's /metrics under the same token rule.
  it("relays a worker's loopback metrics to the collector, and only a known target", async () => {
    const worker = createServer((request, response) => {
      response.writeHead(request.url === "/metrics" ? 200 : 404, { "content-type": "text/plain" }).end("space_worker_activity_executions_total 3\n");
    });
    await new Promise<void>((resolve) => worker.listen(0, "127.0.0.1", resolve));
    const port = (worker.address() as { port: number }).port;
    const server = await app(token, { worker: port, "memory-mutation": 1 });
    const get = (target: string, from = "10.20.0.210", auth: string | null = `Bearer ${token}`) =>
      server.inject({ method: "GET", url: `/api/metrics/scrape/${target}`, headers: { "x-forwarded-for": from, ...(auth ? { authorization: auth } : {}) } });
    const ok = await get("worker");
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("space_worker_activity_executions_total 3\n");
    expect((await get("worker", "192.0.2.10")).statusCode).toBe(403);
    expect((await get("worker", "10.20.0.210", null)).statusCode).toBe(403);
    for (const unknown of ["api", "constructor", "__proto__"]) expect((await get(unknown)).statusCode, unknown).toBe(404);
    expect((await get("memory-mutation")).json()).toMatchObject({ error: { code: "METRICS_TARGET_DOWN" } });
    await server.close();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    // Dev registers no targets: its loopback would answer with stable's workers.
    const dev = await app(token);
    expect((await dev.inject({ method: "GET", url: "/api/metrics/scrape/worker", headers: { "x-forwarded-for": "10.20.0.210", authorization: `Bearer ${token}` } })).statusCode).toBe(404);
    await dev.close();
  });

  // The systemd units are private host files; the public export ships none of them.
  it.skipIf(!existsSync(new URL("../../../deploy/space-worker.service", import.meta.url)))("relays the ports the worker units listen on", async () => {
    const unit = (name: string) => readFile(new URL(`../../../deploy/${name}`, import.meta.url), "utf8");
    const worker = await unit("space-worker.service");
    expect(worker).toContain(`SPACE_WORKER_METRICS_PORT=${WORKER_METRICS_TARGETS.worker}\n`);
    expect(worker).toContain(`SPACE_WORKER_TEMPORAL_METRICS_BIND=127.0.0.1:${WORKER_METRICS_TARGETS["worker-temporal"]}\n`);
    expect(await unit("space-memory-maintenance-worker.service")).toContain(`SPACE_MEMORY_MAINTENANCE_METRICS_PORT=${WORKER_METRICS_TARGETS["memory-maintenance"]}\n`);
    expect(await unit("space-memory-mutation-worker.service")).toContain(`SPACE_MEMORY_MUTATION_METRICS_PORT=${WORKER_METRICS_TARGETS["memory-mutation"]}\n`);
  });
});
