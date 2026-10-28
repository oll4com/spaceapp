import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  addWorkspace,
  composeCommand,
  createDefaultConfig,
  loadConfig,
  prepareInstallation,
  renderWorkspaceCompose,
  resolveContainerEngine,
  saveConfig
} from "../src/index.mjs";

const launcherManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const RUNTIME_VERSION = launcherManifest.spaceappRuntimeVersion;

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

const eightGigabyteClassLinuxGuest = {
  cpuCount: 4,
  totalMemoryBytes: 7.4 * 1024 ** 3,
  freeDiskBytes: 25 * 1024 ** 3
};

async function readyUnclaimedRequest(url) {
  if (url.endsWith("/readyz")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    };
  }
  if (url.endsWith("/api/setup/status")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ setupRequired: true, expiresAt: "2026-10-28T23:59:59.000Z" })
    };
  }
  throw new Error(`Unexpected URL ${url}`);
}

test("resolveContainerEngine and composeCommand construct docker and podman invocations cleanly", () => {
  assert.equal(resolveContainerEngine(undefined), "docker");
  assert.equal(resolveContainerEngine("docker"), "docker");
  assert.equal(resolveContainerEngine("podman"), "podman");
  assert.equal(resolveContainerEngine(undefined, "podman"), "podman");
  assert.throws(() => resolveContainerEngine("nerdctl"), /Container engine must be docker or podman/);

  const dockerUp = composeCommand("up", "/opt/spaceapp", { profile: "small" });
  assert.equal(dockerUp.command, "docker");
  assert.equal(dockerUp.args[0], "compose");

  const podmanUp = composeCommand("up", "/opt/spaceapp", { profile: "small", engine: "podman" });
  assert.equal(podmanUp.command, "podman");
  assert.equal(podmanUp.args[0], "compose");
  assert.deepEqual(podmanUp.args, dockerUp.args);
});

test("renderWorkspaceCompose adds SELinux shared relabeling (:z) and keep-id userns_mode for rootless Podman", async () => {
  const wsDir = await mkdtemp(join(tmpdir(), "spaceapp-podman-ws-"));
  let config = createDefaultConfig({
    version: RUNTIME_VERSION,
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  config = await addWorkspace(config, wsDir, { readOnly: false });
  const yaml = renderWorkspaceCompose(config, { cliSandbox: false });

  assert.match(yaml, /userns_mode: "keep-id:uid=10001,gid=10001"/);
  assert.match(yaml, /selinux: z/);
});

test("--access host-root is refused on Podman with a clear message", async () => {
  assert.throws(
    () => createDefaultConfig({ version: RUNTIME_VERSION, profile: "small", accessMode: "host-root", engine: "podman" }),
    /Host-root access \(--access host-root\) is not supported on Podman/
  );

  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  await assert.rejects(
    run(
      [
        "install",
        "--engine",
        "podman",
        "--access",
        "host-root",
        "--non-interactive",
        "--answers",
        JSON.stringify({ confirm: true, profile: "small", access: "host-root", companions: false, telemetry: false, open: false })
      ],
      {
        env: { SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" },
        platform: "linux",
        stdout: capture().stream,
        stderr: capture().stream,
        inspectResources: async () => eightGigabyteClassLinuxGuest
      }
    ),
    /Host-root access \(--access host-root\) is not supported on Podman/
  );
});

test("switching engines on an existing installation is refused for data safety", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  await saveConfig(root, createDefaultConfig({ version: RUNTIME_VERSION, profile: "small", engine: "docker" }));

  await assert.rejects(
    prepareInstallation(root, { version: RUNTIME_VERSION, profile: "small", engine: "podman" }),
    /Cannot switch container engine from docker to podman on an existing installation/
  );

  await assert.rejects(
    run(
      [
        "install",
        "--engine",
        "podman",
        "--non-interactive",
        "--answers",
        JSON.stringify({ confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false })
      ],
      {
        env: { SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" },
        platform: "linux",
        stdout: capture().stream,
        stderr: capture().stream,
        inspectResources: async () => eightGigabyteClassLinuxGuest
      }
    ),
    /Cannot switch container engine from docker to podman on an existing installation/
  );
});

test("install --engine podman persists engine in config and runs lifecycle commands via podman compose", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];

  const execute = async (spec, io) => {
    calls.push(spec);
    if (spec.command === "podman" && spec.args[0] === "--version") {
      io?.stdout?.write("podman version 5.2.3\n");
      return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "info" && spec.args.includes("--format")) {
      io?.stdout?.write(
        JSON.stringify({
          version: { Version: "5.2.3" },
          host: {
            cpus: 4,
            memTotal: 8 * 1024 ** 3,
            arch: "amd64",
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"],
            security: { rootless: true }
          },
          store: { graphRoot: root }
        })
      );
      return 0;
    }
    if (spec.args?.includes("pg_dump")) {
      io?.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
      return 0;
    }
    return 0;
  };

  const installCode = await run(
    [
      "install",
      "--engine",
      "podman",
      "--profile",
      "small",
      "--no-open",
      "--non-interactive",
      "--answers",
      JSON.stringify({ confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false })
    ],
    {
      env: { SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" },
      platform: "linux",
      arch: "x64",
      stdout: stdout.stream,
      stderr: stderr.stream,
      execute,
      inspectResources: async () => eightGigabyteClassLinuxGuest,
      request: readyUnclaimedRequest,
      sleep: async () => {}
    }
  );

  assert.equal(installCode, 0);
  const saved = await loadConfig(root);
  assert.equal(saved.engine, "podman");
  assert.ok(calls.some((c) => c.command === "podman" && c.args.includes("compose") && c.args.includes("up")));
  assert.equal(calls.some((c) => c.command === "docker" && c.args.includes("compose")), false);

  // Subsequent doctor and status commands use Podman automatically from saved config
  const docOut = capture();
  const docErr = capture();
  const docCode = await run(["doctor"], {
    env: { SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" },
    platform: "linux",
    stdout: docOut.stream,
    stderr: docErr.stream,
    execute,
    inspectResources: async () => eightGigabyteClassLinuxGuest
  });
  assert.equal(docCode, 0);
  assert.match(docOut.value(), /PASS Podman CLI: v5\.2\.3/);
  assert.match(docOut.value(), /PASS Podman Compose: available/);
  assert.match(docOut.value(), /PASS Podman Engine: engine=podman v5\.2\.3, mode=rootless, cgroup=v2, cpu_delegated=true, memory_delegated=true/);

  // Support bundle includes Podman facts without secrets
  const bundlePath = join(root, "bundle.json");
  await run(["support-bundle", "--out", bundlePath], {
    env: { SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    execute,
    request: readyUnclaimedRequest
  });
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundle.installation.config.engine, "podman");
  assert.equal(bundle.engine.engine, "podman");
  assert.equal(bundle.engine.mode, "rootless");
  assert.equal(bundle.engine.cgroupVersion, "v2");
  assert.equal(bundle.engine.cpuDelegated, true);
  assert.equal(bundle.engine.memoryDelegated, true);
});

test("install without --engine auto-selects Podman in --non-interactive mode when only Podman is installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-autodetect-"));
  const stdout = capture();
  const stderr = capture();

  const execute = async (spec, io) => {
    if (spec.command === "docker") return 127;
    if (spec.command === "podman" && spec.args[0] === "--version") {
      io?.stdout?.write("podman version 5.3.0\n");
      return 0;
    }
    if (spec.command === "podman" && spec.args[0] === "info" && spec.args.includes("--format")) {
      io?.stdout?.write(
        JSON.stringify({
          version: { Version: "5.3.0" },
          host: {
            cpus: 4,
            memTotal: 8 * 1024 ** 3,
            arch: "amd64",
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"],
            security: { rootless: true }
          }
        })
      );
      return 0;
    }
    return 0;
  };

  const code = await run(
    [
      "install",
      "--profile",
      "small",
      "--no-open",
      "--non-interactive",
      "--answers",
      JSON.stringify({ confirm: true, profile: "small", access: "isolated", companions: false, telemetry: false, open: false })
    ],
    {
      env: { SPACEAPP_HOME: root, SPACEAPP_IMAGE_VERIFY: "off" },
      platform: "linux",
      arch: "x64",
      stdout: stdout.stream,
      stderr: stderr.stream,
      execute,
      inspectResources: async () => eightGigabyteClassLinuxGuest,
      request: readyUnclaimedRequest,
      sleep: async () => {}
    }
  );

  assert.equal(code, 0);
  const saved = await loadConfig(root);
  assert.equal(saved.engine, "podman");
});
