import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectStoragePlan, storageChecks } from "../src/storage.mjs";

const GiB = 1024 ** 3;
const resources = { cpuCount: 8, totalMemoryBytes: 16 * GiB, freeDiskBytes: 30 * GiB };
const info = { host: { arch: "arm64", cpus: 4, memTotal: 8 * GiB, cgroupVersion: "v2",
  cgroupControllers: ["cpu", "memory"], security: { rootless: true }, serviceIsRemote: false },
version: { Version: "5.0.0" }, store: { graphRoot: "/var/home/core/.local/share/containers/storage", graphRootAllocated: 20 * GiB, graphRootUsed: 10 * GiB } };

async function inspect(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const execute = async (spec, io) => {
    calls.push(spec);
    const args = spec.args;
    if (args[0] === "info") io.stdout.write(JSON.stringify(options.info ?? info));
    else if (args[0] === "version") io.stdout.write(JSON.stringify({ Client: { Version: "5.0.0" }, Server: { Version: "5.0.0" } }));
    else if (args.join(" ") === "compose version") io.stdout.write("Docker Compose version v2.24.4");
    else if (args.join(" ") === "compose up --help") io.stdout.write("--wait --wait-timeout");
    else if (args.join(" ") === "compose ls --format json") io.stdout.write("[]");
    else if (args.join(" ") === "machine list --format json") io.stdout.write(JSON.stringify([
      { Name: "spaceapp-vm", Default: true, Running: true, CPUs: 4, Memory: String(8 * GiB), DiskSize: String(20 * GiB), VMType: "qemu" }
    ]));
    else if (args[0] === "machine" && args[1] === "ssh") {
      assert.deepEqual(args, ["machine", "ssh", "spaceapp-vm", "df", "-Pk", "--", "/var/home/core/.local/share/containers/storage"]);
      io.stdout.write(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 20971520 10485760 ${options.availableKiB ?? "10485760"} 50% /`);
    }
    else if (args[0] === "image") {
      if (args.includes("{{json .RootFS.Layers}}")) io.stdout.write(JSON.stringify(["sha256:" + "b".repeat(64)]));
      else if (options.cached !== false) io.stdout.write(options.imageId ?? "a".repeat(64));
      else return 1;
    } else if (args.includes("SELECT pg_database_size(current_database())")) io.stdout.write("10485760");
    else if (args.includes("storageFree")) io.stdout.write("10737418240");
    else if (args.some(arg => arg.includes("statfsSync"))) io.stdout.write(options.volumeFree ?? "10737418240");
    else assert.fail(`Unexpected storage command: ${args.join(" ")}`);
    return 0;
  };
  const config = { engine: "podman", profile: "small", version: "1.1.6" };
  const plan = await inspectStoragePlan({ root, config, resources, execute, operation: "fresh", platform: "darwin", fetch: null, ...options.plan });
  return { plan, calls };
}

test("Podman storage recognizes cached bare image IDs and uses the selected engine", async t => {
  const { plan, calls } = await inspect(t);
  assert.deepEqual(plan.missingImages, []);
  assert.equal(plan.missingImageBytes, 0);
  assert.equal(calls.every(spec => spec.command === "podman"), true);
  assert.equal(plan.engine, "podman");
  assert.equal(plan.engineFreeDiskBytes, 10 * GiB);
  assert.equal(plan.resources.freeDiskBytes, 10 * GiB);
  assert.equal(plan.resources.engineCpuCount, 4);
  assert.equal(plan.resources.engineMemoryBytes, 8 * GiB);
  assert.equal(plan.resources.totalMemoryBytes, resources.totalMemoryBytes);
  assert.equal(storageChecks(plan, resources).every(check => check.ok), true);
  assert.equal(storageChecks(plan, resources).at(-1).name, "Podman storage");
});

test("zero Podman disk never falls back to the host's free space", async t => {
  const { plan } = await inspect(t, { availableKiB: "0" });
  assert.equal(plan.engineFreeDiskBytes, 0);
  assert.equal(plan.resources.freeDiskBytes, 0);
  assert.equal(storageChecks(plan, resources).at(-1).ok, false);
});

test("unknown macOS guest disk fails closed instead of using allocated VM capacity", async t => {
  const { plan } = await inspect(t, { info: { ...info, store: {} }, plan: { platform: "darwin" } });
  assert.equal(plan.engineFreeDiskBytes, null);
  assert.equal(storageChecks(plan, resources).at(-1).ok, false);
  assert.match(storageChecks(plan, resources).at(-1).detail, /unavailable|unknown/i);
});

test("invalid short image IDs retain conservative reserves", async t => {
  const { plan } = await inspect(t, { imageId: "abcdef" });
  assert.equal(plan.missingImages.length, 3);
  assert.ok(plan.missingImageBytes > 5 * GiB);
});

test("Podman checkpoints and cached layer probes stay on the selected engine", async t => {
  const { plan, calls } = await inspect(t, { plan: { operation: "upgrade", existingConfig: { engine: "podman", profile: "small", version: "1.1.5" } } });
  assert.equal(plan.databaseSizeKnown, true);
  assert.ok(plan.checkpointBytes >= 64 * 1024 ** 2);
  assert.equal(calls.every(spec => spec.command === "podman"), true);
  assert.equal(calls.some(spec => spec.args.includes("{{json .RootFS.Layers}}")), true);
});

test("a writable runtime volume cannot stand in for unknown image-store free space", async t => {
  const { plan } = await inspect(t, { info: { ...info, store: {} }, plan: { operation: "upgrade", platform: "darwin",
    existingConfig: { engine: "podman", profile: "small", version: "1.1.5" } } });
  assert.equal(plan.engineFreeDiskBytes, null);
  assert.equal(storageChecks(plan, resources).at(-1).ok, false);
});
