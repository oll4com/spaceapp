import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeCellDriver } from "../src/computer/cell-driver.js";
import { createCellRunnerServer, createRemoteCellDriver } from "../src/computer/cell-runner.js";

const token = "t".repeat(40);
const cell = { tenantId: "tenant:abc", hostId: "nc-cells", memMib: 1024 };

describe("cell runner", () => {
  const fake = createFakeCellDriver({ snapshotBytes: 7 });
  const server = createCellRunnerServer(fake, token);
  let url = "";
  beforeAll(() => new Promise<void>((r) => server.listen(0, "127.0.0.1", () => ((url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`), r()))));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const post = (path: string, body: string, auth = `Bearer ${token}`) =>
    fetch(`${url}${path}`, { method: "POST", headers: { authorization: auth }, body }).then((r) => r.status);

  it("drives the host's driver through the remote driver, errors included", async () => {
    const remote = createRemoteCellDriver({ hosts: { "nc-cells": url, "nc-cells-2": "http://127.0.0.1:1" }, token });
    await remote.create(cell);
    expect(await remote.pauseAndSnapshot(cell)).toEqual({ snapshotBytes: 7 });
    await remote.syncClock(cell, 1_800_000_000_000);
    expect(await remote.exportUserData("tenant:abc", { hostId: null, objectKey: "k" })).toEqual({ exportKey: "exports/tenant:abc/user.ext4" });
    fake.failNext("restore", new Error("no snapshot"));
    await expect(remote.restore(cell)).rejects.toThrow("cell runner restore: 500 no snapshot");
    expect(fake.calls.map((c) => c.op)).toEqual(["create", "pauseAndSnapshot", "syncClock", "exportUserData", "restore"]);
    // Each call goes to its cell's host; a host with no runner fails before any request.
    await expect(remote.create({ ...cell, hostId: "nc-cells-2" })).rejects.toThrow();
    await expect(remote.create({ ...cell, hostId: "elsewhere" })).rejects.toThrow("no runner for host elsewhere");
    expect(fake.calls.length).toBe(5);
  });

  it("refuses a wrong token, an unknown op and bad args before the driver", async () => {
    const before = fake.calls.length;
    expect(await post("/v1/cells/create", JSON.stringify({ args: [cell] }), "Bearer wrong")).toBe(401);
    expect(await post("/v1/cells/create", JSON.stringify({ args: [cell] }), "")).toBe(401);
    expect(await post("/v1/cells/constructor", "{}")).toBe(404);
    expect(await post("/v1/cells/failNext", "{}")).toBe(404);
    expect(await post("/v1/cells/create", JSON.stringify({ args: [{ ...cell, memMib: "1g" }] }))).toBe(400);
    expect(await post("/v1/cells/download", JSON.stringify({ args: [cell] }))).toBe(400);
    expect(await post("/v1/cells/create", "not json")).toBe(400);
    expect(await post("/v1/cells/create", JSON.stringify({ args: [cell], pad: "x".repeat(70_000) })).catch(() => 413)).toBe(413);
    expect(fake.calls.length).toBe(before);
    expect(() => createCellRunnerServer(fake, "short")).toThrow("at least 32");
  });
});
