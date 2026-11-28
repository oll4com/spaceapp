import { createHash } from "node:crypto";
import type { CellDriver, CellRef } from "./cell-driver.js";
import { createFirecrackerClient, type FirecrackerClient } from "./firecracker-client.js";

// The host-independent half of the Firecracker CellDriver (plan clipboard:ZGz1LnD51ELH step 20): the API call order of K3's
// fc-vm.sh (boot with ROOT_RO=1 and BALLOON=1, sleep, wake) and the jailer arguments. The host half is the CellHostPort below.

/** The snapshot files, relative to the jail's root as Firecracker sees them. */
export const CELL_SNAPSHOT = { snapshotPath: "snap.vmstate", memFilePath: "snap.mem" } as const;
export const CELL_VCPUS = 2;
/** K3: the cgroup allows the guest's RAM plus 256 MiB for Firecracker itself. */
export const CELL_MEMORY_OVERHEAD_MIB = 256;

/** jailer's --id takes [A-Za-z0-9-] up to 64 characters and a tenant id has ':', so a cell is named by a hash of its tenant. */
export const cellId = (tenantId: string) => `c-${createHash("sha256").update(tenantId).digest("hex").slice(0, 24)}`;

/** What only a KVM host can do; implemented by cell-host.ts. Each cell has its own netns, so its tap is always tap0. */
export interface CellHostPort {
  /** The running cell's API socket, from the host's side of the jail. */
  socketPath(cell: CellRef): string;
  /** Rebuilds the jail with the cell's files linked in and starts an empty Firecracker; "create" first makes the user disk. */
  startJail(cell: CellRef, mode: "create" | "restore"): Promise<void>;
  /** Moves the snapshot files out of the jail into the cell's own directory, kills the jail, answers the snapshot's bytes. */
  keepSnapshotAndStop(cell: CellRef): Promise<number>;
  /** Over vsock to space-vm-agent. */
  waitReady(cell: CellRef): Promise<void>;
  syncClock(cell: CellRef, epochMs: number): Promise<void>;
  upload: CellDriver["upload"];
  download: CellDriver["download"];
  exportUserData: CellDriver["exportUserData"];
  destroy: CellDriver["destroy"];
}

/** The API calls that boot a new cell, in order (fc-vm.sh boot): shared read-only base image, own user disk, balloon, vsock. */
export function cellBootCalls(cell: CellRef, vcpus = CELL_VCPUS): Array<[path: string, body: unknown]> {
  return [
    ["/machine-config", { vcpu_count: vcpus, mem_size_mib: cell.memMib }],
    ["/boot-source", { kernel_image_path: "vmlinux", boot_args: "console=ttyS0 reboot=k panic=1" }],
    ["/drives/rootfs", { drive_id: "rootfs", path_on_host: "rootfs.ext4", is_root_device: true, is_read_only: true }],
    ["/drives/user", { drive_id: "user", path_on_host: "user.ext4", is_root_device: false, is_read_only: false }],
    ["/network-interfaces/eth0", { iface_id: "eth0", guest_mac: "06:00:AC:10:00:02", host_dev_name: "tap0" }],
    ["/balloon", { amount_mib: 0, deflate_on_oom: true, stats_polling_interval_s: 1, free_page_reporting: true }],
    ["/vsock", { guest_cid: 3, uds_path: "v.sock" }],
    ["/actions", { action_type: "InstanceStart" }]
  ];
}

/** The jailer's argv (fc-vm.sh jail): own uid/gid, chroot, PID namespace and netns, cgroup v2 memory and CPU limits. */
export function cellJailerArgs(cell: CellRef, host: { uid: number; netnsPath: string; chrootBaseDir: string; firecrackerPath: string }, vcpus = CELL_VCPUS): string[] {
  if (!Number.isInteger(host.uid) || host.uid < 10_000) throw new Error("A cell runs as its own unprivileged uid (10000 or more).");
  return ["--id", cellId(cell.tenantId), "--exec-file", host.firecrackerPath, "--uid", String(host.uid), "--gid", String(host.uid),
    "--chroot-base-dir", host.chrootBaseDir, "--netns", host.netnsPath, "--cgroup-version", "2",
    "--cgroup", `memory.max=${(cell.memMib + CELL_MEMORY_OVERHEAD_MIB) * 1_048_576}`, "--cgroup", `cpu.max=${vcpus * 100_000} 100000`,
    "--new-pid-ns", "--daemonize", "--", "--api-sock", "/run/firecracker.socket"];
}

export function createFirecrackerCellDriver(options: { host: CellHostPort; vcpus?: number; connect?: (socketPath: string) => FirecrackerClient }): CellDriver {
  const { host } = options;
  const connect = options.connect ?? ((socketPath: string) => createFirecrackerClient(socketPath));
  const api = (cell: CellRef) => connect(host.socketPath(cell));
  return {
    async create(cell) {
      await host.startJail(cell, "create");
      const fc = api(cell);
      for (const [path, body] of cellBootCalls(cell, options.vcpus)) await fc.put(path, body);
    },
    resume: (cell) => api(cell).resume(),
    // A failed snapshot leaves the VM paused and running, so the orchestrator's resume() rolls it back.
    async pauseAndSnapshot(cell) {
      const fc = api(cell);
      await fc.pause();
      await fc.createSnapshot(CELL_SNAPSHOT);
      return { snapshotBytes: await host.keepSnapshotAndStop(cell) };
    },
    async restore(cell) {
      await host.startJail(cell, "restore");
      await api(cell).loadSnapshot(CELL_SNAPSHOT, true);
    },
    syncClock: (cell, epochMs) => host.syncClock(cell, epochMs),
    waitReady: (cell) => host.waitReady(cell),
    upload: (cell) => host.upload(cell),
    download: (cell, objectKey) => host.download(cell, objectKey),
    exportUserData: (tenantId, where) => host.exportUserData(tenantId, where),
    destroy: (tenantId, where) => host.destroy(tenantId, where)
  };
}
