import type { CellDriver } from "./cell-driver.js";

// The E2B CellDriver for phase 0/alpha (plan clipboard:ZGz1LnD51ELH step 20 rev 2, on the E2B credits of plan clipboard:NDDPJX6cQHS5):
// one paused-or-running sandbox of the nous-cell-small template per tenant. E2B keeps a paused sandbox's RAM and disk itself, so
// sleep is a pause, wake is a connect, and there is no snapshot file to move (upload/download/syncClock do nothing). Placement does
// not apply: configure the orchestrator with one host "e2b", maxAwake 15 (the alpha's awake share) and ramMib 15 x 2048 = 30720.
// shortcut: the real E2BSandboxPort over the e2b SDK (Sandbox.create/list/pause/connect/commands/files/kill, as in the step-5 lab
// ~/agent-workspace/active/20261127-e2b-step5/cell_lab.mjs) is added with the e2b dependency when the alpha API wires cells.

export const E2B_CELL_TEMPLATE = "nous-cell-small";
/** The tenant's own files in the template (HOME=/work); an export is this directory. */
export const E2B_CELL_USER_DIR = "/work";
// shortcut: E2B pauses a sandbox when this runs out and an AWAKE cell's wake makes no driver call, so a cell busy for over an hour is
// paused under the orchestrator; when alpha users run longer sessions, re-arm the timeout (connect) from the tick for busy cells.
export const E2B_CELL_TIMEOUT_MS = 60 * 60_000;
/** A command in the cell (readiness check, export tar) that takes longer than this fails the step. */
export const E2B_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** What the driver needs from E2B; every sandbox is created with lifecycle onTimeout "pause" and metadata { tenantId }. */
export interface E2BSandboxPort {
  /** Starts a sandbox from the template and answers its id. */
  create(template: string, metadata: { tenantId: string }, timeoutMs: number): Promise<string>;
  /** The tenant's sandbox from its metadata (running or paused), or null when it has none. */
  find(tenantId: string): Promise<{ sandboxId: string; paused: boolean } | null>;
  pause(sandboxId: string): Promise<void>;
  /** Resumes a paused sandbox (or reaches a running one) and sets its timeout. */
  connect(sandboxId: string, timeoutMs: number): Promise<void>;
  /** Runs a shell command; rejects when it exits non-zero. */
  run(sandboxId: string, command: string, timeoutMs: number): Promise<void>;
  readFile(sandboxId: string, path: string): Promise<Uint8Array>;
  kill(sandboxId: string): Promise<void>;
}

export function createE2BCellDriver(options: {
  sandboxes: E2BSandboxPort;
  /** Stores a tenant's export where the tenant can fetch it and answers its key. */
  saveExport: (tenantId: string, archive: Uint8Array) => Promise<string>;
  template?: string;
  timeoutMs?: number;
}): CellDriver {
  const { sandboxes } = options;
  const timeoutMs = options.timeoutMs ?? E2B_CELL_TIMEOUT_MS;
  const sandboxOf = async (tenantId: string) => {
    const found = await sandboxes.find(tenantId);
    if (!found) throw new Error(`Cell ${tenantId} has no E2B sandbox.`);
    return found;
  };
  const wake = async (tenantId: string) => sandboxes.connect((await sandboxOf(tenantId)).sandboxId, timeoutMs);
  return {
    async create(cell) {
      // A sandbox left by a create that failed after E2B started it would run on, so it goes first.
      const left = await sandboxes.find(cell.tenantId);
      if (left) await sandboxes.kill(left.sandboxId);
      await sandboxes.create(options.template ?? E2B_CELL_TEMPLATE, { tenantId: cell.tenantId }, timeoutMs);
    },
    resume: (cell) => wake(cell.tenantId),
    async pauseAndSnapshot(cell) {
      await sandboxes.pause((await sandboxOf(cell.tenantId)).sandboxId);
      return { snapshotBytes: 0 }; // E2B holds the paused state; nothing of it is on our side
    },
    restore: (cell) => wake(cell.tenantId),
    syncClock: async () => {}, // E2B resumes the guest with the host's clock
    async waitReady(cell) {
      await sandboxes.run((await sandboxOf(cell.tenantId)).sandboxId, `test -d ${E2B_CELL_USER_DIR}`, E2B_COMMAND_TIMEOUT_MS);
    },
    upload: async (cell) => ({ objectKey: `e2b:${(await sandboxOf(cell.tenantId)).sandboxId}` }),
    download: async () => {},
    async exportUserData(tenantId) {
      const { sandboxId, paused } = await sandboxOf(tenantId);
      await sandboxes.connect(sandboxId, timeoutMs);
      try {
        const archive = `/tmp/export-${Date.now()}.tgz`;
        await sandboxes.run(sandboxId, `cd / && tar -czf ${archive} ${E2B_CELL_USER_DIR.slice(1)}`, E2B_COMMAND_TIMEOUT_MS);
        const bytes = await sandboxes.readFile(sandboxId, archive);
        await sandboxes.run(sandboxId, `rm -f ${archive}`, E2B_COMMAND_TIMEOUT_MS);
        return { exportKey: await options.saveExport(tenantId, bytes) };
      } finally {
        if (paused) await sandboxes.pause(sandboxId); // a sleeping or cold cell goes back to sleep, so it costs no awake time
      }
    },
    async destroy(tenantId) {
      const found = await sandboxes.find(tenantId);
      if (found) await sandboxes.kill(found.sandboxId);
    }
  };
}
