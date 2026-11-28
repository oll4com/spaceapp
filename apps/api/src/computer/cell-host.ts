import { execFile } from "../safe-child-process.js";
import { createHash, randomBytes } from "node:crypto";
import { access, chown, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CellRef, CellTurnRequest } from "./cell-driver.js";
import { createCellRelays, RELAY_MODEL_PREFIX, RELAY_VSOCK_PORT } from "./cell-relay.js";
import { childProcessEnv } from "../child-process-env.js";
import { CELL_NET, cellId, cellJailerArgs, type CellHostPort } from "./firecracker-cell-driver.js";

// Step 20: the real CellHostPort, run as root on the cells host (nc-cells on pve-az; K3 lab layout: base images, jail and cells on one
// filesystem so a hard link shares one inode). Snapshots go cold to a plain directory (pve-az vmcold); no bucket is bought.
// Step 7 network: a cell's netns holds only tap0 (CELL_NET) and the listening socket of its own space-cell-proxy; nothing routes. The
// proxy connects out from the host's netns as the cell's uid, where cellEgressRuleset() is the only way out (runner start applies it).
// shortcut: no per-cell connection or new-domain limits yet (plan §6.4); add them before the beta opens.

export const AGENT_VSOCK_PORT = 5252;
const exec = promisify(execFile);
export type Run = (cmd: string, args: string[]) => Promise<void>;
export const defaultRun: Run = async (cmd, args) => void (await exec(cmd, args, { env: childProcessEnv() }));
// Cold copies keep holes: a mostly empty user disk and the ballooned-out memory pages are not written to (or read back from) vmcold.
const sparseCopy = async (from: string, to: string) => void (await exec("cp", ["--sparse=always", from, to], { env: childProcessEnv() }));
const COLD_KEY = /^c-[0-9a-f]{24}$/;
/** Every cell runs as its own uid in this range; the host's egress rules match the range. */
export const CELL_UID_MIN = 10_000;
export const CELL_UID_SLOTS = 50_000;

/** Inside a cell's netns: the guest reaches only its proxy's port; nothing is forwarded. */
export const CELL_NETNS_RULESET = `table inet cell {
  chain input { type filter hook input priority filter; policy drop; ct state established,related accept; iifname "lo" accept; iifname "tap0" ip daddr ${CELL_NET.hostIp} tcp dport ${CELL_NET.proxyPort} accept; }
  chain forward { type filter hook forward priority filter; policy drop; }
}`;

/** Never reachable from a cell (plan §9): this-network, RFC1918, CGNAT, loopback, link-local with 169.254.169.254, multicast and reserved. */
export const CELL_DENY_V4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/3"];
const CIDR_V4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/([0-9]|[12]\d|3[0-2])$/;

/** The host's rules for the proxies' own connections (matched by the cells' uids): deny by default, DNS only to the host's resolver,
 *  never the denied ranges or the hub's subnets, SMTP closed, only TCP 80/443 out, and no routing through the host at all. */
export function cellEgressRuleset(hubSubnets: string[]): string {
  for (const net of hubSubnets) if (!CIDR_V4.test(net)) throw new Error(`Not an IPv4 CIDR: ${net}`);
  return `table inet space_cells
delete table inet space_cells
table inet space_cells {
  set deny { type ipv4_addr; flags interval; auto-merge; elements = { ${[...CELL_DENY_V4, ...hubSubnets].join(", ")} }; }
  chain output { type filter hook output priority filter; policy accept; meta skuid ${CELL_UID_MIN}-${CELL_UID_MIN + CELL_UID_SLOTS - 1} jump cell_proxy; }
  chain cell_proxy {
    ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept comment "DNS through the host's resolver"
    ip daddr @deny counter drop
    tcp dport { 25, 465, 587 } counter drop comment "no mail out"
    meta nfproto ipv4 tcp dport { 80, 443 } accept
    counter drop
  }
  chain forward { type filter hook forward priority filter; policy drop; }
}`;
}

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
  /** space-cell-proxy.py on the host; hubSubnets are refused by the proxy too (the host's nftables refuse them first). */
  proxyPath?: string;
  hubSubnets?: string[];
  /** The cell's egress rate in bytes a second, both directions together (space-cell-proxy --rate); unset = no limit. */
  egressBytesPerSecond?: number;
  run?: Run;
  readyTimeoutMs?: number;
  /** cell-runner.ts cellProof with the runner's token: the hub takes a turn's MCP calls only with the proof of the turn's cell. */
  proof?: (cellId: string) => string;
}

/** Where the guest reaches its relay: space-vm-agent forwards this port over vsock to <jail>/v.sock_5253. */
const RELAY_IN_GUEST = `http://127.0.0.1:${RELAY_VSOCK_PORT}`;
const TOOL_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** The guest's Claude Code command line for one turn (the same flags as the wrapper's agent tools); the prompt goes on stdin. */
export function cellTurnArgv(turn: CellTurnRequest): string[] {
  const tools = turn.shell ? "Bash ToolSearch" : "ToolSearch";
  const mcp = { mcpServers: { space_nous: { type: "http", url: `${RELAY_IN_GUEST}/api/cli/nous/mcp`, headers: { Authorization: `Bearer ${turn.mcpToken}` } } } };
  return [
    "/usr/local/bin/claude", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--tools", tools, "--allowedTools", `mcp__space_nous ${tools}`,
    "--print", "--max-turns", String(turn.maxTurns), "--output-format", "json", "--model", turn.model,
    ...(TOOL_EFFORTS.has(turn.effort) ? ["--effort", turn.effort] : []),
    ...(turn.fallbackModel ? ["--fallback-model", turn.fallbackModel] : []),
    ...(turn.system ? ["--append-system-prompt", turn.system] : [])
  ];
}

/** The turn's environment in the guest: the model is the relay, and the key it holds is only the turn's random handle. */
export const cellTurnEnv = (handle: string): Record<string, string> => ({
  ANTHROPIC_BASE_URL: `${RELAY_IN_GUEST}${RELAY_MODEL_PREFIX}`, ANTHROPIC_API_KEY: handle,
  NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1", HOME: "/work",
  ENABLE_TOOL_SEARCH: "true", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
});

export function createCellHost(options: CellHostOptions): CellHostPort {
  const run = options.run ?? defaultRun;
  const firecrackerPath = options.firecrackerPath ?? "/usr/local/bin/firecracker";
  const jailerPath = options.jailerPath ?? "/usr/local/bin/jailer";
  const jailBase = (id: string) => join(options.chrootBase, "firecracker", id);
  const jailRoot = (id: string) => join(jailBase(id), "root");
  const cellDir = (id: string) => join(options.root, "cells", id);
  const uidClaims = join(options.root, "uids");
  /** A cell's uid for its whole life, kept in its directory; claimed exclusively under <root>/uids so two cells never share one. */
  async function uidOf(id: string): Promise<number> {
    const kept = Number.parseInt(await readFile(join(cellDir(id), "uid"), "utf8").catch(() => ""), 10);
    if (kept >= CELL_UID_MIN) return kept;
    await mkdir(uidClaims, { recursive: true });
    const start = Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
    for (let i = 0; i < CELL_UID_SLOTS; i++) {
      const uid = CELL_UID_MIN + ((start + i) % CELL_UID_SLOTS), claim = join(uidClaims, String(uid));
      const ours = await writeFile(claim, id, { flag: "wx" }).then(() => true, async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        return (await readFile(claim, "utf8")) === id;
      });
      if (ours) {
        await writeFile(join(cellDir(id), "uid"), String(uid));
        return uid;
      }
    }
    throw new Error("No free cell uid on this host.");
  }
  /** REV1128-009: frees every claim naming this cell, including one a crash left between the claim and its uid file. */
  async function freeUid(id: string): Promise<void> {
    const claims = await readdir(uidClaims).catch(() => [] as string[]);
    await Promise.all(claims.map(async (uid) => {
      if (await readFile(join(uidClaims, uid), "utf8").catch(() => "") === id) await rm(join(uidClaims, uid), { force: true });
    }));
  }
  const proxyPath = options.proxyPath ?? "/usr/local/lib/space-cell-runner/space-cell-proxy.py";
  const netns = (id: string) => `nc-${id}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const relays = createCellRelays({ proof: options.proof ?? (() => { throw new Error("This cell host has no runner proof for turns."); }) });

  async function agent<T = object>(cell: CellRef, request: object, signal?: AbortSignal): Promise<{ ok: boolean; error?: string } & Partial<T>> {
    signal?.throwIfAborted();
    const socket = connect(join(jailRoot(cellId(cell.tenantId)), "v.sock"));
    return new Promise((resolve, reject) => {
      // Closing the vsock stream is the cancel: the guest agent kills the exec's process group when its caller hangs up.
      signal?.addEventListener("abort", () => (socket.destroy(), reject(signal.reason)), { once: true });
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

  /** Kills the cell's Firecracker and proxy if a jail exists and removes its jail, netns and cgroup; the cell's own directory stays. */
  async function stopJail(id: string): Promise<void> {
    await relays.drop(id);
    for (const file of [join(jailRoot(id), "firecracker.pid"), join(jailBase(id), "proxy.pid")]) {
      const pid = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
      if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    await run("ip", ["netns", "del", netns(id)]).catch(() => undefined);
    await rm(jailBase(id), { recursive: true, force: true });
    await rm(`/sys/fs/cgroup/firecracker/${id}`, { recursive: true, force: true }).catch(() => undefined);
  }

  const bytes = async (path: string) => (await stat(path)).size;

  return {
    socketPath: (cell) => join(jailRoot(cellId(cell.tenantId)), "run", "firecracker.socket"),

    async startJail(cell, mode) {
      const id = cellId(cell.tenantId), root = jailRoot(id), dir = cellDir(id);
      await mkdir(dir, { recursive: true });
      const uid = await uidOf(id);
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
      await run("ip", ["-n", netns(id), "addr", "add", `${CELL_NET.hostIp}/${CELL_NET.prefix}`, "dev", "tap0"]);
      // A fixed MAC: a restored guest still holds the old tap's MAC in its ARP cache, so a new random one loses its first connections.
      await run("ip", ["-n", netns(id), "link", "set", "tap0", "address", CELL_NET.hostMac, "up"]);
      await run("ip", ["netns", "exec", netns(id), "nft", CELL_NETNS_RULESET]);
      // Binds in the cell's netns, then returns after forking the proxy, which runs as the cell's uid.
      await run("python3", ["-I", proxyPath, "--netns", netns(id), "--listen", `${CELL_NET.hostIp}:${CELL_NET.proxyPort}`, "--uid", String(uid),
        "--pidfile", join(jailBase(id), "proxy.pid"), "--log", join(dir, "egress.log"), ...(options.hubSubnets ?? []).flatMap((net) => ["--deny", net]),
        ...(options.egressBytesPerSecond ? ["--rate", String(Math.floor(options.egressBytesPerSecond))] : [])]);
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

    async turn(cell, request, signal) {
      if (!options.proof) throw new Error("This cell host has no runner proof for turns.");
      const id = cellId(cell.tenantId), handle = `relay-${randomBytes(24).toString("base64url")}`;
      const close = await relays.open(id, join(jailRoot(id), `v.sock_${RELAY_VSOCK_PORT}`), await uidOf(id), { handle, mcpUrl: request.mcpUrl, mcpToken: request.mcpToken, upstream: request.upstream });
      try {
        const reply = await agent<{ code: number | null; stdout: string; stderr: string }>(cell, {
          op: "exec", argv: cellTurnArgv(request), input: request.prompt, env: cellTurnEnv(handle), cwd: "/work", timeoutS: Math.ceil(request.timeoutMs / 1000)
        }, signal);
        if (!reply.ok) throw new Error(`The cell's turn did not run: ${reply.error}`);
        return { code: reply.code ?? null, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
      } finally {
        await close();
      }
    },

    async upload(cell) {
      const id = cellId(cell.tenantId), dir = cellDir(id), cold = join(options.coldDir, id);
      await mkdir(cold, { recursive: true });
      for (const file of ["snap.mem", "snap.vmstate", "user.ext4"]) await sparseCopy(join(dir, file), join(cold, file));
      // REV1128-009: a cold cell may wake on another host and destroy reaches only that one, so this host keeps nothing of it (uid, egress logs).
      await rm(dir, { recursive: true, force: true });
      await freeUid(id);
      return { objectKey: id };
    },

    async download(cell, objectKey) {
      if (!COLD_KEY.test(objectKey)) throw new Error("Not a cold snapshot key.");
      const dir = cellDir(cellId(cell.tenantId)), cold = join(options.coldDir, objectKey);
      await mkdir(dir, { recursive: true });
      for (const file of ["snap.mem", "snap.vmstate", "user.ext4"]) await sparseCopy(join(cold, file), join(dir, file));
      await rm(cold, { recursive: true, force: true });
    },

    async exportUserData(tenantId, where) {
      const id = cellId(tenantId);
      const from = where.objectKey ? join(options.coldDir, where.objectKey, "user.ext4") : join(cellDir(id), "user.ext4");
      if (where.objectKey && !COLD_KEY.test(where.objectKey)) throw new Error("Not a cold snapshot key.");
      await mkdir(join(options.exportDir, id), { recursive: true });
      await sparseCopy(from, join(options.exportDir, id, "user.ext4"));
      return { exportKey: `${id}/user.ext4` };
    },

    async destroy(tenantId, where) {
      const id = cellId(tenantId);
      await stopJail(id);
      await freeUid(id);
      await rm(cellDir(id), { recursive: true, force: true });
      if (where.objectKey) {
        if (!COLD_KEY.test(where.objectKey)) throw new Error("Not a cold snapshot key.");
        await rm(join(options.coldDir, where.objectKey), { recursive: true, force: true });
      }
    }
  };
}
