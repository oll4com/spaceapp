import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CELL_NETNS_RULESET, cellEgressRuleset, createCellHost } from "../src/computer/cell-host.js";
import { cellId } from "../src/computer/firecracker-cell-driver.js";

// chown to a cell's uid needs root; the commands are what these tests check.
vi.mock("node:fs/promises", async (actual) => ({ ...(await actual<typeof import("node:fs/promises")>()), chown: async () => undefined }));

const cell = { tenantId: "tenant:abc", hostId: "cells-1", memMib: 1024 };
const id = cellId(cell.tenantId);

describe("cell host", () => {
  let dir: string;
  const cmds: string[] = [];
  const opts = () => ({ root: join(dir, "root"), chrootBase: join(dir, "jail"), coldDir: join(dir, "cold"), exportDir: join(dir, "export") });
  beforeAll(async () => {
    dir = await mkdtemp("/tmp/ch-"); // a unix socket path is limited to 107 characters, so not the long tmpdir()
    await mkdir(join(dir, "root", "images"), { recursive: true });
    await writeFile(join(dir, "root", "images", "vmlinux"), "k");
    await writeFile(join(dir, "root", "images", "rootfs.ext4"), "r");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("keeps and moves a cell's files, and refuses a bad cold key", async () => {
    const cdir = join(dir, "root", "cells", id);
    await mkdir(cdir, { recursive: true });
    await Promise.all(["snap.mem", "snap.vmstate", "user.ext4"].map((f) => writeFile(join(cdir, f), f)));
    const host = createCellHost({ ...opts(), run: async (cmd, args) => void cmds.push([cmd, ...args].join(" ")) });
    expect(await host.upload(cell)).toEqual({ objectKey: id });
    expect(existsSync(join(cdir, "snap.mem"))).toBe(false);
    await host.exportUserData(cell.tenantId, { hostId: null, objectKey: id });
    expect(await readFile(join(dir, "export", id, "user.ext4"), "utf8")).toBe("user.ext4");
    await host.download(cell, id);
    expect(existsSync(join(cdir, "snap.mem"))).toBe(true);
    await expect(host.download(cell, "../etc")).rejects.toThrow("Not a cold snapshot key");
    await host.destroy(cell.tenantId, { hostId: "cells-1", objectKey: null });
    expect(existsSync(cdir)).toBe(false);
    expect(cmds).toContain(`ip netns del nc-${id}`);
  });

  it("gives the tap its address, closes the netns and starts the cell's proxy before the jailer", async () => {
    const all: string[] = [];
    const host = createCellHost({ ...opts(), jailerPath: "jailer", hubSubnets: ["95.111.197.127/32"], egressBytesPerSecond: 12_500_000, run: async (cmd, args) => {
      all.push([cmd, ...args].join(" "));
      if (cmd === "jailer") await mkdir(join(dir, "jail", "firecracker", id, "root", "run"), { recursive: true }).then(() => writeFile(join(dir, "jail", "firecracker", id, "root", "run", "firecracker.socket"), ""));
    } });
    await mkdir(join(dir, "root", "cells", id), { recursive: true });
    await writeFile(join(dir, "root", "cells", id, "user.ext4"), "u");
    await host.startJail(cell, "boot");
    const ns = `nc-${id}`, run = all.slice(all.indexOf(`ip netns add ${ns}`));
    expect(run.slice(0, 6).map((c) => c.split(" ").slice(0, 4).join(" "))).toEqual([
      `ip netns add ${ns}`, `ip -n ${ns} tuntap`, `ip -n ${ns} addr`, `ip -n ${ns} link`, `ip netns exec ${ns}`, `python3 -I /usr/local/lib/space-cell-runner/space-cell-proxy.py --netns`,
    ]);
    expect(run[2]).toContain("172.16.0.1/30 dev tap0");
    expect(run[5]).toContain(`--netns ${ns} --listen 172.16.0.1:3128`);
    expect(run[5]).toContain("--deny 95.111.197.127/32 --rate 12500000");
    expect(run[6]).toMatch(/jailer/);
    expect(CELL_NETNS_RULESET).toMatch(/input .*policy drop.*tcp dport 3128 accept/);
    expect(CELL_NETNS_RULESET).toMatch(/forward .*policy drop/);
  });

  it("gives a cell whose uid slot is taken the next free uid, keeps it across starts and frees it on destroy", async () => {
    const other = { ...cell, tenantId: "tenant:collides" }, oid = cellId(other.tenantId), taps: string[] = [];
    const host = createCellHost({ ...opts(), jailerPath: "jailer", run: async (cmd, args) => {
      if (args.includes("tuntap")) taps.push(args.at(-1)!);
      if (cmd === "jailer") await mkdir(join(dir, "jail", "firecracker", oid, "root", "run"), { recursive: true }).then(() => writeFile(join(dir, "jail", "firecracker", oid, "root", "run", "firecracker.socket"), ""));
    } });
    const slot = 10_000 + (Number.parseInt(createHash("sha256").update(oid).digest("hex").slice(0, 8), 16) % 50_000);
    const claims = join(dir, "root", "uids");
    await mkdir(claims, { recursive: true });
    await writeFile(join(claims, String(slot)), "someone-else");
    await mkdir(join(dir, "root", "cells", oid), { recursive: true });
    await writeFile(join(dir, "root", "cells", oid, "user.ext4"), "u");
    await host.startJail(other, "boot");
    await host.startJail(other, "boot");
    const uid = 10_000 + ((slot - 10_000 + 1) % 50_000);
    expect(taps).toEqual([String(uid), String(uid)]);
    expect(await readFile(join(claims, String(uid)), "utf8")).toBe(oid);
    await host.destroy(other.tenantId, { hostId: "cells-1", objectKey: null });
    expect(existsSync(join(claims, String(uid)))).toBe(false);
    expect(await readFile(join(claims, String(slot)), "utf8")).toBe("someone-else");
  });

  // REV1128-009: a cell cooled on host A that wakes on host B is destroyed only on B, so going cold leaves nothing of it on A.
  it("keeps nothing of a cooled cell on its host (uid claim, uid file, egress logs) and frees a claim a crash left without its uid file", async () => {
    const tenant = { ...cell, tenantId: "tenant:cools" }, cid = cellId(tenant.tenantId);
    const cdir = join(dir, "root", "cells", cid), claims = join(dir, "root", "uids");
    await mkdir(cdir, { recursive: true });
    await mkdir(claims, { recursive: true });
    await Promise.all(["snap.mem", "snap.vmstate", "user.ext4", "egress.log", "egress.log.1.gz"].map((f) => writeFile(join(cdir, f), f)));
    await writeFile(join(cdir, "uid"), "12345");
    await writeFile(join(claims, "12345"), cid);
    await writeFile(join(claims, "12346"), "someone-else");
    const host = createCellHost({ ...opts(), run: async () => undefined });
    expect(await host.upload(tenant)).toEqual({ objectKey: cid });
    expect(existsSync(cdir)).toBe(false);
    expect(existsSync(join(claims, "12345"))).toBe(false);
    expect(await readFile(join(dir, "cold", cid, "user.ext4"), "utf8")).toBe("user.ext4");
    expect(await readFile(join(claims, "12346"), "utf8")).toBe("someone-else");
    // A crash between the exclusive claim and the uid file: destroy still frees it.
    await writeFile(join(claims, "12347"), cid);
    await host.destroy(tenant.tenantId, { hostId: null, objectKey: cid });
    expect(existsSync(join(claims, "12347"))).toBe(false);
    expect(existsSync(join(dir, "cold", cid))).toBe(false);
  });

  it("denies private ranges, metadata, the hub and mail; allows only 80/443 out; refuses a bad subnet", () => {
    const rules = cellEgressRuleset(["95.111.197.127/32"]);
    for (const net of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "95.111.197.127/32"]) expect(rules).toContain(net);
    const chain = rules.slice(rules.indexOf("chain cell_proxy"));
    expect(chain.indexOf("@deny")).toBeLessThan(chain.indexOf("dport { 80, 443 } accept"));
    expect(chain).toContain("tcp dport { 25, 465, 587 } counter drop");
    expect(chain).toMatch(/dport \{ 80, 443 \} accept\n\s+counter drop\n\s+\}/);
    expect(() => cellEgressRuleset(["1.2.3.4/32; flush ruleset"])).toThrow("Not an IPv4 CIDR");
  });

  it("talks to the agent through Firecracker's vsock proxy (CONNECT, then JSON lines)", async () => {
    const host = createCellHost({ ...opts(), run: async () => undefined });
    const sock = join(dir, "jail", "firecracker", id, "root", "v.sock");
    await mkdir(join(dir, "jail", "firecracker", id, "root"), { recursive: true });
    const seen: string[] = [];
    const server = createServer((c) => {
      let buf = "";
      c.on("data", (d) => {
        buf += d;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          seen.push(line);
          c.write(line.startsWith("CONNECT") ? "OK 1073741824\n" : `${JSON.stringify({ ok: true })}\n`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(sock, r));
    await host.waitReady(cell);
    await host.syncClock(cell, 1_800_000_000_000);
    server.close();
    expect(seen).toEqual(["CONNECT 5252", '{"op":"ping"}', "CONNECT 5252", '{"op":"set-time","epochMs":1800000000000}']);
  });
});

// The public export ships neither script (cells run only on the operator's hosts): there the two socket tests have nothing to start.
const VM_AGENT = join(__dirname, "../../../deploy/space-vm-agent/space-vm-agent.py");
const CELL_PROXY = join(__dirname, "../../../deploy/space-cell-runner/space-cell-proxy.py");

describe("space-vm-agent", () => {
  it.skipIf(!existsSync(VM_AGENT))("answers ping, exec and bad input over its socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vm-agent-"));
    const path = join(dir, "a.sock");
    const proc = spawn("python3", ["-I", "-B", VM_AGENT, "--unix", path, "--relay", "0"]);
    await new Promise((r) => proc.stdout.once("data", r));
    const ask = (req: string) => new Promise<Record<string, unknown>>((resolve) => {
      const c = connect(path, () => c.write(`${req}\n`));
      c.once("data", (d) => (c.end(), resolve(JSON.parse(String(d)))));
    });
    try {
      expect(await ask('{"op":"ping"}')).toMatchObject({ ok: true, agent: "space-vm-agent" });
      expect(await ask('{"op":"exec","argv":["echo","hi"]}')).toMatchObject({ ok: true, code: 0, stdout: "hi\n" });
      expect(await ask('{"op":"exec","argv":[]}')).toMatchObject({ ok: false });
      expect(await ask("not json")).toMatchObject({ ok: false });
      // A timeout and a hung-up caller both kill the exec's whole process group (the CLI and what it started).
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const child = (n: string) => `sleep 30 & echo $! > ${join(dir, n)}; wait`;
      expect(await ask(JSON.stringify({ op: "exec", argv: ["sh", "-c", child("t")], timeoutS: 1 }))).toMatchObject({ ok: false });
      expect(alive(Number(await readFile(join(dir, "t"), "utf8")))).toBe(false);
      const c = connect(path, () => c.write(`${JSON.stringify({ op: "exec", argv: ["sh", "-c", child("h")], timeoutS: 60 })}\n`));
      await vi.waitFor(() => expect(existsSync(join(dir, "h"))).toBe(true));
      const pid = Number(await readFile(join(dir, "h"), "utf8"));
      expect(alive(pid)).toBe(true);
      c.destroy();
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 4000 });
    } finally {
      proc.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("space-cell-proxy", () => {
  it.skipIf(!existsSync(CELL_PROXY))("refuses private, metadata, hub, non-web ports and bad requests, and logs each one", async () => {
    const log = join(await mkdtemp(join(tmpdir(), "cell-proxy-")), "egress.log");
    const proc = spawn("python3", ["-I", CELL_PROXY, "--listen", "127.0.0.1:0", "--deny", "95.111.197.127/32", "--log", log]);
    const port = Number((await new Promise<string>((r) => proc.stdout.once("data", (d) => r(String(d))))).split(" ")[1]);
    const ask = (req: string) => new Promise<string>((resolve) => {
      const c = connect(port, "127.0.0.1", () => c.write(`${req}\r\nHost: x\r\n\r\n`));
      let out = "";
      c.on("data", (d) => (out += d)).on("close", () => resolve(out.split("\r\n")[0]));
    });
    try {
      for (const req of ["CONNECT 127.0.0.1:443", "CONNECT 169.254.169.254:80", "CONNECT 10.0.0.1:443", "CONNECT 172.16.0.1:443", "CONNECT 1.1.1.1:25",
        "CONNECT 1.1.1.1:587", "CONNECT 1.1.1.1:22", "CONNECT 95.111.197.127:443", "GET http://192.168.1.1/"]) {
        expect(await ask(`${req} HTTP/1.1`), req).toBe("HTTP/1.1 403 Forbidden");
      }
      expect(await ask("garbage")).toBe("HTTP/1.1 400 Bad Request");
      expect(await ask("GET /x HTTP/1.1")).toBe("HTTP/1.1 400 Bad Request");
      const lines = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toHaveLength(11);
      expect(lines[1]).toMatchObject({ method: "CONNECT", host: "169.254.169.254", port: 80, ip: null, status: 403, up: 0, down: 0 });
      expect(lines.at(-1)).toMatchObject({ method: "GET", host: null, status: 400 });
    } finally {
      proc.kill();
    }
  });

  it.skipIf(!existsSync(CELL_PROXY))("--rate holds the cell to its bytes a second after one second of burst, across takers", () => {
    // 200 kB burst free, then 2 x 100 kB at 200 kB/s from two threads: about 1 s in all.
    const code = `import importlib.util, sys, threading, time
spec = importlib.util.spec_from_file_location("p", sys.argv[1]); p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
b = p.Bucket(200_000); t = time.monotonic(); b.take(200_000)
ts = [threading.Thread(target=b.take, args=(100_000,)) for _ in range(2)]; [x.start() for x in ts]; [x.join() for x in ts]
print(round(time.monotonic() - t, 2))`;
    const took = Number(execFileSync("python3", ["-I", "-B", "-c", code, CELL_PROXY], { encoding: "utf8" }));
    expect(took).toBeGreaterThan(0.9);
    expect(took).toBeLessThan(1.6);
  });
});
