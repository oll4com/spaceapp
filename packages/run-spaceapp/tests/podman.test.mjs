import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  addUser,
  addWorkspace,
  composeCommand,
  createDefaultConfig,
  initializeInstallation,
  prepareInstallation,
  renderWorkspaceCompose,
  resolveInstallEngine,
  validateConfig
} from "../src/index.mjs";
import { inspectStoragePlan } from "../src/storage.mjs";
import { run } from "../src/cli.mjs";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

test("resolveInstallEngine defaults to docker and validates docker|podman", () => {
  assert.equal(resolveInstallEngine(undefined), "docker");
  assert.equal(resolveInstallEngine(undefined, "podman"), "podman");
  assert.equal(resolveInstallEngine("docker", "podman"), "docker");
  assert.equal(resolveInstallEngine("podman", "docker"), "podman");
  assert.throws(() => resolveInstallEngine("nerdctl"), /docker or podman/i);
});

test("composeCommand dispatches to podman when engine is podman and stays docker by default", () => {
  const root = tmpdir();
  const dockerSpec = composeCommand("up", root, { profile: "small" });
  assert.equal(dockerSpec.command, "docker");
  assert.equal(dockerSpec.args[0], "compose");

  const podmanSpec = composeCommand("up", root, { profile: "small", engine: "podman" });
  assert.equal(podmanSpec.command, "podman");
  assert.equal(podmanSpec.args[0], "compose");
  assert.ok(podmanSpec.args.includes("up"));

  const backupSpec = composeCommand("backup", root, { profile: "medium", engine: "podman" });
  assert.equal(backupSpec.command, "podman");
  assert.ok(backupSpec.args.includes("scripts/portable-backup.mjs"));
});

test("Podman workspace compose adds SELinux relabeling and rootless keep-id userns_mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-ws-"));
  const wsDir = join(root, "repo");
  await mkdir(wsDir, { recursive: true });

  const podmanConfig = await addWorkspace(
    createDefaultConfig({ version: "1.1.7", profile: "small", engine: "podman" }),
    wsDir
  );
  const compose = renderWorkspaceCompose(podmanConfig);
  assert.match(compose, /userns_mode: "keep-id:uid=10001,gid=10001"/);
  assert.match(compose, /selinux: z/);
});

test("host-root access is refused on Podman with a clear error", () => {
  assert.throws(
    () => createDefaultConfig({ version: "1.1.7", accessMode: "host-root", engine: "podman" }),
    /not supported on Podman/i
  );
  const invalid = {
    ...createDefaultConfig({ version: "1.1.7", engine: "podman" }),
    accessMode: "host-root"
  };
  assert.throws(() => validateConfig(invalid), /not supported on Podman/i);
});

test("switching engines on an existing installation is refused to protect existing volumes", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  await initializeInstallation(root, { version: "1.1.7", profile: "small", engine: "docker" });
  await assert.rejects(
    () => prepareInstallation(root, { version: "1.1.7", profile: "small", engine: "podman" }),
    /Cannot switch container engine from docker to podman/i
  );
});

test("multi-user Podman workspace compose includes keep-id userns_mode and SELinux z on per-user mounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-multiuser-"));
  const wsDir = join(root, "user-repo");
  await mkdir(wsDir, { recursive: true });

  let config = addUser(createDefaultConfig({ version: "1.1.7", profile: "small", engine: "podman" }), "user:alice");
  config = await addWorkspace(config, wsDir, { userId: "user:alice" });

  const compose = renderWorkspaceCompose(config);
  const matches = compose.match(/userns_mode: "keep-id:uid=10001,gid=10001"/g) ?? [];
  assert.equal(matches.length, 3);
  assert.match(compose, /selinux: z/);
});

test("inspectStoragePlan probes podman info and podman image inspect when engine is podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-storage-"));
  const commands = [];
  const execute = async (spec, io) => {
    commands.push(spec.command);
    if (spec.args[0] === "info") {
      io.stdout.write(JSON.stringify({
        host: { arch: "amd64", cpus: 8, memTotal: 16 * 1024 ** 3 },
        store: { graphRoot: root }
      }));
      return 0;
    }
    if (spec.args[0] === "image" && spec.args[1] === "inspect") {
      io.stdout.write("sha256:" + "a".repeat(64));
      return 0;
    }
    return 0;
  };
  const config = createDefaultConfig({ version: "1.1.7", profile: "small", engine: "podman" });
  const plan = await inspectStoragePlan({
    root,
    config,
    resources: { cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 },
    execute,
    operation: "fresh",
    fetch: null
  });
  assert.ok(commands.every((cmd) => cmd === "podman"));
  assert.equal(plan.resources.engineCpuCount, 8);
  assert.equal(plan.resources.engineMemoryBytes, 16 * 1024 ** 3);
});

test("install --engine podman saves engine in config and subsequent lifecycle commands use podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-cli-"));
  const executed = [];
  const stdout = capture();
  const stderr = capture();

  const code = await run(
    ["install", "--engine", "podman", "--profile", "small", "--no-open", "--non-interactive", "--answers", '{"confirm":true}'],
    {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdin: Readable.from([]),
      stdout: stdout.stream,
      stderr: stderr.stream,
      inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 25 * 1024 ** 3 }),
      prepareDockerPath: async () => null,
      request: async (url) => ({
        ok: true,
        json: async () => (url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null })
      }),
      sleep: async () => {},
      execute: async (spec) => {
        executed.push(spec);
        return 0;
      }
    }
  );
  assert.equal(code, 0);
  const saved = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(saved.engine, "podman");
  assert.ok(executed.some((spec) => spec.command === "podman" && spec.args.includes("up")));

  executed.length = 0;
  assert.equal(await run(["status"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    prepareDockerPath: async () => null,
    execute: async (spec) => {
      executed.push(spec);
      return 0;
    }
  }), 0);
  assert.equal(executed[0].command, "podman");
  assert.ok(executed[0].args.includes("ps"));
});
