import type { CellDriver, CellRef } from "./cell-driver.js";

// Per-tenant microVM ("cell") lifecycle and placement for Nous Computer (plan clipboard:ZGz1LnD51ELH §2.3-2.5, §8
// K3/K8; rules in docs/agents/nous-computer.md). Not wired into app.ts yet: K2's headless `vmTurnBackend(tenantId)`
// will call ensureAwake before every space-vm-agent call and run tick() on a timer.
//
//   NONE -> CREATING -> AWAKE <-> SLEEPING (paused, Full snapshot on host NVMe, RAM freed) -> COLD (object storage)
//   any state -> DELETED (after a finished export, or forced by the tenant-deletion path)

/** Plan §2.4: a warm wake costs 0.15-0.3 s (K3 p95 210-473 ms at 10 cells), so an idle cell gives its RAM back after 3 minutes. */
export const IDLE_TO_SLEEP_MS = 3 * 60_000;
/** Plan §2.4: a sleeping cell keeps 1.4-2.5 GiB of host NVMe (K3); after a day it moves to object storage, where a wake costs 2-8 s. */
export const SLEEP_TO_COLD_MS = 24 * 60 * 60_000;
/** Wake p95 is an operating signal: wakes older than an hour describe another load, so the metric reads the last hour. */
export const WAKE_P95_WINDOW_MS = 60 * 60_000;
/** P1 sizing: a working CLI cell needs ~2 GiB (K3: ~1.1 GiB idle after balloon). */
export const DEFAULT_CELL_MEM_MIB = 2048;

export type CellState = "NONE" | "CREATING" | "AWAKE" | "SLEEPING" | "COLD" | "DELETED";

export interface CellRecord {
  tenantId: string;
  state: CellState;
  /** Host whose RAM or NVMe holds the cell; null when NONE, COLD or DELETED. */
  hostId: string | null;
  memMib: number;
  lastActiveAt: number;
  sleptAt: number | null;
  snapshotBytes: number | null;
  objectKey: string | null;
  exportKey: string | null;
  exportedAt: number | null;
  updatedAt: number;
}

// Design for the SQL store (not a migration yet: a new table needs its class in scripts/tests/record-retention.test.mjs;
// cells are durable records, so a deleted cell stays as a DELETED row):
//   CREATE TABLE nous_computer_cells (tenant_id text PRIMARY KEY, state text NOT NULL, host_id text, mem_mib int NOT NULL,
//     last_active_at timestamptz NOT NULL, slept_at timestamptz, snapshot_bytes bigint, object_key text,
//     export_key text, exported_at timestamptz, updated_at timestamptz NOT NULL);
//   CREATE INDEX nous_computer_cells_host ON nous_computer_cells (host_id, state);
export interface CellStore {
  get(tenantId: string): Promise<CellRecord | undefined>;
  put(record: CellRecord): Promise<void>;
  list(): Promise<CellRecord[]>;
}

export function createMemoryCellStore(): CellStore {
  const rows = new Map<string, CellRecord>();
  return {
    get: async (tenantId) => {
      const row = rows.get(tenantId);
      return row && { ...row };
    },
    put: async (record) => void rows.set(record.tenantId, { ...record }),
    list: async () => [...rows.values()].map((row) => ({ ...row }))
  };
}

export interface CellHost {
  id: string;
  ramMib: number;
  maxAwake: number;
  draining?: boolean;
}

export interface HostMetrics {
  hostId: string;
  draining: boolean;
  awake: number;
  sleeping: number;
  freeRamMib: number;
  /** Wakes from SLEEPING or COLD in the last WAKE_P95_WINDOW_MS (a first boot is a create, not a wake). */
  wakes: number;
  wakeP95Ms: number | null;
}

export interface WakeResult {
  tenantId: string;
  hostId: string;
  from: CellState;
  wakeMs: number;
}

export interface TickResult {
  slept: string[];
  cooled: string[];
  errors: Array<{ tenantId: string; error: unknown }>;
}

export class CellCapacityError extends Error {}
export class CellDeletedError extends Error {}
export class CellExportRequiredError extends Error {}

export interface CellOrchestrator {
  /** Wakes, restores or creates the tenant's cell; concurrent calls share one wake. Call it before every vm-agent call: it also marks activity. */
  ensureAwake(tenantId: string): Promise<WakeResult>;
  /** Idle AWAKE cells sleep, old SLEEPING cells (and every sleeping cell of a draining host) go cold. Run it on a timer. */
  tick(): Promise<TickResult>;
  exportCell(tenantId: string): Promise<{ exportKey: string }>;
  /** Refuses without an export newer than the cell's last activity, unless the tenant-deletion path forces it. */
  deleteCell(tenantId: string, options?: { force?: "tenant-deletion" }): Promise<void>;
  /** The host takes no new cells; its cells leave through cold as they go idle. */
  drainHost(hostId: string): void;
  hostMetrics(): Promise<HostMetrics[]>;
  cell(tenantId: string): Promise<CellRecord | undefined>;
}

export function createCellOrchestrator(options: {
  driver: CellDriver;
  store: CellStore;
  hosts: CellHost[];
  now?: () => number;
  idleToSleepMs?: number;
  sleepToColdMs?: number;
  cellMemMib?: number;
}): CellOrchestrator {
  const { driver, store } = options;
  const now = options.now ?? Date.now;
  const idleToSleepMs = options.idleToSleepMs ?? IDLE_TO_SLEEP_MS;
  const sleepToColdMs = options.sleepToColdMs ?? SLEEP_TO_COLD_MS;
  const hosts = new Map(options.hosts.map((host) => [host.id, { ...host, draining: host.draining ?? false }]));
  const tails = new Map<string, Promise<unknown>>();
  const wakes = new Map<string, Promise<WakeResult>>();
  // Cells being woken onto a host count as awake there until their record says so.
  const reserved = new Map<string, { hostId: string; memMib: number }>();
  const wakeSamples = new Map<string, Array<{ at: number; ms: number }>>();

  // One queue per key: "tenant:<id>" serializes a cell's transitions, "placement" serializes host choice and eviction.
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (tails.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => tails.get(key) === tail && tails.delete(key));
    return run;
  }
  const tenantKey = (tenantId: string) => `tenant:${tenantId}`;
  const busy = (tenantId: string) => tails.has(tenantKey(tenantId));
  const ref = (record: CellRecord, hostId: string): CellRef => ({ tenantId: record.tenantId, hostId, memMib: record.memMib });

  async function load(tenantId: string): Promise<CellRecord> {
    return (
      (await store.get(tenantId)) ?? {
        tenantId,
        state: "NONE",
        hostId: null,
        memMib: options.cellMemMib ?? DEFAULT_CELL_MEM_MIB,
        lastActiveAt: now(),
        sleptAt: null,
        snapshotBytes: null,
        objectKey: null,
        exportKey: null,
        exportedAt: null,
        updatedAt: now()
      }
    );
  }
  async function save(record: CellRecord, patch: Partial<CellRecord>): Promise<CellRecord> {
    const next = { ...record, ...patch, updatedAt: now() };
    await store.put(next);
    return next;
  }

  async function usage() {
    const byHost = new Map([...hosts.keys()].map((id) => [id, { awake: [] as CellRecord[], count: 0, sleeping: 0, usedMib: 0 }]));
    for (const record of await store.list()) {
      const host = record.hostId ? byHost.get(record.hostId) : undefined;
      if (!host) continue;
      if ((record.state === "AWAKE" || record.state === "CREATING") && !reserved.has(record.tenantId)) {
        host.awake.push(record);
        host.count += 1;
        host.usedMib += record.memMib;
      } else if (record.state === "SLEEPING") host.sleeping += 1;
    }
    for (const r of reserved.values()) {
      const host = byHost.get(r.hostId);
      if (host) {
        host.count += 1;
        host.usedMib += r.memMib;
      }
    }
    return byHost;
  }

  // Picks the host (pinned for a SLEEPING cell whose snapshot is on its NVMe, else the most free RAM among hosts that
  // fit without eviction, then among all non-draining ones), evicts its longest-idle awake cells until the cell fits.
  function reserve(record: CellRecord, pinnedHostId: string | null): Promise<string> {
    return serial("placement", async () => {
      let use = await usage();
      const fits = (hostId: string) => {
        const host = hosts.get(hostId);
        const u = use.get(hostId);
        return !!host && !!u && u.count < host.maxAwake && host.ramMib - u.usedMib >= record.memMib;
      };
      let hostId = pinnedHostId;
      if (!hostId) {
        const free = (id: string) => (hosts.get(id)?.ramMib ?? 0) - (use.get(id)?.usedMib ?? 0);
        const open = [...hosts.values()].filter((host) => !host.draining).map((host) => host.id);
        hostId = open.sort((a, b) => Number(fits(b)) - Number(fits(a)) || free(b) - free(a))[0] ?? null;
        if (!hostId) throw new CellCapacityError("No cells host takes new cells (all draining or none configured).");
      }
      if (!hosts.has(hostId)) throw new CellCapacityError(`Cells host ${hostId} is not configured.`);
      while (!fits(hostId)) {
        const victim = (use.get(hostId)?.awake ?? [])
          .filter((cell) => cell.state === "AWAKE" && !busy(cell.tenantId))
          .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
        if (!victim) throw new CellCapacityError(`Cells host ${hostId} is full and every awake cell is busy.`);
        await serial(tenantKey(victim.tenantId), async () => sleep(await load(victim.tenantId)));
        use = await usage();
      }
      reserved.set(record.tenantId, { hostId, memMib: record.memMib });
      return hostId;
    });
  }

  async function sleep(record: CellRecord): Promise<boolean> {
    if (record.state !== "AWAKE" || !record.hostId) return false;
    const cell = ref(record, record.hostId);
    let snapshotBytes: number;
    try {
      ({ snapshotBytes } = await driver.pauseAndSnapshot(cell));
    } catch (error) {
      // The VM is paused with its RAM intact: resume it so the tenant keeps a working cell.
      await driver.resume(cell).catch((resumeError: unknown) => {
        throw new AggregateError([error, resumeError], `Cell ${record.tenantId} failed to snapshot and to resume.`);
      });
      throw error;
    }
    await save(record, { state: "SLEEPING", sleptAt: now(), snapshotBytes });
    return true;
  }

  async function cool(record: CellRecord): Promise<CellRecord> {
    if (record.state !== "SLEEPING" || !record.hostId) return record;
    const { objectKey } = await driver.upload(ref(record, record.hostId));
    return save(record, { state: "COLD", hostId: null, objectKey });
  }

  async function wake(tenantId: string): Promise<WakeResult> {
    const started = now();
    let record = await load(tenantId);
    const from = record.state;
    if (from === "DELETED") throw new CellDeletedError(`Cell ${tenantId} was deleted.`);
    if (from === "AWAKE" && record.hostId) {
      await save(record, { lastActiveAt: started });
      return { tenantId, hostId: record.hostId, from, wakeMs: 0 };
    }
    // A draining host's sleeping cells leave through cold instead of waking where they are.
    if (from === "SLEEPING" && record.hostId && hosts.get(record.hostId)?.draining) record = await cool(record);
    const hostId = await reserve(record, record.state === "SLEEPING" ? record.hostId : null);
    try {
      if (record.state === "NONE" || record.state === "CREATING") {
        record = await save(record, { state: "CREATING", hostId, lastActiveAt: started });
        await driver.create(ref(record, hostId));
      } else {
        if (record.state === "COLD") {
          if (!record.objectKey) throw new Error(`Cold cell ${tenantId} has no snapshot object.`);
          await driver.download(ref(record, hostId), record.objectKey);
        }
        await driver.restore(ref(record, hostId));
        await driver.syncClock(ref(record, hostId), now());
      }
      await driver.waitReady(ref(record, hostId));
    } catch (error) {
      // SLEEPING and COLD keep their snapshot, so they stay as they were; a failed create starts over next time.
      if (record.state === "CREATING") await save(record, { state: "NONE", hostId: null });
      throw error;
    } finally {
      reserved.delete(tenantId);
    }
    const wakeMs = now() - started;
    await save(record, { state: "AWAKE", hostId, lastActiveAt: now(), sleptAt: null });
    if (from === "SLEEPING" || from === "COLD") {
      const window = (wakeSamples.get(hostId) ?? []).filter((sample) => sample.at > now() - WAKE_P95_WINDOW_MS);
      window.push({ at: now(), ms: wakeMs });
      wakeSamples.set(hostId, window);
    }
    return { tenantId, hostId, from, wakeMs };
  }

  return {
    ensureAwake(tenantId) {
      const pending = wakes.get(tenantId);
      if (pending) return pending;
      const run = serial(tenantKey(tenantId), () => wake(tenantId)).finally(() => wakes.delete(tenantId));
      wakes.set(tenantId, run);
      return run;
    },

    async tick() {
      const result: TickResult = { slept: [], cooled: [], errors: [] };
      const jobs = (await store.list())
        .filter((record) => !busy(record.tenantId))
        .map((listed) =>
          serial(tenantKey(listed.tenantId), async () => {
            const record = await load(listed.tenantId);
            const at = now();
            if (record.state === "AWAKE" && at - record.lastActiveAt >= idleToSleepMs) {
              if (await sleep(record)) result.slept.push(record.tenantId);
            } else if (record.state === "SLEEPING" && record.hostId) {
              const draining = hosts.get(record.hostId)?.draining === true;
              if (draining || at - (record.sleptAt ?? at) >= sleepToColdMs) {
                await cool(record);
                result.cooled.push(record.tenantId);
              }
            }
          }).catch((error: unknown) => void result.errors.push({ tenantId: listed.tenantId, error }))
        );
      await Promise.all(jobs);
      return result;
    },

    exportCell(tenantId) {
      return serial(tenantKey(tenantId), async () => {
        const record = await load(tenantId);
        if (record.state === "NONE" || record.state === "DELETED") throw new Error(`Cell ${tenantId} has nothing to export (${record.state}).`);
        const { exportKey } = await driver.exportUserData(tenantId, { hostId: record.hostId, objectKey: record.objectKey });
        await save(record, { exportKey, exportedAt: now() });
        return { exportKey };
      });
    },

    deleteCell(tenantId, deleteOptions = {}) {
      return serial(tenantKey(tenantId), async () => {
        const record = await load(tenantId);
        if (record.state === "DELETED") return;
        const exported = record.exportedAt !== null && record.exportedAt >= record.lastActiveAt;
        if (!exported && deleteOptions.force !== "tenant-deletion") {
          throw new CellExportRequiredError(`Cell ${tenantId} has no export newer than its last activity; export it first.`);
        }
        await driver.destroy(tenantId, { hostId: record.hostId, objectKey: record.objectKey });
        await save(record, { state: "DELETED", hostId: null, objectKey: null, snapshotBytes: null });
      });
    },

    drainHost(hostId) {
      const host = hosts.get(hostId);
      if (!host) throw new Error(`Cells host ${hostId} is not configured.`);
      host.draining = true;
    },

    async hostMetrics() {
      const use = await usage();
      return [...hosts.values()].map((host) => {
        const u = use.get(host.id);
        const samples = (wakeSamples.get(host.id) ?? []).filter((sample) => sample.at > now() - WAKE_P95_WINDOW_MS).map((s) => s.ms);
        samples.sort((a, b) => a - b);
        return {
          hostId: host.id,
          draining: host.draining,
          awake: u?.count ?? 0,
          sleeping: u?.sleeping ?? 0,
          freeRamMib: host.ramMib - (u?.usedMib ?? 0),
          wakes: samples.length,
          // nearest-rank p95
          wakeP95Ms: samples.length ? (samples[Math.ceil(samples.length * 0.95) - 1] ?? null) : null
        };
      });
    },

    cell: (tenantId) => store.get(tenantId)
  };
}
