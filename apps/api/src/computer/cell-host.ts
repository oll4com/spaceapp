import { execFile } from "../safe-child-process.js";
import { createHash } from "node:crypto";
import { access, chown, copyFile, link, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CellRef } from "./cell-driver.js";
import { childProcessEnv } from "../child-process-env.js";
import { cellId, cellJailerArgs, type CellHostPort } from "./firecracker-cell-driver.js";

// Step 20: the real CellHostPort, run as root on the cells host (nc-cells on pve-az; K3 lab layout: base images, jail and cells on one
// filesystem so a hard link shares one inode). Snapshots go cold to a plain directory (pve-az vmcold); no bucket is bought.
// shortcut: the tap has no address and no egress proxy, so a cell has no network yet; add the per-user egress proxy and nftables
// before any user reaches a cell. A uid collision between two cells is possible (hash into 50000 slots): switch to a counter if the host
// ever holds more than a few hundred cells.

export const AGENT_VSOCK_PORT = 5252;
const exec = promisify(execFile);
export type Run = (cmd: string, args: string[]) => Promise<void>;
const defaultRun: Run = async (cmd, args) => void (await exec(cmd, args, { env: childProcessEnv() }));
const COLD_KEY = /^c-[0-9a-f]{24}$/;

export interface CellHostOptions {
  /** Holds images/vmlinux, images/rootfs.ext4 (the read-only base) and cells/<id>/. */
  root: string;
  /** The jailer's chroot base; same filesystem as root. */
  chrootBase: string;
  /** Where sleeping-for-days snapshots go (a directory), and where exports are put. */
  coldDir: string;
  exportDir: string;
  firecrackerPath?: string;
  jailerPath?: string;
  userDiskGb?: number;
  run?: Run;
  readyTimeoutMs?: number;
}

export function createCellHost(options: CellHostOptions): CellHostPort {
  const run = options.run ?? defaultRun;
  const firecrackerPath = options.firecrackerPath ?? "/usr/local/bin/firecracker";
  const jailerPath = options.jailerPath ?? "/usr/local/bin/jailer";
  const jailBase = (id: string) => join(options.chrootBase, "firecracker", id);
  const jailRoot = (id: string) => join(jailBase(id), "root");
  const cellDir = (id: string) => join(options.root, "cells", id);
  const uidOf = (id: string) => 10_000 + (Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % 50_000);
  const netns = (id: string) => `nc-${id}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function agent(cell: CellRef, request: object): Promise<{ ok: boolean; error?: string }> {
    const socket = connect(join(jailRoot(cellId(cell.tenantId)), "v.sock"));
    return new Promise((resolve, reject) => {
      let buffer = "", connected = false;
      socket.on("error", reject);
      socket.on("close", () => reject(new Error("vsock closed without an answer"))); // the proxy hangs up while the guest agent is not listening yet
      socket.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!connected) {
          if (!line.startsWith("OK")) return reject(new Error(`vsock connect refused: ${line}`));
          connected = true;
          return void socket.write(`${JSON.stringify(request)}\n`);
        }
        socket.end();
        resolve(JSON.parse(line));
      });
      socket.on("connect", () => socket.write(`CONNECT ${AGENT_VSOCK_PORT}\n`));
    });
  }

  /** Kills the cell's Firecracker if a jail exists and removes its jail, netns and cgroup; the cell's own directory stays. */
  async function stopJail(id: string): Promise<void> {
    const pid = Number.parseInt(await readFile(join(jailRoot(id), "firecracker.pid"), "utf8").catch(() => ""), 10);
    if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    await run("ip", ["netns", "del", netns(id)]).catch(() => undefined);
    await rm(jailBase(id), { recursive: true, force: true });
    await rm(`/sys/fs/cgroup/firecracker/${id}`, { recursive: true, force: true }).catch(() => undefined);
  }

  const bytes = async (path: string) => (await stat(path)).size;

  return {
    socketPath: (cell) => join(jailRoot(cellId(cell.tenantId)), "run", "firecracker.socket"),

    async startJail(cell, mode) {
      const id = cellId(cell.tenantId), uid = uidOf(id), root = jailRoot(id), dir = cellDir(id);
      await mkdir(dir, { recursive: true });
      if (mode === "create") {
        await run("truncate", ["-s", `${options.userDiskGb ?? 1}G`, join(dir, "user.ext4")]);
        await run("mkfs.ext4", ["-q", "-F", join(dir, "user.ext4")]);
      }
      await stopJail(id);
      await mkdir(root, { recursive: true });
      // Never chown the shared inodes: vmlinux and the base are root-owned and hard-linked into every cell (K3 checklist 3.2).
      await link(join(options.root, "images", "vmlinux"), join(root, "vmlinux"));
      await link(join(options.root, "images", "rootfs.ext4"), join(root, "rootfs.ext4"));
      for (const file of mode === "restore" ? ["user.ext4", "snap.mem", "snap.vmstate"] : ["user.ext4"]) {
        await link(join(dir, file), join(root, file));
        await chown(join(root, file), uid, uid);
      }
      await run("ip", ["netns", "add", netns(id)]);
      await run("ip", ["-n", netns(id), "tuntap", "add", "dev", "tap0", "mode", "tap", "user", String(uid)]);
      await run("ip", ["-n", netns(id), "link", "set", "tap0", "up"]);
      await run(jailerPath, cellJailerArgs(cell, { uid, netnsPath: `/var/run/netns/${netns(id)}`, chrootBaseDir: options.chrootBase, firecrackerPath }));
      const socket = join(root, "run", "firecracker.socket");
      for (let i = 0; ; i++) {
        if (await access(socket).then(() => true, () => false)) return;
        if (i >= 50) throw new Error(`Firecracker API socket of ${id} did not appear`);
        await sleep(100);
      }
    },

    async keepSnapshotAndStop(cell) {
      const id = cellId(cell.tenantId), dir = cellDir(id);
      for (const file of ["snap.mem", "snap.vmstate"]) await rename(join(jailRoot(id), file), join(dir, file));
      await stopJail(id);
      return (await bytes(join(dir, "snap.mem"))) + (await bytes(join(dir, "snap.vmstate")));
    },

    async waitReady(cell) {
      const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
      for (;;) {
        try { if ((await agent(cell, { op: "ping" })).ok) return; } catch (error) {
          if (Date.now() >= deadline) throw new Error(`space-vm-agent of ${cellId(cell.tenantId)} did not answer: ${(error as Error).message}`, { cause: error });
        }
        await sleep(100);
      }
    },

    async syncClock(cell, epochMs) {
      const reply = await agent(cell, { op: "set-time", epochMs });
      if (!reply.ok) throw new Error(`set-time failed: ${reply.error}`);
    },

    async upload(cell) {
      const id = cellId(cell.tenantId), dir = cellDir(id), cold = join(options.coldDir, id);
      await mkdir(cold, { recursive: true });
      for (const file of ["snap.mem", "snap.vmstate", "user.ext4"]) await copyFile(join(dir, file), join(cold, file));
      for (const file of ["snap.mem", "snap.vmstate", "user.ext4"]) await rm(join(dir, file), { force: true });
      return { objectKey: id };
    },

    async download(cell, objectKey) {
      if (!COLD_KEY.test(objectKey)) throw new Error("Not a cold snapshot key.");
      const dir = cellDir(cellId(cell.tenantId)), cold = join(options.coldDir, objectKey);
      await mkdir(dir, { recursive: true });
      for (const file of ["snap.mem", "snap.vmstate", "user.ext4"]) await copyFile(join(cold, file), join(dir, file));
      await rm(cold, { recursive: true, force: true });
    },

    async exportUserData(tenantId, where) {
      const id = cellId(tenantId);
      const from = where.objectKey ? join(options.coldDir, where.objectKey, "user.ext4") : join(cellDir(id), "user.ext4");
      if (where.objectKey && !COLD_KEY.test(where.objectKey)) throw new Error("Not a cold snapshot key.");
      await mkdir(join(options.exportDir, id), { recursive: true });
      await copyFile(from, join(options.exportDir, id, "user.ext4"));
      return { exportKey: `${id}/user.ext4` };
    },

    async destroy(tenantId, where) {
      const id = cellId(tenantId);
      await stopJail(id);
      await rm(cellDir(id), { recursive: true, force: true });
      if (where.objectKey) {
        if (!COLD_KEY.test(where.objectKey)) throw new Error("Not a cold snapshot key.");
        await rm(join(options.coldDir, where.objectKey), { recursive: true, force: true });
      }
    }
  };
}
