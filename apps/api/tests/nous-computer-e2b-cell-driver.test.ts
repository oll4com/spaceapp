import { describe, expect, it } from "vitest";
import { IDLE_TO_SLEEP_MS, SLEEP_TO_COLD_MS, createCellOrchestrator, createMemoryCellStore } from "../src/computer/cells.js";
import { E2B_CELL_TEMPLATE, createE2BCellDriver, type E2BSandboxPort } from "../src/computer/e2b-cell-driver.js";

// Step 20 rev 2: the orchestrator's whole cell life on the E2B driver against an in-memory E2B (create, sleep, cold, wake, export, delete).
function fakeE2B() {
  const boxes = new Map<string, { tenantId: string; paused: boolean }>();
  const calls: string[] = [];
  let next = 0;
  const box = (id: string) => {
    const found = boxes.get(id);
    if (!found) throw new Error(`no sandbox ${id}`);
    return found;
  };
  const port: E2BSandboxPort = {
    create: async (template, { tenantId }) => {
      const id = `sbx${++next}`;
      calls.push(`create:${template}:${tenantId}`);
      boxes.set(id, { tenantId, paused: false });
      return id;
    },
    find: async (tenantId) => {
      const hit = [...boxes].find(([, b]) => b.tenantId === tenantId);
      return hit ? { sandboxId: hit[0], paused: hit[1].paused } : null;
    },
    pause: async (id) => void (calls.push(`pause:${id}`), (box(id).paused = true)),
    connect: async (id) => void (calls.push(`connect:${id}`), (box(id).paused = false)),
    run: async (id, command) => {
      if (box(id).paused) throw new Error("run on a paused sandbox");
      calls.push(`run:${id}:${command.split(" ")[0]}`);
    },
    readFile: async (id) => (box(id), new Uint8Array([1, 2, 3])),
    kill: async (id) => void (calls.push(`kill:${id}`), boxes.delete(id))
  };
  return { port, boxes, calls };
}

describe("E2B cell driver", () => {
  it("runs a cell's whole life on one sandbox and kills it on delete", async () => {
    let t = 1_000_000;
    const e2b = fakeE2B();
    const exports: Array<[string, number]> = [];
    const driver = createE2BCellDriver({ sandboxes: e2b.port, saveExport: async (tenantId, bytes) => (exports.push([tenantId, bytes.length]), `exports/${tenantId}`) });
    const cells = createCellOrchestrator({ driver, store: createMemoryCellStore(), hosts: [{ id: "e2b", ramMib: 30_720, maxAwake: 15 }], now: () => t });

    await cells.ensureAwake("tenant:a");
    expect(e2b.calls).toEqual([`create:${E2B_CELL_TEMPLATE}:tenant:a`, "run:sbx1:test"]);
    t += IDLE_TO_SLEEP_MS + 1;
    await cells.tick();
    expect(await cells.cell("tenant:a")).toMatchObject({ state: "SLEEPING", snapshotBytes: 0 });
    t += SLEEP_TO_COLD_MS + 1;
    await cells.tick();
    expect(await cells.cell("tenant:a")).toMatchObject({ state: "COLD", objectKey: "e2b:sbx1", hostId: null });

    e2b.calls.length = 0;
    expect((await cells.ensureAwake("tenant:a")).from).toBe("COLD");
    expect(e2b.calls).toEqual(["connect:sbx1", "run:sbx1:test"]);

    // An export of a sleeping cell wakes it only for the tar and pauses it again.
    t += IDLE_TO_SLEEP_MS + 1;
    await cells.tick();
    e2b.calls.length = 0;
    expect(await cells.exportCell("tenant:a")).toEqual({ exportKey: "exports/tenant:a" });
    expect(exports).toEqual([["tenant:a", 3]]);
    expect(e2b.calls).toEqual(["connect:sbx1", "run:sbx1:cd", "run:sbx1:rm", "pause:sbx1"]);

    await cells.deleteCell("tenant:a");
    expect(e2b.calls.at(-1)).toBe("kill:sbx1");
    expect(e2b.boxes.size).toBe(0);
  });

  it("a create kills a sandbox left by an earlier failed create, and a missing sandbox fails the wake", async () => {
    const e2b = fakeE2B();
    const driver = createE2BCellDriver({ sandboxes: e2b.port, saveExport: async () => "x" });
    const cell = { tenantId: "tenant:b", hostId: "e2b", memMib: 2048 };
    await e2b.port.create(E2B_CELL_TEMPLATE, { tenantId: "tenant:b" }, 1);
    await driver.create(cell);
    expect([...e2b.boxes.keys()]).toEqual(["sbx2"]);
    expect(e2b.calls).toContain("kill:sbx1");
    await driver.destroy("tenant:b", { hostId: null, objectKey: null });
    await driver.destroy("tenant:b", { hostId: null, objectKey: null }); // nothing left: no error
    await expect(driver.restore(cell)).rejects.toThrow(/has no E2B sandbox/);
  });
});
