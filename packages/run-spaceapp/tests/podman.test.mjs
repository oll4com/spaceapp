import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable, Writable } from "node:stream";
import {
  composeCommand,
  createDefaultConfig,
  renderWorkspaceCompose,
  prepareInstallation,
  initializeInstallation,
  loadConfig,
  validateConfig,
  saveConfig
} from "../src/index.mjs";
import {
  podmanCliAndComposeAreAvailable,
  podmanIsReady,
  ensurePodmanAvailable,
  ensureDockerAvailable
} from "../src/prerequisites.mjs";
import { run } from "../src/cli.mjs";

function captureStream() {
  let buf = "";
  const stream = new Writable({
    write(chunk, _encoding, done) {
      buf += chunk.toString();
      done();
    }
  });
  return {
    stream,
    value: () => buf
  };
}

function dummyStdin() {
  const stream = Readable.from([]);
  stream._spaceappBuffer = "";
  return stream;
}

function ttyStdin(text) {
  const stream = Readable.from([`${text}\n`]);
  stream.isTTY = true;
  stream._spaceappBuffer = "";
  return stream;
}

test("composeCommand with engine: podman emits command podman with compose subcommands", () => {
  const root = join(tmpdir(), "spaceapp-test-podman-root");
  const cmd = composeCommand("up", root, {
    engine: "podman",
    profile: "small"
  });
  assert.equal(cmd.command, "podman");
  assert.equal(cmd.args[0], "compose");
  assert.ok(cmd.args.includes("up"));
  assert.ok(cmd.args.includes("-d"));
  assert.ok(cmd.args.includes("--remove-orphans"));
});

test("composeCommand with default engine emits command docker", () => {
  const root = join(tmpdir(), "spaceapp-test-docker-root");
  const cmd = composeCommand("up", root, {
    profile: "small"
  });
  assert.equal(cmd.command, "docker");
  assert.equal(cmd.args[0], "compose");
});

test("renderWorkspaceCompose emits SELinux z bind option for podman engine", () => {
  const config = createDefaultConfig({ version: "1.0.0", engine: "podman" });
  config.workspaces = [
    {
      id: "workspace-12345678",
      hostPath: resolve(tmpdir(), "workspace1"),
      containerPath: "/workspaces/workspace1",
      readOnly: false
    }
  ];
  const yaml = renderWorkspaceCompose(config);
  assert.match(yaml, /bind:\s+selinux:\s+z/);
});

test("renderWorkspaceCompose does not emit SELinux z bind option for docker engine", () => {
  const config = createDefaultConfig({ version: "1.0.0", engine: "docker" });
  config.workspaces = [
    {
      id: "workspace-12345678",
      hostPath: resolve(tmpdir(), "workspace1"),
      containerPath: "/workspaces/workspace1",
      readOnly: false
    }
  ];
  const yaml = renderWorkspaceCompose(config);
  assert.doesNotMatch(yaml, /selinux/i);
});

test("validateConfig validates engine field (only docker or podman)", () => {
  const validDocker = createDefaultConfig({ version: "1.0.0", engine: "docker" });
  assert.doesNotThrow(() => validateConfig(validDocker));

  const validPodman = createDefaultConfig({ version: "1.0.0", engine: "podman" });
  assert.doesNotThrow(() => validateConfig(validPodman));

  const invalid = { ...validDocker, engine: "nerdctl" };
  assert.throws(() => validateConfig(invalid), /engine must be docker or podman/);
});

test("prepareInstallation rejects switching engines on existing installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  const prepared = await prepareInstallation(root, {
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  await saveConfig(root, prepared.config);

  await assert.rejects(
    () => prepareInstallation(root, {
      version: "1.0.0",
      profile: "small",
      accessMode: "isolated",
      engine: "podman"
    }),
    /Cannot switch container engine from "docker" to "podman"/
  );
});

test("prepareInstallation rejects switching engines on legacy installation without engine field", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-legacy-"));
  const prepared = await prepareInstallation(root, {
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated"
  });
  const legacyConfig = { ...prepared.config };
  delete legacyConfig.engine;
  await saveConfig(root, legacyConfig);

  await assert.rejects(
    () => prepareInstallation(root, {
      version: "1.0.0",
      profile: "small",
      accessMode: "isolated",
      engine: "podman"
    }),
    /Cannot switch container engine from "docker" to "podman"/
  );
});

test("prepareInstallation rejects --access host-root on Podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-host-root-"));
  await assert.rejects(
    () => prepareInstallation(root, {
      version: "1.0.0",
      profile: "small",
      accessMode: "host-root",
      engine: "podman"
    }),
    /--access host-root is not supported on Podman/
  );
});

test("podmanCliAndComposeAreAvailable checks podman CLI and podman compose", async () => {
  const executed = [];
  const execute = async (spec) => {
    executed.push(spec);
    return 0;
  };
  const ok = await podmanCliAndComposeAreAvailable(execute);
  assert.equal(ok, true);
  assert.deepEqual(executed.map(e => [e.command, ...e.args]), [
    ["podman", "--version"],
    ["podman", "compose", "version"]
  ]);
});

test("podmanIsReady checks CLI, compose, and info", async () => {
  const executed = [];
  const execute = async (spec) => {
    executed.push(spec);
    return 0;
  };
  const ok = await podmanIsReady(execute);
  assert.equal(ok, true);
  assert.deepEqual(executed.map(e => [e.command, ...e.args]), [
    ["podman", "--version"],
    ["podman", "compose", "version"],
    ["podman", "info"]
  ]);
});

test("doctor with engine: podman probes podman and reports rootless, cgroup and limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-doctor-podman-"));
  const config = createDefaultConfig({ version: "1.0.0", engine: "podman" });
  await saveConfig(root, config);

  const stdout = captureStream();
  const stderr = captureStream();

  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: dummyStdin(),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 50 * 1024 ** 3
    }),
    execute: async (spec, io) => {
      if (spec.command === "podman" && spec.args?.includes("info")) {
        io?.stdout?.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"]
          }
        }));
        return 0;
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.match(stdout.value(), /PASS Podman CLI: available/);
  assert.match(stdout.value(), /PASS Podman Compose: available/);
  assert.match(stdout.value(), /PASS Podman Engine: available \(5\.1\.0\)/);
  assert.match(stdout.value(), /PASS Podman rootless mode: rootless/);
  assert.match(stdout.value(), /PASS cgroup version: v2/);
  assert.match(stdout.value(), /PASS Resource limits delegation: delegated/);
});

test("doctor reports non-delegated cgroup limits clearly without failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-doctor-podman-limits-"));
  const config = createDefaultConfig({ version: "1.0.0", engine: "podman" });
  await saveConfig(root, config);

  const stdout = captureStream();
  const stderr = captureStream();

  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: dummyStdin(),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 50 * 1024 ** 3
    }),
    execute: async (spec, io) => {
      if (spec.command === "podman" && spec.args?.includes("info")) {
        io?.stdout?.write(JSON.stringify({
          version: { Version: "5.0.0" },
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: [] // Missing cpu and memory delegation
          }
        }));
        return 0;
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.match(stdout.value(), /Resource limits delegation: not delegated/);
});

test("doctor fails when podman is running in rootful mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-doctor-podman-rootful-"));
  const config = createDefaultConfig({ version: "1.0.0", engine: "podman" });
  await saveConfig(root, config);

  const stdout = captureStream();
  const stderr = captureStream();

  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: dummyStdin(),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 50 * 1024 ** 3
    }),
    execute: async (spec, io) => {
      if (spec.command === "podman" && spec.args?.includes("info")) {
        io?.stdout?.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            security: { rootless: false },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory"]
          }
        }));
        return 0;
      }
      return 0;
    }
  });

  assert.equal(code, 1);
  assert.match(stderr.value(), /FAIL Podman rootless mode: rootful/);
});

test("support-bundle includes engine facts for podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-bundle-podman-"));
  const config = createDefaultConfig({ version: "1.0.0", engine: "podman" });
  await saveConfig(root, config);

  const stdout = captureStream();
  const stderr = captureStream();
  const bundlePath = join(root, "bundle.json");

  const code = await run(["support-bundle", "--out", bundlePath], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: dummyStdin(),
    request: async () => ({ ok: true, status: 200 }),
    execute: async (spec, io) => {
      if (spec.command === "podman" && spec.args?.includes("info")) {
        io?.stdout?.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory"]
          }
        }));
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundle.installation.config.engine, "podman");
  assert.equal(bundle.engine.name, "podman");
  assert.equal(bundle.engine.version, "5.1.0");
  assert.equal(bundle.engine.rootless, true);
  assert.equal(bundle.engine.cgroupVersion, "v2");
  assert.equal(bundle.engine.limitsDelegated, true);
});

test("support-bundle reports rootless: null when host.security.rootless is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-bundle-podman-null-"));
  const config = createDefaultConfig({ version: "1.0.0", engine: "podman" });
  await saveConfig(root, config);

  const stdout = captureStream();
  const stderr = captureStream();
  const bundlePath = join(root, "bundle.json");

  const code = await run(["support-bundle", "--out", bundlePath], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: dummyStdin(),
    request: async () => ({ ok: true, status: 200 }),
    execute: async (spec, io) => {
      if (spec.command === "podman" && spec.args?.includes("info")) {
        io?.stdout?.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory"]
          }
        }));
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundle.engine.name, "podman");
  assert.equal(bundle.engine.rootless, null);
  assert.equal(bundle.engine.limitsDelegated, true);
});

test("ensurePodmanAvailable on macOS checks podman machine sizing and warns if insufficient", async () => {
  const stdout = captureStream();
  const stderr = captureStream();

  const execute = async (spec, io) => {
    if (spec.command === "podman" && spec.args?.[0] === "machine" && spec.args?.[1] === "inspect") {
      io?.stdout?.write(JSON.stringify([{
        Running: true,
        CPUs: 2, // Required: 4 for small profile
        Memory: 4096 * 1024 * 1024, // 4 GiB, Required: 7GiB
        DiskSize: 20 * 1024 * 1024 * 1024
      }]));
      return 0;
    }
    return 0;
  };

  const res = await ensurePodmanAvailable({
    platform: "darwin",
    arch: "arm64",
    env: {},
    stdin: null,
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute,
    profile: "small",
    sleep: async () => {}
  });

  assert.equal(res.code, 0);
  assert.match(stdout.value(), /podman machine set --cpus 4 --memory 7168/);
});

test("ensurePodmanAvailable on macOS checks Podman 5 Resources shape", async () => {
  const stdout = captureStream();
  const stderr = captureStream();

  const execute = async (spec, io) => {
    if (spec.command === "podman" && spec.args?.[0] === "machine" && spec.args?.[1] === "inspect") {
      io?.stdout?.write(JSON.stringify([{
        Running: true,
        Resources: {
          CPUs: 2,
          Memory: 4096,
          DiskSize: 20
        }
      }]));
      return 0;
    }
    return 0;
  };

  const res = await ensurePodmanAvailable({
    platform: "darwin",
    arch: "arm64",
    env: {},
    stdin: null,
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute,
    profile: "small",
    sleep: async () => {}
  });

  assert.equal(res.code, 0);
  assert.match(stdout.value(), /podman machine set --cpus 4 --memory 7168/);
});

test("ensureDockerAvailable falls back to Podman when Docker is missing and Podman is ready", async () => {
  const stdout = captureStream();
  const stderr = captureStream();

  const execute = async (spec) => {
    if (spec.command === "docker") return 127;
    if (spec.command === "podman") return 0;
    return 0;
  };

  const installArgs = { requestedProfile: "small", autoConfirm: true, allowPodmanFallback: true };
  const res = await ensureDockerAvailable({
    platform: "linux",
    arch: "x64",
    env: {},
    stdin: null,
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute,
    engine: "docker",
    installArgs
  });

  assert.equal(res.code, 0);
  assert.equal(res.engine, "podman");
  assert.equal(installArgs.requestedEngine, "podman");
  assert.match(stdout.value(), /Using Podman container engine/);
});

test("local image mode with podman engine skips pull and passes --pull never on up", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-local-images-podman-"));
  const config = createDefaultConfig({ version: "0.1.30", engine: "podman" });
  await saveConfig(root, config);

  const stdout = captureStream();
  const stderr = captureStream();
  const calls = [];

  const exitCode = await run(["up", "--local-images"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: dummyStdin(),
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  });

  assert.equal(exitCode, 0);
  const up = calls.find((x) => x.command === "podman" && x.args?.includes("up"));
  assert.ok(up, "podman compose up must be called");
  assert.deepEqual(up.args.slice(up.args.indexOf("up"), up.args.indexOf("up") + 3), ["up", "--pull", "never"]);
});

test("factory-reset preserves configured podman engine in newly initialized installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-factory-reset-podman-"));
  await initializeInstallation(root, { version: "0.1.30", engine: "podman" });

  const stdout = captureStream();
  const stderr = captureStream();
  const calls = [];

  const exitCode = await run(["factory-reset"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("FACTORY-RESET"),
    execute: async (spec, io) => {
      if (spec.args?.includes("pg_dump")) {
        io?.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
        return 0;
      }
      calls.push(spec);
      return 0;
    }
  });

  assert.equal(exitCode, 0);
  assert.match(stdout.value(), /SpaceApp factory reset complete/);
  const reloaded = await loadConfig(root);
  assert.equal(reloaded.engine, "podman");
});

test("same-version install with explicit engine switch rejects instead of repairing", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  await initializeInstallation(root, { version: "0.1.30", engine: "docker" });

  const stdout = captureStream();
  const stderr = captureStream();
  const calls = [];

  await assert.rejects(
    run(["install", "--engine", "podman", "--non-interactive", "--answers", '{"confirm":true,"open":false}'], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: stdout.stream,
      stderr: stderr.stream,
      stdin: dummyStdin(),
      execute: async (spec) => {
        calls.push(spec);
        return 0;
      },
      request: async () => ({ ok: true, status: 200 })
    }),
    /Cannot switch container engine from "docker" to "podman"/
  );
});

