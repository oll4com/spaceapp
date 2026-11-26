import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { sampleApiMemory } from "../src/memory-sampler.js";

describe("API memory sampler", () => {
  it("logs memory every interval and names the in-flight requests only when heapUsed jumps past the threshold", async () => {
    const arrived = vi.fn();
    const server = createServer(arrived); // Never answers: the request stays in flight.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const heapUsed = [100, 150, 500].map((value) => value * 2 ** 20);
    const memoryUsage = () => ({ ...process.memoryUsage(), heapUsed: heapUsed.shift() ?? 500 * 2 ** 20 });
    const log = { info: vi.fn() };
    const stop = sampleApiMemory(log, server, { intervalMs: 200, memoryUsage });
    const held = request({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, method: "POST", path: "/api/things/1?token=private", headers: { "content-length": "5" } });
    held.on("error", () => {});
    held.end("hello");
    await vi.waitFor(() => expect(log.info.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
    stop();
    held.destroy();
    server.closeAllConnections();
    server.close();
    expect(arrived).toHaveBeenCalled();
    const [first, jump] = log.info.mock.calls.map(([fields]) => fields);
    expect(first).toMatchObject({ event: "api.memory", heapUsedMb: 150 });
    expect(first.heapSpacesUsedMb).toHaveProperty("old_space");
    expect(first).not.toHaveProperty("inFlight");
    expect(jump).toMatchObject({ event: "api.memory", heapUsedMb: 500, heapJump: true, inFlight: [{ method: "POST", path: "/api/things/1", bodyBytes: 5 }] });
    expect(jump.inFlight[0].ageMs).toBeGreaterThan(0);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain("private");
  });
});
