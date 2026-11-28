import { describe, expect, it } from "vitest";
import type { PgClientLike } from "@space/db";
import { createFakeCellDriver } from "../src/computer/cell-driver.js";
import { CellDeletedError, CellSuspendedError, createCellOrchestrator, createMemoryCellStore } from "../src/computer/cells.js";
import { CellRegionError, CellsConfigError, cellsRegionConfig, createCellProvisioner } from "../src/computer/provisioning.js";

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
    for (const env of [
      { SPACE_CELLS_REGION: "eu" },
      { SPACE_CELLS_HOSTS: '[{"id":"a","ramMib":1,"maxAwake":1}]' },
      { SPACE_CELLS_REGION: "EU West", SPACE_CELLS_HOSTS: '[{"id":"a","ramMib":1,"maxAwake":1}]' },
      { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: "[]" },
      { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: "not json" },
      { SPACE_CELLS_REGION: "eu", SPACE_CELLS_HOSTS: '[{"id":"a","ramMib":0,"maxAwake":1}]' },
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
});
