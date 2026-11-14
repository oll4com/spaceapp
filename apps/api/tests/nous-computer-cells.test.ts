import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeCellDriver } from "../src/computer/cell-driver.js";
import {
  CellCapacityError,
  CellExportRequiredError,
  IDLE_TO_SLEEP_MS,
  SLEEP_TO_COLD_MS,
  createCellOrchestrator,
  createMemoryCellStore,
  type CellHost
} from "../src/computer/cells.js";
import { FirecrackerApiError, createFirecrackerClient } from "../src/computer/firecracker-client.js";

function setup(hosts: CellHost[], delaysMs: Record<string, number> = {}) {
  let t = 1_000_000;
  const driver = createFakeCellDriver({ advance: (ms) => (t += ms), delaysMs });
  const store = createMemoryCellStore();
  const cells = createCellOrchestrator({ driver, store, hosts, now: () => t, cellMemMib: 1024 });
  return { driver, store, cells, advance: (ms: number) => (t += ms) };
}
const ops = (driver: ReturnType<typeof createFakeCellDriver>, op: string) => driver.calls.filter((c) => c.op === op);

describe("nous computer cells", () => {
  it("dedups concurrent ensureAwake into one create", async () => {
    const { driver, cells } = setup([{ id: "h1", ramMib: 8192, maxAwake: 4 }]);
    const results = await Promise.all([cells.ensureAwake("t1"), cells.ensureAwake("t1"), cells.ensureAwake("t1")]);
    expect(ops(driver, "create")).toHaveLength(1);
    expect(new Set(results)).toHaveProperty("size", 1);
    expect((await cells.cell("t1"))?.state).toBe("AWAKE");
  });

  it("sleeps after idle, goes cold after a day, and wakes from either with a clock step", async () => {
    const { driver, cells, advance } = setup([{ id: "h1", ramMib: 8192, maxAwake: 4 }]);
    await cells.ensureAwake("t1");
    advance(IDLE_TO_SLEEP_MS - 1);
    expect((await cells.tick()).slept).toEqual([]);
    advance(1);
    expect((await cells.tick()).slept).toEqual(["t1"]);
    expect((await cells.cell("t1"))?.state).toBe("SLEEPING");

    expect((await cells.ensureAwake("t1")).from).toBe("SLEEPING");
    expect(ops(driver, "restore")).toHaveLength(1);
    expect(ops(driver, "syncClock")).toHaveLength(1);

    advance(IDLE_TO_SLEEP_MS);
    await cells.tick();
    advance(SLEEP_TO_COLD_MS);
    expect((await cells.tick()).cooled).toEqual(["t1"]);
    const cold = await cells.cell("t1");
    expect(cold).toMatchObject({ state: "COLD", hostId: null, objectKey: "cells/t1/snapshot" });

    expect((await cells.ensureAwake("t1")).from).toBe("COLD");
    expect(ops(driver, "download")).toHaveLength(1);
    expect(ops(driver, "syncClock")).toHaveLength(2);
  });

  it("keeps a cell awake when its snapshot fails", async () => {
    const { driver, cells, advance } = setup([{ id: "h1", ramMib: 8192, maxAwake: 4 }]);
    await cells.ensureAwake("t1");
    advance(IDLE_TO_SLEEP_MS);
    driver.failNext("pauseAndSnapshot", new Error("disk full"));
    const result = await cells.tick();
    expect(result.errors).toHaveLength(1);
    expect(ops(driver, "resume")).toHaveLength(1);
    expect((await cells.cell("t1"))?.state).toBe("AWAKE");
  });

  it("places new cells on the most free RAM and evicts the longest-idle cell on a full host", async () => {
    const { driver, cells, advance } = setup([
      { id: "small", ramMib: 4096, maxAwake: 2 },
      { id: "big", ramMib: 8192, maxAwake: 2 }
    ]);
    expect((await cells.ensureAwake("a")).hostId).toBe("big");
    advance(1000);
    expect((await cells.ensureAwake("b")).hostId).toBe("big"); // 7 GiB free beats 4 GiB
    advance(1000);
    expect((await cells.ensureAwake("c")).hostId).toBe("small"); // big is at maxAwake
    await cells.ensureAwake("d");
    advance(IDLE_TO_SLEEP_MS);
    await cells.ensureAwake("a"); // a is active again; b is now the longest idle on big
    await cells.tick(); // b, c, d sleep: all idle
    await cells.ensureAwake("b");
    await cells.ensureAwake("c");
    await cells.ensureAwake("d");
    // small holds c and d awake; big holds a and b. Waking a newcomer evicts the longest-idle cell on the chosen host.
    advance(1000);
    await cells.ensureAwake("a");
    const before = ops(driver, "pauseAndSnapshot").length;
    const woke = await cells.ensureAwake("e");
    const evicted = ops(driver, "pauseAndSnapshot").slice(before);
    expect(woke.hostId).toBe("big"); // 6 GiB free beats 2 GiB, both full by count
    expect(evicted).toEqual([{ op: "pauseAndSnapshot", tenantId: "b", hostId: "big" }]); // a was active more recently
    const metrics = await cells.hostMetrics();
    expect(metrics.map((m) => m.awake)).toEqual([2, 2]);
    expect(metrics.reduce((n, m) => n + m.sleeping, 0)).toBe(1);
  });

  it("evicts the longest-idle cell when waking on its own full host", async () => {
    const { driver, cells, advance } = setup([{ id: "h1", ramMib: 8192, maxAwake: 2 }]);
    await cells.ensureAwake("a");
    advance(IDLE_TO_SLEEP_MS);
    await cells.tick(); // a sleeps
    await cells.ensureAwake("b");
    advance(1000);
    await cells.ensureAwake("c");
    await cells.ensureAwake("a"); // full: b (idle longest) goes to sleep first
    expect(ops(driver, "pauseAndSnapshot").map((c) => c.tenantId)).toEqual(["a", "b"]);
    expect((await cells.cell("b"))?.state).toBe("SLEEPING");
  });

  it("gives a draining host no new cells and moves its cells away through cold", async () => {
    const { driver, cells, advance } = setup([
      { id: "h1", ramMib: 8192, maxAwake: 4 },
      { id: "h2", ramMib: 4096, maxAwake: 4 }
    ]);
    expect((await cells.ensureAwake("a")).hostId).toBe("h1");
    cells.drainHost("h1");
    expect((await cells.ensureAwake("b")).hostId).toBe("h2");
    advance(IDLE_TO_SLEEP_MS);
    expect((await cells.tick()).slept.sort()).toEqual(["a", "b"]);
    expect((await cells.tick()).cooled).toEqual(["a"]); // no 24 h wait on a draining host
    expect((await cells.ensureAwake("a")).hostId).toBe("h2");
    expect(ops(driver, "download")).toHaveLength(1);
    cells.drainHost("h2");
    await expect(cells.ensureAwake("c")).rejects.toBeInstanceOf(CellCapacityError);
  });

  it("refuses to delete without an export newer than the last activity", async () => {
    const { driver, cells, advance } = setup([{ id: "h1", ramMib: 8192, maxAwake: 4 }]);
    await cells.ensureAwake("t1");
    await expect(cells.deleteCell("t1")).rejects.toBeInstanceOf(CellExportRequiredError);
    advance(10);
    await cells.exportCell("t1");
    advance(10);
    await cells.ensureAwake("t1"); // activity after the export
    await expect(cells.deleteCell("t1")).rejects.toBeInstanceOf(CellExportRequiredError);
    expect(ops(driver, "destroy")).toHaveLength(0);
    advance(10);
    await cells.exportCell("t1");
    await cells.deleteCell("t1");
    expect((await cells.cell("t1"))?.state).toBe("DELETED");
    await expect(cells.ensureAwake("t1")).rejects.toThrow(/deleted/);

    await cells.ensureAwake("t2");
    await cells.deleteCell("t2", { force: "tenant-deletion" });
    expect(ops(driver, "destroy").map((c) => c.tenantId)).toEqual(["t1", "t2"]);
  });

  it("reports wake p95 per host", async () => {
    let t = 0;
    const restoreMs = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200 ms
    const driver = createFakeCellDriver({ advance: (ms) => (t += ms ? (restoreMs.shift() ?? 0) : 0), delaysMs: { restore: 1 } });
    const cells = createCellOrchestrator({ driver, store: createMemoryCellStore(), hosts: [{ id: "h1", ramMib: 65536, maxAwake: 40 }], now: () => t, cellMemMib: 1024 });
    for (let i = 0; i < 21; i += 1) await cells.ensureAwake(`t${i}`);
    t += IDLE_TO_SLEEP_MS;
    await cells.tick();
    for (let i = 0; i < 20; i += 1) await cells.ensureAwake(`t${i}`);
    expect((await cells.hostMetrics())[0]).toMatchObject({ wakes: 20, wakeP95Ms: 190, awake: 20, sleeping: 1 });
  });
});

describe("firecracker client", () => {
  it("sends the snapshot, vm state and balloon calls over the unix socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-sock-"));
    const socketPath = join(dir, "api.sock");
    const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, body: JSON.parse(body) });
        if (req.url === "/snapshot/load" && seen.length > 5) {
          res.writeHead(400, { "Content-Type": "application/json" }).end('{"fault_message":"bad snapshot"}');
        } else res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const fc = createFirecrackerClient(socketPath);
      await fc.pause();
      await fc.createSnapshot({ snapshotPath: "snap.vmstate", memFilePath: "snap.mem" });
      await fc.loadSnapshot({ snapshotPath: "snap.vmstate", memFilePath: "snap.mem" }, true);
      await fc.resume();
      await fc.setBalloon(512);
      expect(seen).toEqual([
        { method: "PATCH", url: "/vm", body: { state: "Paused" } },
        { method: "PUT", url: "/snapshot/create", body: { snapshot_type: "Full", snapshot_path: "snap.vmstate", mem_file_path: "snap.mem" } },
        {
          method: "PUT",
          url: "/snapshot/load",
          body: { snapshot_path: "snap.vmstate", mem_backend: { backend_type: "File", backend_path: "snap.mem" }, resume_vm: true }
        },
        { method: "PATCH", url: "/vm", body: { state: "Resumed" } },
        { method: "PATCH", url: "/balloon", body: { amount_mib: 512 } }
      ]);
      const failed = fc.loadSnapshot({ snapshotPath: "x", memFilePath: "y" }, true);
      await expect(failed).rejects.toBeInstanceOf(FirecrackerApiError);
      await expect(failed).rejects.toMatchObject({ status: 400, faultMessage: "bad snapshot" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
