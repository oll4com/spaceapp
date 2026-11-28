import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCellHost } from "../src/computer/cell-host.js";
import { cellId } from "../src/computer/firecracker-cell-driver.js";

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

// The public export ships no vm agent (cells run only on the operator's hosts): there the socket test has nothing to start.
const VM_AGENT = join(__dirname, "../../../deploy/space-vm-agent/space-vm-agent.py");

describe("space-vm-agent", () => {
  it.skipIf(!existsSync(VM_AGENT))("answers ping, exec and bad input over its socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vm-agent-"));
    const path = join(dir, "a.sock");
    const proc = spawn("python3", ["-I", VM_AGENT, "--unix", path]);
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
    } finally {
      proc.kill();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
