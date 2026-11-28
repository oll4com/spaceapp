import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CELL_SNAPSHOT, cellBootCalls, cellId, cellJailerArgs, createFirecrackerCellDriver, type CellHostPort } from "../src/computer/firecracker-cell-driver.js";

// Step 20, the host-independent half: the real Firecracker client against a fake Firecracker API socket; the host half is a recording stub.
describe("firecracker cell driver", () => {
  let dir: string, socketPath: string, failSnapshot = false;
  const api: Array<[string | undefined, string | undefined, unknown]> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      api.push([req.method, req.url, JSON.parse(body)]);
      if (req.url === "/snapshot/create" && failSnapshot) res.writeHead(400).end('{"fault_message":"disk full"}');
      else res.writeHead(204).end();
    });
  });
  const hostCalls: string[] = [];
  const host: CellHostPort = {
    socketPath: () => socketPath,
    startJail: async (cell, mode) => void hostCalls.push(`startJail:${mode}:${cell.tenantId}`),
    keepSnapshotAndStop: async () => (hostCalls.push("keepSnapshotAndStop"), 2_147_483_648),
    waitReady: async () => void hostCalls.push("waitReady"),
    syncClock: async (_cell, epochMs) => void hostCalls.push(`syncClock:${epochMs}`),
    upload: async (cell) => (hostCalls.push("upload"), { objectKey: `cells/${cellId(cell.tenantId)}` }),
    download: async () => void hostCalls.push("download"),
    exportUserData: async (tenantId) => (hostCalls.push("exportUserData"), { exportKey: `exports/${cellId(tenantId)}` }),
    destroy: async () => void hostCalls.push("destroy")
  };
  const cell = { tenantId: "tenant:abc", hostId: "cells-1", memMib: 2048 };
  const driver = createFirecrackerCellDriver({ host });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fc-driver-"));
    socketPath = join(dir, "api.sock");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("names a cell by a jailer-safe hash of its tenant and jails it with its own uid, netns and cgroup limits", () => {
    expect(cellId("tenant:abc")).toMatch(/^c-[0-9a-f]{24}$/);
    expect(cellId("tenant:abc")).toBe(cellId("tenant:abc"));
    expect(cellId("tenant:abd")).not.toBe(cellId("tenant:abc"));
    const args = cellJailerArgs(cell, { uid: 10_001, netnsPath: "/var/run/netns/c1", chrootBaseDir: "/srv/fc/jail", firecrackerPath: "/usr/local/bin/firecracker" });
    expect(args.join(" ")).toContain(`--id ${cellId("tenant:abc")} --exec-file /usr/local/bin/firecracker --uid 10001 --gid 10001`);
    expect(args).toEqual(expect.arrayContaining(["--netns", "/var/run/netns/c1", `memory.max=${(2048 + 256) * 1_048_576}`, "cpu.max=200000 100000", "--new-pid-ns"]));
    expect(() => cellJailerArgs(cell, { uid: 0, netnsPath: "x", chrootBaseDir: "x", firecrackerPath: "x" })).toThrow(/unprivileged uid/);
  });

  it("boots, sleeps and wakes with fc-vm.sh's call order", async () => {
    await driver.create(cell);
    expect(api.map(([method, url]) => `${method} ${url}`)).toEqual(cellBootCalls(cell).map(([path]) => `PUT ${path}`));
    expect(api[0]![2]).toEqual({ vcpu_count: 2, mem_size_mib: 2048 });
    expect(api.at(-1)![2]).toEqual({ action_type: "InstanceStart" });
    api.length = 0;
    expect(await driver.pauseAndSnapshot(cell)).toEqual({ snapshotBytes: 2_147_483_648 });
    await driver.restore(cell);
    expect(api).toEqual([
      ["PATCH", "/vm", { state: "Paused" }],
      ["PUT", "/snapshot/create", { snapshot_type: "Full", snapshot_path: CELL_SNAPSHOT.snapshotPath, mem_file_path: CELL_SNAPSHOT.memFilePath }],
      ["PUT", "/snapshot/load", { snapshot_path: CELL_SNAPSHOT.snapshotPath, mem_backend: { backend_type: "File", backend_path: CELL_SNAPSHOT.memFilePath }, resume_vm: true }]
    ]);
    await driver.syncClock(cell, 1_800_000_000_000);
    await driver.waitReady(cell);
    expect(hostCalls).toEqual(["startJail:create:tenant:abc", "keepSnapshotAndStop", "startJail:restore:tenant:abc", "syncClock:1800000000000", "waitReady"]);
  });

  it("a failed snapshot keeps the VM (no stop), so the orchestrator's resume rolls back", async () => {
    api.length = 0; hostCalls.length = 0; failSnapshot = true;
    await expect(driver.pauseAndSnapshot(cell)).rejects.toMatchObject({ status: 400, faultMessage: "disk full" });
    failSnapshot = false;
    await driver.resume(cell);
    expect(api.map(([method, url]) => `${method} ${url}`)).toEqual(["PATCH /vm", "PUT /snapshot/create", "PATCH /vm"]);
    expect(api.at(-1)![2]).toEqual({ state: "Resumed" });
    expect(hostCalls).toEqual([]);
  });
});
