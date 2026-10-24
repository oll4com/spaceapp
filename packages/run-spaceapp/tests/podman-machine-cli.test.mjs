import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { run } from "../src/cli.mjs";
import { initializeInstallation, loadConfig } from "../src/index.mjs";

const GiB = 1024 ** 3;
async function machineFixture(t, { freeDiskGiB = 80 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-machine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  const options = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" }, platform: "darwin",
    stdin: Readable.from([]), stdout: sink, stderr: sink,
    prepareDockerPath: async () => {},
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * GiB, freeDiskBytes: 40 * GiB }),
    sleep: async () => {},
    request: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, setupRequired: false, expiresAt: null }) }),
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.command === "docker") return 127;
      let text = "";
      if (spec.args[0] === "--version") text = "podman version 5.4.2";
      else if (spec.args[0] === "info") text = JSON.stringify({
        version: { Version: "5.4.2" },
        host: { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory"], cpus: 4, memTotal: 4 * GiB },
        store: { graphRootAllocated: 100 * GiB, graphRootUsed: (100 - freeDiskGiB) * GiB }
      });
      else if (spec.args[0] === "compose" && spec.args[1] === "version") text = "2.29.2";
      else if (spec.args[0] === "machine" && spec.args[1] === "info") text = JSON.stringify({ Host: { DefaultMachine: "spaceapp-machine" } });
      else if (spec.args[0] === "machine" && spec.args[1] === "inspect") text = JSON.stringify([
        { Name: "spaceapp-machine", State: "running", Rootful: false, Resources: { CPUs: 4, Memory: 4096, DiskSize: 100 } }
      ]);
      else if (spec.args[0] === "image") return 1;
      io?.stdout?.write(text);
      return 0;
    }
  };
  return { root, options, calls, output: () => output };
}

test("macOS auto profile considers the machine before rejecting host-selected large limits", async (t) => {
  const f = await machineFixture(t);
  const code = await run(["install", "--engine", "podman", "--profile", "auto", "--non-interactive", "--answers", '{"confirm":true,"open":false}'], f.options);
  assert.equal(code, 0, f.output());
  assert.equal((await loadConfig(f.root)).profile, "small");
  assert.match(f.output(), /Podman resources select profile: small/);
  assert.ok(f.calls.some((spec) => spec.args.includes("up")));
  assert.ok(f.calls.every((spec) => spec.command === "podman"));
});

test("macOS doctor checks maintenance headroom on an already installed machine", async (t) => {
  const f = await machineFixture(t, { freeDiskGiB: 2 });
  await initializeInstallation(f.root, { engine: "podman", version: "1.1.7", profile: "small" });
  assert.equal(await run(["doctor"], f.options), 0, f.output());
  assert.match(f.output(), /PASS Podman machine disk: 2\.0 GiB free; 0\.5 GiB required/);
});
