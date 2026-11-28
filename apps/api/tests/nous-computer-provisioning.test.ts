import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PgClientLike, PgPoolLike } from "@space/db";
import { createFakeCellDriver } from "../src/computer/cell-driver.js";
import { CellDeletedError, CellSuspendedError, createCellOrchestrator, createMemoryCellStore } from "../src/computer/cells.js";
import { CellRegionError, CellsConfigError, cellsRegionConfig, createCellProvisioner, nousComputerFromEnv } from "../src/computer/provisioning.js";

const tenants: Record<string, { status: string; region: string | null }> = {
  "tenant:eu": { status: "ACTIVE", region: "eu" },
  "tenant:us": { status: "ACTIVE", region: "us" },
  "tenant:local": { status: "ACTIVE", region: null },
  "tenant:frozen": { status: "FROZEN", region: "eu" },
  "tenant:gone": { status: "DELETING", region: "eu" }
};
const pool = { query: async (_sql: string, values?: unknown[]) => {
  const row = tenants[String(values?.[0])];
  return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
} } as PgClientLike;

describe("nous computer cell provisioning (one EU region)", () => {
  it("reads one region and its hosts from env, off when unset, and refuses a bad config", () => {
    expect(cellsRegionConfig({})).toBeNull();
    expect(cellsRegionConfig({ SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: '[{"id":"cells-1","ramMib":131072,"maxAwake":25}]' }))
      .toEqual({ region: "eu", hosts: [{ id: "cells-1", ramMib: 131072, maxAwake: 25, draining: false }] });
    expect(cellsRegionConfig({ SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: '[{"id":"cells-1","ramMib":131072,"maxAwake":25,"maxBooting":4}]' })!.hosts[0])
      .toMatchObject({ maxBooting: 4 });
    for (const env of [
      { SPACE_CELLS_REGION: "eu" },
      { SPACE_CELLS_HOSTS: '[{"id":"a","ramMib":1,"maxAwake":1}]' },
      { SPACE_CELLS_REGION: "EU West", SPACE_CELLS_HOSTS: '[{"id":"a","ramMib":1,"maxAwake":1}]' },
      { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: "[]" },
      { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: "not json" },
      { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: '[{"id":"a","ramMib":0,"maxAwake":1}]' },
      { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: '[{"id":"a","ramMib":1,"maxAwake":1,"maxBooting":0}]' },
      { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: '[{"id":"a","ramMib":1,"maxAwake":1},{"id":"a","ramMib":1,"maxAwake":1}]' }
    ]) expect(() => cellsRegionConfig(env), JSON.stringify(env)).toThrow(CellsConfigError);
  });

  it("gives a cell only to an ACTIVE tenant of the served region, made on its first wake", async () => {
    const config = cellsRegionConfig({ SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: '[{"id":"cells-1","ramMib":8192,"maxAwake":4}]' })!;
    let t = 1_000_000;
    const driver = createFakeCellDriver({ advance: (ms) => (t += ms) });
    const cells = createCellOrchestrator({ driver, store: createMemoryCellStore(), hosts: config.hosts, now: () => t });
    const provisioner = createCellProvisioner({ pool, cells, region: config.region });

    expect(await provisioner.ensureTenantCell("tenant:eu")).toMatchObject({ hostId: "cells-1", from: "NONE" });
    expect((await provisioner.ensureTenantCell("tenant:eu")).from).toBe("AWAKE");
    await expect(provisioner.ensureTenantCell("tenant:us")).rejects.toBeInstanceOf(CellRegionError);
    await expect(provisioner.ensureTenantCell("tenant:local")).rejects.toBeInstanceOf(CellRegionError);
    await expect(provisioner.ensureTenantCell("tenant:missing")).rejects.toBeInstanceOf(CellRegionError);
    await expect(provisioner.ensureTenantCell("tenant:frozen")).rejects.toBeInstanceOf(CellSuspendedError);
    await expect(provisioner.ensureTenantCell("tenant:gone")).rejects.toBeInstanceOf(CellDeletedError);
    expect(driver.calls.filter((call) => call.op === "create").map((call) => call.tenantId)).toEqual(["tenant:eu"]);
  });

  it("wires the hub's cells to each host's runner only with the runner token and the gateway admin, else refuses to start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nous-computer-env-"));
    for (const name of ["token", "ai-seal", "ca.pem", "cert.pem", "key.pem"]) await writeFile(join(dir, name), "x".repeat(40));
    const hosts = '[{"id":"nc-cells","ramMib":28672,"maxAwake":12,"url":"http://192.0.2.231:7231"}]';
    const env = { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: hosts, SPACE_CELLS_RUNNER_TOKEN_FILE: join(dir, "token"), SPACE_CELLS_AI_KEY_SEAL_FILE: join(dir, "ai-seal"),
      SPACE_NOUS_GATEWAY_ADMIN_URL: "https://192.0.2.240:8443", SPACE_NOUS_GATEWAY_ADMIN_TLS_DIR: dir };
    expect(nousComputerFromEnv({}, pool as PgPoolLike)).toBeNull();
    const computer = nousComputerFromEnv(env, pool as PgPoolLike)!;
    expect((await computer.cells.hostMetrics()).map((host) => host.hostId)).toEqual(["nc-cells"]);
    expect(typeof computer.lifecycle.requestDeletion).toBe("function");
    expect(typeof computer.aiKeys.connect).toBe("function");
    expect(() => nousComputerFromEnv({ ...env, SPACE_CELLS_AI_KEY_SEAL_FILE: "" }, pool as PgPoolLike)).toThrow("SPACE_CELLS_AI_KEY_SEAL_FILE");
    expect(() => nousComputerFromEnv({ ...env, SPACE_CELLS_HOSTS: hosts.replace(/,"url":"[^"]+"/, "") }, pool as PgPoolLike)).toThrow("nc-cells.url");
    expect(() => nousComputerFromEnv({ ...env, SPACE_NOUS_GATEWAY_ADMIN_URL: "" }, pool as PgPoolLike)).toThrow("SPACE_NOUS_GATEWAY_ADMIN_URL");
    expect(() => nousComputerFromEnv({ ...env, SPACE_CELLS_HOSTS: hosts.replace("http://", "file://") }, pool as PgPoolLike)).toThrow(CellsConfigError);
  });
});
