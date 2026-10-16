import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  addWorkspace,
  composeCommand,
  createDefaultConfig,
  initializeInstallation,
  loadConfig,
  prepareInstallation,
  renderWorkspaceCompose,
  validateConfig
} from "../src/index.mjs";
import {
  ensurePodmanAvailable,
  parsePodmanInfo,
  podmanInstallInstructions,
  podmanMachineResizeCommand
} from "../src/prerequisites.mjs";
import { inspectStoragePlan, storageChecks } from "../src/storage.mjs";

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

function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on() {
      return this;
    },
    once() {
      return this;
    },
    removeListener() {
      return this;
    },
    off() {
      return this;
    },
    listenerCount() {
      return 0;
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) {
            return { done: true };
          }
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function readyUnclaimedRequest(url) {
  return Promise.resolve(url.endsWith("/readyz")
    ? jsonResponse({ ok: true })
    : jsonResponse({ setupRequired: true, expiresAt: "2099-07-23T12:15:00.000Z" }));
}

function healthyPodmanInfoPayload({
  rootless = true,
  cgroupVersion = "v2",
  cgroupControllers = ["cpu", "cpuset", "io", "memory", "pids"],
  cpus = 8,
  memTotal = 16 * 1024 ** 3,
  graphRoot = "/home/user/.local/share/containers/storage",
  graphRootAllocated = 64 * 1024 ** 3
} = {}) {
  return JSON.stringify({
    host: {
      arch: "amd64",
      cpus,
      memTotal,
      cgroupVersion,
      cgroupControllers,
      security: {
        rootless
      }
    },
    store: {
      graphRoot,
      graphRootAllocated
    }
  });
}

function createPodmanExecute({
  podmanInfoPayload = healthyPodmanInfoPayload(),
  composeExitCode = 0,
  dockerAvailable = false
} = {}) {
  const calls = [];
  const execute = async (spec, io = {}) => {
    calls.push(spec);
    if (spec.command === "docker") {
      return dockerAvailable ? 0 : 127;
    }
    if (spec.command !== "podman") {
      return 0;
    }
    const args = spec.args ?? [];
    if (args[0] === "--version") {
      io.stdout?.write("podman version 4.9.3\n");
      return 0;
    }
    if (args[0] === "compose" && args[1] === "version") {
      io.stdout?.write("podman-compose version 1.0.6\nDocker Compose version v2.29.2\n");
      return composeExitCode;
    }
    if (args[0] === "info") {
      io.stdout?.write(`${podmanInfoPayload}\n`);
      return 0;
    }
    if (args[0] === "image" && args[1] === "inspect") {
      io.stdout?.write(`sha256:${"a".repeat(64)}\n`);
      return 0;
    }
    if (args.includes("pg_dump")) {
      io.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
      return 0;
    }
    if (args[0] === "compose" && args.includes("ps") && args.includes("postgres")) {
      io.stdout?.write("spaceapp-postgres-1\n");
      return 0;
    }
    return 0;
  };
  return { execute, calls };
}

test("parsePodmanInfo extracts rootless cgroup v2 controllers and storage metrics", () => {
  const parsed = parsePodmanInfo(healthyPodmanInfoPayload({
    cpus: 6,
    memTotal: 12 * 1024 ** 3,
    cgroupVersion: "v2",
    cgroupControllers: ["cpu", "memory", "pids"]
  }));

  assert.equal(parsed.rootless, true);
  assert.equal(parsed.cgroupVersion, "v2");
  assert.equal(parsed.cgroupV2, true);
  assert.equal(parsed.cpuMemoryDelegated, true);
  assert.deepEqual(parsed.cgroupControllers, ["cpu", "memory", "pids"]);
  assert.equal(parsed.cpus, 6);
  assert.equal(parsed.memTotal, 12 * 1024 ** 3);
  assert.equal(parsed.graphRoot, "/home/user/.local/share/containers/storage");
  assert.equal(parsed.graphRootAllocated, 64 * 1024 ** 3);
});

test("validateConfig and prepareInstallation enforce Podman engine constraints", async (t) => {
  const baseConfig = createDefaultConfig({
    version: "1.1.5",
    profile: "small",
    engine: "podman"
  });
  assert.equal(baseConfig.engine, "podman");

  assert.throws(
    () => validateConfig({
      ...baseConfig,
      accessMode: "host-root"
    }),
    /Host-root access \(--access host-root\) is not supported with Podman.*workspace add <path>/s
  );

  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeInstallation(root, {
    version: "1.1.5",
    profile: "small",
    engine: "docker"
  });

  await assert.rejects(
    prepareInstallation(root, {
      version: "1.1.5",
      profile: "small",
      engine: "podman"
    }),
    /Cannot switch container engine from docker to podman.*backup.*restore/s
  );
});

test("renderWorkspaceCompose adds SELinux :z label and keep-id userns mapping for Podman", () => {
  const workspace = {
    id: "project-a-12345678",
    name: "project-a",
    hostPath: "/home/alice/project-a",
    containerPath: "/workspaces/project-a-12345678",
    readOnly: false
  };
  const podmanConfig = {
    ...createDefaultConfig({
      version: "1.1.5",
      profile: "small",
      engine: "podman"
    }),
    workspaces: [workspace]
  };
  const podmanYaml = renderWorkspaceCompose(podmanConfig);
  assert.match(podmanYaml, /userns_mode: "keep-id:uid=10001,gid=10001"/);
  assert.match(podmanYaml, /user: "0:0"/);
  assert.match(podmanYaml, /selinux: z/);

  const dockerConfig = {
    ...createDefaultConfig({
      version: "1.1.5",
      profile: "small",
      engine: "docker"
    }),
    workspaces: [workspace]
  };
  const dockerYaml = renderWorkspaceCompose(dockerConfig);
  assert.doesNotMatch(dockerYaml, /keep-id:uid=10001,gid=10001/);
  assert.doesNotMatch(dockerYaml, /selinux: z/);
});

test("composeCommand selects podman when engine is podman", () => {
  const spec = composeCommand("up", tmpdir(), {
    profile: "small",
    engine: "podman"
  });
  assert.equal(spec.command, "podman");
  assert.equal(spec.args[0], "compose");
});

test("ensurePodmanAvailable checks rootless cgroup v2 and cpu/memory delegation on Linux", async () => {
  const cgroupV1 = createPodmanExecute({
    podmanInfoPayload: healthyPodmanInfoPayload({ cgroupVersion: "v1" })
  });
  const errV1 = capture();
  const resultV1 = await ensurePodmanAvailable({
    platform: "linux",
    execute: cgroupV1.execute,
    stdout: capture().stream,
    stderr: errV1.stream
  });
  assert.equal(resultV1.code, 1);
  assert.match(errV1.value(), /cgroup v2/);

  const missingDelegation = createPodmanExecute({
    podmanInfoPayload: healthyPodmanInfoPayload({ cgroupControllers: ["pids"] })
  });
  const errMissing = capture();
  const resultMissing = await ensurePodmanAvailable({
    platform: "linux",
    execute: missingDelegation.execute,
    stdout: capture().stream,
    stderr: errMissing.stream
  });
  assert.equal(resultMissing.code, 1);
  assert.match(errMissing.value(), /Delegate=cpu cpuset io memory pids/);
});

test("ensurePodmanAvailable checks macOS podman machine sizing and prints resize command", async () => {
  const undersizedMac = createPodmanExecute({
    podmanInfoPayload: healthyPodmanInfoPayload({
      rootless: true,
      cpus: 2,
      memTotal: 2 * 1024 ** 3,
      graphRootAllocated: 10 * 1024 ** 3
    })
  });
  const stderr = capture();
  const result = await ensurePodmanAvailable({
    platform: "darwin",
    profile: "small",
    execute: undersizedMac.execute,
    stdout: capture().stream,
    stderr: stderr.stream
  });
  assert.equal(result.code, 1);
  assert.match(
    stderr.value(),
    /podman machine stop && podman machine set --cpus 4 --memory 8192 --disk-size 20 && podman machine start/
  );
  assert.equal(
    podmanMachineResizeCommand("large"),
    "podman machine stop && podman machine set --cpus 8 --memory 16384 --disk-size 30 && podman machine start"
  );
});

test("ensurePodmanAvailable never auto-installs packages and prints distro instructions when missing", async () => {
  const calls = [];
  const stderr = capture();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    execute: async (spec) => {
      calls.push(spec);
      return 127;
    },
    stdout: capture().stream,
    stderr: stderr.stream,
    osRelease: async () => ({ ID: "fedora", NAME: "Fedora Linux" })
  });

  assert.equal(result.code, 1);
  assert.match(stderr.value(), /sudo dnf install -y podman docker-compose/);
  assert.equal(calls.some((call) => call.command === "sudo"), false);
  assert.match(podmanInstallInstructions("linux", { ID: "ubuntu" }), /apt-get install -y podman docker-compose-v2/);
});

test("install --engine podman persists engine in config and uses podman compose across lifecycle commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceDir = join(root, "sample-workspace");
  await mkdir(workspaceDir, { recursive: true });

  const { execute, calls } = createPodmanExecute();
  const stdout = capture();
  const stderr = capture();
  const hostResources = {
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeDiskBytes: 40 * 1024 ** 3
  };

  const installCode = await run([
    "install",
    "--engine",
    "podman",
    "--profile",
    "small",
    "--non-interactive",
    "--no-open",
    "--answers",
    JSON.stringify({ confirm: true, telemetry: false })
  ], {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    platform: "linux",
    stdin: ttyStdin("y"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute,
    inspectResources: async () => hostResources,
    request: readyUnclaimedRequest,
    sleep: async () => {}
  });

  assert.equal(installCode, 0, stderr.value());
  const config = await loadConfig(root);
  assert.equal(config.engine, "podman");
  assert.equal(calls.some((call) => call.command === "docker"), false);
  assert.equal(calls.some((call) => call.command === "podman" && call.args[0] === "compose"), true);

  assert.equal(
    await run(["workspace", "add", workspaceDir], {
      env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
      platform: "linux",
      stdin: ttyStdin("y"),
      stdout: stdout.stream,
      stderr: stderr.stream,
      execute
    }),
    0
  );
  const composeWorkspaces = await readFile(join(root, "compose.workspaces.yml"), "utf8");
  assert.match(composeWorkspaces, /keep-id:uid=10001,gid=10001/);
  assert.match(composeWorkspaces, /selinux: z/);

  const bundlePath = join(root, "podman-support-bundle.json");
  for (const argv of [
    ["up"],
    ["status"],
    ["logs"],
    ["doctor"],
    ["repair"],
    ["backup"],
    ["credentials", "list"],
    ["owner", "rotate-setup-token"],
    ["support-bundle", "--out", bundlePath],
    ["down"],
    ["uninstall"]
  ]) {
    calls.length = 0;
    const cmdOut = capture();
    const cmdErr = capture();
    const code = await run(argv, {
      env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
      platform: "linux",
      stdin: ttyStdin("y"),
      stdout: cmdOut.stream,
      stderr: cmdErr.stream,
      execute,
      inspectResources: async () => hostResources,
      request: readyUnclaimedRequest,
      sleep: async () => {}
    });
    assert.equal(code, 0, `Command ${argv.join(" ")} failed: ${cmdErr.value()}`);
    assert.equal(
      calls.some((call) => call.command === "docker"),
      false,
      `Command ${argv.join(" ")} unexpectedly called docker`
    );
    if (argv[0] === "support-bundle") {
      const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
      assert.equal(bundle.containerEngine.engine, "podman");
      assert.equal(bundle.containerEngine.mode, "rootless");
      assert.equal(bundle.containerEngine.cgroupV2, true);
      assert.equal(bundle.containerEngine.cpuMemoryLimitsDelegated, true);
    }
  }
});

test("interactive wizard offers Podman when Docker is absent and Podman is available", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-wizard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { execute, calls } = createPodmanExecute({ dockerAvailable: false });
  const stdout = capture();
  const stderr = capture();

  const code = await run([
    "install",
    "--no-open",
    "--answers",
    JSON.stringify({
      engine: "podman",
      profile: "small",
      accessMode: "isolated",
      bindHost: "127.0.0.1",
      port: 4911,
      telemetry: false,
      confirm: true
    })
  ], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: ttyStdin("y"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute,
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 40 * 1024 ** 3
    }),
    request: readyUnclaimedRequest,
    sleep: async () => {}
  });

  assert.equal(code, 0, stderr.value());
  const config = await loadConfig(root);
  assert.equal(config.engine, "podman");
  assert.equal(calls.some((call) => call.command === "podman" && call.args[0] === "compose"), true);
});

test("inspectStoragePlan queries Podman store and image sizes when engine is podman", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await initializeInstallation(root, {
    version: "1.1.5",
    profile: "small",
    engine: "podman"
  });
  const { execute, calls } = createPodmanExecute();
  const hostResources = {
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeDiskBytes: 40 * 1024 ** 3
  };
  const plan = await inspectStoragePlan({
    root,
    config,
    operation: "install",
    profile: "small",
    engine: "podman",
    platform: "linux",
    arch: "x64",
    execute,
    stdin: Readable.from([]),
    resources: hostResources
  });

  assert.equal(plan.engine, "podman");
  assert.equal(calls.some((call) => call.command === "podman" && call.args[0] === "info"), true);
  assert.equal(calls.some((call) => call.command === "docker"), false);
  const checks = storageChecks(plan, hostResources);
  assert.equal(checks.every((check) => check.ok), true);
  assert.equal(checks.some((check) => check.name === "Podman storage"), true);
});
