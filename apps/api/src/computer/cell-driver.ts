// What a cells host must do for one tenant's microVM (plan clipboard:ZGz1LnD51ELH §2.3-2.5, K3 lab
// ~/agent-workspace/active/20261101-nous-computer/k3-lab). The orchestrator in cells.ts drives it; the fake below
// stands in until a host with /dev/kvm runs the real one.
// shortcut: no Firecracker-backed CellDriver yet: it needs the host-side runner (jailer chroot per cell, tap in a
// per-VM netns, the per-user egress proxy, NVMe paths, B2/R2 upload) that K3's fc-vm.sh does by hand; write it on
// the first KVM cells host, using firecracker-client.ts for the API calls.

export interface CellRef {
  tenantId: string;
  hostId: string;
  memMib: number;
}

export interface CellDriver {
  /** Boots a new cell from the base image; resolves once the VM runs. */
  create(cell: CellRef): Promise<void>;
  /** Resumes a paused VM that still holds its RAM (rollback when a snapshot fails after the pause). */
  resume(cell: CellRef): Promise<void>;
  /** Pauses, writes a Full snapshot to the host's NVMe and stops the VM so its RAM is freed. */
  pauseAndSnapshot(cell: CellRef): Promise<{ snapshotBytes: number }>;
  /** Loads the host's local snapshot and resumes the VM. */
  restore(cell: CellRef): Promise<void>;
  /** Steps the guest clock (K3 finding 6.2: the guest is behind by the time it slept). */
  syncClock(cell: CellRef, epochMs: number): Promise<void>;
  /** Resolves when the cell's space-vm-agent answers. */
  waitReady(cell: CellRef): Promise<void>;
  /** Moves the local snapshot to object storage and removes the local copy. */
  upload(cell: CellRef): Promise<{ objectKey: string }>;
  /** Fetches a snapshot from object storage onto this host's NVMe. */
  download(cell: CellRef, objectKey: string): Promise<void>;
  /** Exports the tenant's data (user disk) where the tenant can fetch it; cold cells export from objectKey. */
  exportUserData(tenantId: string, where: { hostId: string | null; objectKey: string | null }): Promise<{ exportKey: string }>;
  /** Stops the VM if it runs and wipes every copy: local files and the object-storage snapshot. */
  destroy(tenantId: string, where: { hostId: string | null; objectKey: string | null }): Promise<void>;
}

export type CellDriverOp = keyof CellDriver;

export interface FakeCellDriver extends CellDriver {
  calls: Array<{ op: CellDriverOp; tenantId: string; hostId: string | null }>;
  /** Next call of `op` (for any tenant) rejects with this error. */
  failNext(op: CellDriverOp, error: Error): void;
}

/** In-memory driver: every op waits `delaysMs[op]` on the given clock (a fake clock in tests), then succeeds. */
export function createFakeCellDriver(options: {
  advance?: (ms: number) => void;
  delaysMs?: Partial<Record<CellDriverOp, number>>;
  snapshotBytes?: number;
} = {}): FakeCellDriver {
  const calls: FakeCellDriver["calls"] = [];
  const failures = new Map<CellDriverOp, Error>();
  async function step(op: CellDriverOp, tenantId: string, hostId: string | null): Promise<void> {
    calls.push({ op, tenantId, hostId });
    await new Promise((resolve) => setImmediate(resolve));
    options.advance?.(options.delaysMs?.[op] ?? 0);
    const error = failures.get(op);
    if (error) {
      failures.delete(op);
      throw error;
    }
  }
  return {
    calls,
    failNext: (op, error) => void failures.set(op, error),
    create: (cell) => step("create", cell.tenantId, cell.hostId),
    resume: (cell) => step("resume", cell.tenantId, cell.hostId),
    pauseAndSnapshot: async (cell) => {
      await step("pauseAndSnapshot", cell.tenantId, cell.hostId);
      return { snapshotBytes: options.snapshotBytes ?? cell.memMib * 1024 * 1024 };
    },
    restore: (cell) => step("restore", cell.tenantId, cell.hostId),
    syncClock: (cell) => step("syncClock", cell.tenantId, cell.hostId),
    waitReady: (cell) => step("waitReady", cell.tenantId, cell.hostId),
    upload: async (cell) => {
      await step("upload", cell.tenantId, cell.hostId);
      return { objectKey: `cells/${cell.tenantId}/snapshot` };
    },
    download: (cell) => step("download", cell.tenantId, cell.hostId),
    exportUserData: async (tenantId, where) => {
      await step("exportUserData", tenantId, where.hostId);
      return { exportKey: `exports/${tenantId}/user.ext4` };
    },
    destroy: (tenantId, where) => step("destroy", tenantId, where.hostId)
  };
}
