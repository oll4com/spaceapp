import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  createDefaultConfig,
  validateConfig,
  renderWorkspaceCompose,
  composeCommand,
  prepareInstallation,
  saveConfig,
  loadConfig
} from "../src/index.mjs";
import {
  checkMacPodmanMachine,
  ensurePodmanAvailable,
  podmanCliAndComposeAreAvailable,
  podmanIsReady,
  podmanInstallHelp
} from "../src/prerequisites.mjs";
import { run, cgroupLimitsDelegated } from "../src/cli.mjs";
import { inspectStoragePlan } from "../src/storage.mjs";

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

const mockGuestResources = Object.freeze({
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 50 * 1024 ** 3
});

function mockPodmanInfo(execute) {
  return async (spec, io) => {
    if (spec.command === "podman" && spec.args?.includes("info") && spec.args?.includes("json")) {
      io?.stdout?.write?.(JSON.stringify({
        version: { Version: "5.1.0" },
        host: {
          security: { rootless: true },
          cgroupVersion: "v2",
          cgroupControllers: ["cpu", "memory", "pids"]
        }
      }));
      return 0;
    }
    return execute ? execute(spec, io) : 0;
  };
}

function readyRequest(url) {
  return Promise.resolve(new Response(JSON.stringify(
    url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }
  ), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
}

test("composeCommand returns podman command and correct arguments when engine is podman", () => {
  const root = "/test/spaceapp";
  const upSpec = composeCommand("up", root, { profile: "small", engine: "podman", companionsEnabled: false });
  assert.equal(upSpec.command, "podman");
  assert.equal(upSpec.args[0], "compose");
  assert.ok(upSpec.args.includes("up"));

  const config = createDefaultConfig({ version: "1.0.0", profile: "small", accessMode: "isolated", engine: "podman" });
  const downSpec = composeCommand("down", root, config);
  assert.equal(downSpec.command, "podman");
  assert.equal(downSpec.args[0], "compose");
  assert.ok(downSpec.args.includes("down"));
});

test("composeCommand defaults to docker when no engine is specified", () => {
  const root = "/test/spaceapp";
  const upSpec = composeCommand("up", root, { profile: "small" });
  assert.equal(upSpec.command, "docker");
  assert.equal(upSpec.args[0], "compose");
});

test("renderWorkspaceCompose appends bind selinux: z option on Podman", () => {
  const hostDir = resolve(tmpdir(), "spaceapp-test-project");
  const dockerConfig = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  dockerConfig.workspaces = [
    {
      id: "project-a1b2c3d4",
      name: "proj",
      hostPath: hostDir,
      containerPath: "/workspaces/proj",
      readOnly: false
    }
  ];
  const dockerYaml = renderWorkspaceCompose(dockerConfig);
  assert.match(dockerYaml, /type: bind/);
  assert.doesNotMatch(dockerYaml, /selinux: z/);

  const podmanConfig = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  podmanConfig.workspaces = [
    {
      id: "project-a1b2c3d4",
      name: "proj",
      hostPath: hostDir,
      containerPath: "/workspaces/proj",
      readOnly: false
    }
  ];
  const podmanYaml = renderWorkspaceCompose(podmanConfig);
  assert.match(podmanYaml, /type: bind/);
  assert.match(podmanYaml, /bind:\s+selinux: z/);
});

test("validateConfig rejects host-root access mode when engine is podman", () => {
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  config.accessMode = "host-root";
  assert.throws(() => validateConfig(config), /Host-root access is not supported on Podman\./);
});

test("installCommand rejects host-root access mode when engine is podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  await assert.rejects(
    () => run(["install", "--engine", "podman", "--access", "host-root", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin("", "", "", "", "", "y"),
      inspectResources: async () => mockGuestResources
    }),
    /Host-root access is not supported on Podman\./
  );
});

test("engine switching on existing install is refused with migration instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  await prepareInstallation(root, {
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  await saveConfig(root, config);

  await assert.rejects(
    prepareInstallation(root, {
      version: "1.0.0",
      profile: "small",
      accessMode: "isolated",
      engine: "podman"
    }),
    /Cannot switch container engine from "docker" to "podman" on an existing installation\. Docker and Podman volumes are not interchangeable\. To migrate engines, run "spaceapp backup", uninstall with "spaceapp uninstall --purge-data", install with "--engine podman", and run "spaceapp restore"\./
  );

  const loaded = await loadConfig(root);
  assert.equal(loaded.engine, "docker");
});

test("cli parses --engine flag and rejects unsupported engines", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-arg-"));
  await assert.rejects(
    run(["install", "--engine", "containerd", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin("y")
    }),
    /Usage: .*install \[--engine docker\|podman\]/
  );
});

test("install with --engine podman initializes launcher configuration with engine podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const calls = [];
  const stdout = capture();
  const stderr = capture();

  const code = await run(["install", "--engine", "podman", "--profile", "small", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("", "", "", "", "", "y"),
    inspectResources: async () => mockGuestResources,
    request: readyRequest,
    sleep: async () => {},
    execute: mockPodmanInfo(async (spec, io) => {
      calls.push(spec);
      if (spec.args?.includes("pg_dump")) {
        io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      }
      return 0;
    })
  });

  assert.equal(code, 0);
  const saved = await loadConfig(root);
  assert.equal(saved.engine, "podman");
  assert.ok(calls.some((spec) => spec.command === "podman" && spec.args.includes("pull")));
  assert.ok(calls.some((spec) => spec.command === "podman" && spec.args.includes("up")));
});

test("install without --engine auto-selects podman when docker is absent and podman is ready (non-interactive)", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-autodetect-"));
  const calls = [];
  const stdout = capture();
  const stderr = capture();

  const code = await run(["install", "--profile", "small", "--no-open", "--non-interactive", "--answers", '{"confirm": true}'], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    request: readyRequest,
    sleep: async () => {},
    execute: mockPodmanInfo(async (spec, io) => {
      calls.push(spec);
      if (spec.command === "docker") return 127;
      if (spec.command === "podman") return 0;
      return 0;
    })
  });

  assert.equal(code, 0);
  const saved = await loadConfig(root);
  assert.equal(saved.engine, "podman");
});

test("macOS Podman Machine checks resource sizing against profile requirements and advises resize", async () => {
  const stdoutShortage = capture();
  const stderrShortage = capture();

  const shortage = await checkMacPodmanMachine({
    execute: async (spec, io) => {
      if (spec.args.includes("inspect")) {
        io.stdout.write(JSON.stringify([{
          CPUs: 1,
          Memory: 1024 * 1024 * 1024,
          DiskSize: 10 * 1024 * 1024 * 1024,
          Running: true
        }]));
        return 0;
      }
      return 0;
    },
    profile: "small",
    stdout: stdoutShortage.stream,
    stderr: stderrShortage.stream
  });
  // Without output from inspect, inspect failure/empty falls back to list or reports shortage
  assert.equal(shortage.ok, false);
  assert.equal(shortage.code, 1);
  assert.match(stderrShortage.value(), /podman machine set/);

  const stdoutSufficient = capture();
  const stderrSufficient = capture();
  const sufficient = await checkMacPodmanMachine({
    execute: async (spec, io) => {
      if (spec.args.includes("inspect")) {
        io.stdout.write(JSON.stringify([{
          CPUs: 6,
          Memory: 8192 * 1024 * 1024,
          DiskSize: 64 * 1024 * 1024 * 1024,
          Running: true
        }]));
        return 0;
      }
      return 0;
    },
    profile: "small",
    stdout: stdoutSufficient.stream,
    stderr: stderrSufficient.stream
  });
  assert.equal(sufficient.ok, true);
  assert.equal(sufficient.code, 0);
});

test("doctor diagnostics report Podman facts including rootless, cgroup v2, and controller delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();

  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    execute: async (spec, io) => {
      if (spec.args?.includes("--format") && spec.args?.includes("json")) {
        io.stdout.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"]
          }
        }));
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.match(stdout.value(), /PASS Podman CLI: available/);
  assert.match(stdout.value(), /PASS Podman Compose: available/);
  assert.match(stdout.value(), /PASS Podman Service: available/);
  assert.match(stdout.value(), /PASS Podman rootless: rootless/);
  assert.match(stdout.value(), /PASS Podman cgroup version: v2/);
  assert.match(stdout.value(), /PASS Podman resource limit delegation: CPU and memory controllers delegated/);
});

test("doctor diagnostics fail when Podman is rootful", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-rootful-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();

  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    execute: async (spec, io) => {
      if (spec.args?.includes("--format") && spec.args?.includes("json")) {
        io.stdout.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            security: { rootless: false },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"]
          }
        }));
      }
      return 0;
    }
  });

  assert.equal(code, 1);
  assert.match(stderr.value(), /FAIL Podman rootless: rootful/);
});

test("support-bundle collects Podman facts without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-bundle-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const bundlePath = join(root, "test-bundle.json");
  const stdout = capture();
  const stderr = capture();

  const code = await run(["support-bundle", "--out", bundlePath], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec, io) => {
      if (spec.args?.includes("--format") && spec.args?.includes("json")) {
        io.stdout.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"]
          }
        }));
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  const bundleContent = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundleContent.installation.config.engine, "podman");
  assert.equal(bundleContent.engine.engine, "podman");
  assert.equal(bundleContent.engine.version, "5.1.0");
  assert.equal(bundleContent.engine.rootless, true);
  assert.equal(bundleContent.engine.cgroupVersion, "v2");
  assert.deepEqual(bundleContent.engine.cgroupControllers, ["cpu", "memory", "pids"]);
});

test("lifecycle commands use podman executable when engine is podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-lifecycle-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  };

  assert.equal(await run(["up"], options), 0);
  assert.equal(calls.at(-1).command, "podman");
  assert.ok(calls.at(-1).args.includes("up"));

  assert.equal(await run(["status"], options), 0);
  assert.equal(calls.at(-1).command, "podman");
  assert.ok(calls.at(-1).args.includes("ps"));

  assert.equal(await run(["logs"], options), 0);
  assert.equal(calls.at(-1).command, "podman");
  assert.ok(calls.at(-1).args.includes("logs"));

  assert.equal(await run(["down"], options), 0);
  assert.equal(calls.at(-1).command, "podman");
  assert.ok(calls.at(-1).args.includes("down"));
});

test("cgroupLimitsDelegated requires exact cpu and memory controller delegation on Linux", () => {
  // Exact match matches both cpu and memory
  assert.equal(cgroupLimitsDelegated(["cpu", "memory"], "linux"), true);
  assert.equal(cgroupLimitsDelegated(["CPU", "MEMORY", "pids"], "linux"), true);
  assert.equal(cgroupLimitsDelegated("cpu, memory, pids", "linux"), true);
  assert.equal(cgroupLimitsDelegated("cpu io pids", "linux"), false);

  // Substring "cpuset" must NOT satisfy "cpu"
  assert.equal(cgroupLimitsDelegated(["cpuset", "memory"], "linux"), false);
  assert.equal(cgroupLimitsDelegated("cpuset, memory", "linux"), false);

  // Missing memory
  assert.equal(cgroupLimitsDelegated(["cpu", "pids"], "linux"), false);

  // Empty or null
  assert.equal(cgroupLimitsDelegated([], "linux"), false);
  assert.equal(cgroupLimitsDelegated(null, "linux"), false);
  assert.equal(cgroupLimitsDelegated(undefined, "linux"), false);

  // Non-linux platforms always pass
  assert.equal(cgroupLimitsDelegated(null, "darwin"), true);
  assert.equal(cgroupLimitsDelegated([], "win32"), true);
});

test("inspectStoragePlan recognizes Podman image IDs with or without sha256: prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-storage-test-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });

  const hexIdWithoutPrefix = "a".repeat(64);
  const hexIdWithPrefix = `sha256:${"b".repeat(64)}`;

  const execute = async (spec, io) => {
    if (spec.args?.includes("info")) {
      io?.stdout?.write?.(JSON.stringify({
        store: { graphRoot: "/var/lib/containers/storage" },
        host: { arch: "amd64", cpus: 4, memTotal: 8 * 1024 ** 3 }
      }));
      return 0;
    }
    if (spec.args?.includes("inspect")) {
      // Return 64-char hex without prefix for one image, with prefix for another
      io?.stdout?.write?.(spec.args.at(-1).includes("core") ? hexIdWithoutPrefix : hexIdWithPrefix);
      return 0;
    }
    return 0;
  };

  const plan = await inspectStoragePlan({
    root,
    config,
    existingConfig: config,
    resources: { cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 50 * 1024 ** 3 },
    execute,
    operation: "fresh"
  });

  assert.equal(plan.missingImages.length, 0);
  assert.equal(plan.missingImageBytes, 0);
  assert.equal(plan.resources.engineCpuCount, 4);
  assert.equal(plan.resources.engineMemoryBytes, 8 * 1024 ** 3);
});

test("local-images flag skips pull and adds --pull never to up for podman compose", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-local-images-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const stdoutChunks = [];
  const executedSpecs = [];

  const execute = async (spec) => {
    executedSpecs.push(spec);
    return 0;
  };

  await run(["--local-images", "up"], {
    env: { SPACEAPP_HOME: root },
    execute,
    stdout: { write: (msg) => stdoutChunks.push(msg) },
    stderr: { write: () => {} }
  });

  const pullSpec = executedSpecs.find((s) => s.command === "podman" && s.args?.includes("pull"));
  assert.equal(pullSpec, undefined, "pull command is skipped when local-images is enabled");

  const upSpec = executedSpecs.find((s) => s.command === "podman" && s.args?.includes("up"));
  assert.ok(upSpec, "podman compose up was executed");
  assert.ok(
    upSpec.args.includes("--pull") && upSpec.args[upSpec.args.indexOf("--pull") + 1] === "never",
    "up includes --pull never"
  );
});

test("reinstall rejects engine switch on existing install before approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-reinstall-engine-"));
  const stderrChunks = [];
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  await saveConfig(root, config);

  const code = await run(["reinstall", "--engine", "podman"], {
    env: { SPACEAPP_HOME: root },
    stderr: { write: (msg) => stderrChunks.push(msg) }
  });

  assert.equal(code, 1);
  assert.match(
    stderrChunks.join(""),
    /Cannot switch container engine from "docker" to "podman" on an existing installation/
  );

  stderrChunks.length = 0;
  const codeEqual = await run(["reinstall", "--engine=podman"], {
    env: { SPACEAPP_HOME: root },
    stderr: { write: (msg) => stderrChunks.push(msg) }
  });

  assert.equal(codeEqual, 1);
  assert.match(
    stderrChunks.join(""),
    /Cannot switch container engine from "docker" to "podman" on an existing installation/
  );
});

test("engine change supplied through answers.engine on existing install is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-answers-engine-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  await saveConfig(root, config);

  await assert.rejects(
    run(
      [
        "install",
        "--non-interactive",
        "--answers",
        JSON.stringify({ confirm: true, engine: "podman", action: "repair" })
      ],
      {
        env: { SPACEAPP_HOME: root },
        platform: "linux",
        inspectResources: async () => ({
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeDiskBytes: 100 * 1024 ** 3
        })
      }
    ),
    /Cannot switch container engine from "docker" to "podman" on an existing installation/
  );
});

test("answers.engine with unsupported engine throws error", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-invalid-engine-"));
  await assert.rejects(
    () => run(
      [
        "install",
        "--non-interactive",
        "--answers",
        JSON.stringify({ confirm: true, engine: "podmann" })
      ],
      {
        env: { SPACEAPP_HOME: root },
        platform: "linux",
        inspectResources: async () => ({
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeDiskBytes: 100 * 1024 ** 3
        })
      }
    ),
    /Unsupported engine "podmann"/
  );
});

test("composeCommand generates correct profiles for small, medium, and large with podman", () => {
  const root = "/tmp/spaceapp-profiles-test";

  const smallSpec = composeCommand("up", root, { profile: "small", engine: "podman", companionsEnabled: false });
  assert.equal(smallSpec.command, "podman");
  assert.ok(!smallSpec.args.includes("workflows"), "small profile omits workflows");
  assert.ok(!smallSpec.args.includes("standard"), "small profile omits browser");

  const mediumSpec = composeCommand("up", root, { profile: "medium", engine: "podman", companionsEnabled: false });
  assert.equal(mediumSpec.command, "podman");
  assert.ok(mediumSpec.args.includes("workflows"), "medium profile includes workflows");
  assert.ok(!mediumSpec.args.includes("standard"), "medium profile omits browser");

  const largeSpec = composeCommand("up", root, { profile: "large", engine: "podman", companionsEnabled: false });
  assert.equal(largeSpec.command, "podman");
  assert.ok(largeSpec.args.includes("workflows"), "large profile includes workflows");
  assert.ok(largeSpec.args.includes("standard"), "large profile includes standard browser");
});

test("renderWorkspaceCompose appends selinux z label for both read-write and read-only workspaces on podman", () => {
  const hostDir = resolve(tmpdir(), "spaceapp-test-project");
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  config.workspaces = [
    { id: "rw-ws-11223344", name: "rw", hostPath: hostDir, containerPath: "/workspaces/rw", readOnly: false },
    { id: "ro-ws-55667788", name: "ro", hostPath: hostDir, containerPath: "/workspaces/ro", readOnly: true }
  ];

  const composeYaml = renderWorkspaceCompose(config);
  assert.ok(composeYaml.includes("read_only: false"), "includes read-write workspace");
  assert.ok(composeYaml.includes("read_only: true"), "includes read-only workspace");
  const selinuxMatches = composeYaml.match(/selinux:\s*z/g);
  assert.ok(selinuxMatches && selinuxMatches.length >= 4, "both workspaces receive selinux: z for core and cli services");
});

test("provider install opencode uses podman executable when engine is podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-provider-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const executedSpecs = [];
  const execute = async (spec) => {
    executedSpecs.push(spec);
    return 0;
  };

  const code = await run(["provider", "install", "opencode"], {
    env: { SPACEAPP_HOME: root },
    execute,
    stdout: { write: () => {} },
    stderr: { write: () => {} }
  });

  assert.equal(code, 0);
  const providerSpec = executedSpecs.find((s) => s.command === "podman" && s.args?.includes("exec"));
  assert.ok(providerSpec, "podman compose exec was executed for provider install");
  assert.ok(providerSpec.args.includes("opencode"), "passes opencode provider name");
  assert.ok(providerSpec.args.includes("10001:10001"), "runs with non-root user 10001:10001");
});

test("recovery and restore commands use podman executable when engine is podman", () => {
  const root = "/tmp/spaceapp-recovery-test";
  const restoreSpec = composeCommand("restore", root, { backupId: "spaceapp-backup-20261018T120000000Z", profile: "small", engine: "podman" });
  assert.equal(restoreSpec.command, "podman");

  const stopSpec = composeCommand("stopForRestore", root, { profile: "small", engine: "podman" });
  assert.equal(stopSpec.command, "podman");

  const checkpointSpec = composeCommand("checkpointDump", root, { profile: "small", engine: "podman" });
  assert.equal(checkpointSpec.command, "podman");
});

test("repair rejects rootful Podman before storage verification or runtime mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-repair-rootful-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();

  const code = await run(["repair"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: ttyStdin("yes"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    execute: async (spec, io) => {
      if (spec.args?.includes("--format") && spec.args?.includes("json")) {
        io.stdout.write(JSON.stringify({
          host: {
            security: { rootless: false }
          }
        }));
      }
      return 0;
    }
  });

  assert.equal(code, 1);
  assert.match(stderr.value(), /Rootless Podman is required/);
});

test("reinstall with bare --engine prints usage and exits with code 1", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-reinstall-bare-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  await saveConfig(root, config);
  const stderr = capture();

  const code = await run(["reinstall", "--engine"], {
    env: { SPACEAPP_HOME: root },
    stderr: stderr.stream
  });

  assert.equal(code, 1);
  assert.match(stderr.value(), /Usage: spaceapp reinstall \[--engine docker\|podman\]/);
});

test("engine switch is permitted after data purge marked with volumesPurged", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-purged-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  config.volumesPurged = true;
  await saveConfig(root, config);

  const prepared = await prepareInstallation(root, {
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });

  assert.equal(prepared.config.engine, "podman");
  assert.equal(prepared.config.volumesPurged, undefined, "clears volumesPurged marker on install");
});

test("uninstall --purge-data sets volumesPurged and allows subsequent engine switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-uninstall-purge-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  await saveConfig(root, config);
  await writeFile(join(root, "compose.yml"), "services: {}\n");

  const stdout = capture();
  const stderr = capture();

  const code = await run(["uninstall", "--purge-data"], {
    env: { SPACEAPP_HOME: root },
    stdin: ttyStdin("DELETE"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async () => 0
  });

  assert.equal(code, 0);
  const purgedConfig = await loadConfig(root);
  assert.equal(purgedConfig.volumesPurged, true);

  const installCode = await run(["install", "--engine", "podman", "--profile", "small", "--no-open", "--non-interactive", "--answers", '{"confirm": true}'], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    request: readyRequest,
    sleep: async () => {},
    execute: mockPodmanInfo()
  });

  assert.equal(installCode, 0);
  const finalConfig = await loadConfig(root);
  assert.equal(finalConfig.engine, "podman");
  assert.equal(finalConfig.volumesPurged, undefined);
});

test("reinstall rejects engine switch even when volumesPurged is set", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-reinstall-purged-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  config.volumesPurged = true;
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();
  const executed = [];

  const code = await run(["reinstall", "--engine", "podman"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      executed.push(spec);
      return 0;
    }
  });

  assert.equal(code, 1);
  assert.deepEqual(executed, [], "engine-switch rejection must happen before any engine command");
  assert.match(
    stderr.value(),
    /reinstall keeps the saved engine "docker"\. Run "spaceapp install --engine podman" to switch engines\./
  );
});

test("doctor fails when podmanService is available but getPodmanInfo returns null", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-no-info-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();

  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    execute: async (spec, io) => {
      if (spec.args?.includes("--format") && spec.args?.includes("json")) {
        return 1; // Podman info fails
      }
      return 0;
    }
  });

  assert.equal(code, 1);
  assert.match(stderr.value(), /FAIL Podman rootless: system information unavailable or unreadable/);
});

test("failed install after volume purge does not attempt to restore previous purged engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-failed-purge-install-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  config.volumesPurged = true;
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();
  const executedCommands = [];

  const code = await run(["install", "--engine", "podman", "--profile", "small", "--no-open", "--non-interactive", "--answers", '{"confirm": true}'], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    request: async () => {
      throw new Error("Simulated readiness failure");
    },
    sleep: async () => {},
    execute: mockPodmanInfo(async (spec) => {
      executedCommands.push(spec);
      return 0;
    })
  });

  assert.equal(code, 1);
  // Should NOT attempt docker compose up to restore purged docker runtime
  const dockerUp = executedCommands.find(c => c.command === "docker" && c.args?.includes("up"));
  assert.equal(dockerUp, undefined, "Must not attempt to start old docker runtime after purge");
  // Should run podman compose down to stop partially started podman runtime
  const podmanDown = executedCommands.find(c => c.command === "podman" && c.args?.includes("down"));
  assert.ok(podmanDown, "Must stop the attempted podman runtime");
});

test("reinstall clears volumesPurged after successful clean setup", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-reinstall-clear-purged-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  config.volumesPurged = true;
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();

  const code = await run(["reinstall"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: ttyStdin("y"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    request: readyRequest,
    sleep: async () => {},
    execute: mockPodmanInfo(async () => 0)
  });

  assert.equal(code, 0);
  const reloaded = await loadConfig(root);
  assert.equal(reloaded.volumesPurged, undefined, "reinstall must clear volumesPurged after containers start");
});

test("install without --engine auto-selects podman when docker CLI is installed but daemon is stopped", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-docker-stopped-"));
  const calls = [];
  const stdout = capture();
  const stderr = capture();

  const code = await run(["install", "--profile", "small", "--no-open", "--non-interactive", "--answers", '{"confirm": true}'], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    request: readyRequest,
    sleep: async () => {},
    execute: mockPodmanInfo(async (spec, io) => {
      calls.push(spec);
      if (spec.command === "docker") {
        if (spec.args?.includes("--version")) return 0; // CLI installed
        return 1; // docker info / compose fails (daemon stopped)
      }
      if (spec.command === "podman") return 0;
      return 0;
    })
  });

  assert.equal(code, 0);
  const saved = await loadConfig(root);
  assert.equal(saved.engine, "podman", "should auto-select podman when docker daemon is not operational");
  assert.ok(calls.some((spec) => spec.command === "docker"), "docker must be probed first");
  assert.ok(calls.some((spec) => spec.command === "podman"), "podman must be used after the docker probe fails");
});

test("restore clears volumesPurged after restoring data and starting runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-restore-purged-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  config.volumesPurged = true;
  await saveConfig(root, config);

  const backupDir = join(root, "backups", "spaceapp-backup-20261020T000000000Z");
  await mkdir(backupDir, { recursive: true });
  await writeFile(join(backupDir, "manifest.json"), JSON.stringify({ version: "1.0.0", files: [] }));

  const stdout = capture();
  const stderr = capture();

  const code = await run(["restore"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: ttyStdin("RESTORE"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: mockPodmanInfo(async () => 0)
  });

  assert.equal(code, 0);
  const reloaded = await loadConfig(root);
  assert.equal(reloaded.volumesPurged, undefined, "restore must clear volumesPurged after containers start");
});

test("spaceapp up clears volumesPurged when starting runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-up-purged-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  config.volumesPurged = true;
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();

  const code = await run(["up"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: mockPodmanInfo(async () => 0)
  });

  assert.equal(code, 0);
  const reloaded = await loadConfig(root);
  assert.equal(reloaded.volumesPurged, undefined, "up must clear volumesPurged");
});

test("repairRuntime clears volumesPurged when repairing runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-repair-purged-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  config.volumesPurged = true;
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();

  const code = await run(["repair"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdin: ttyStdin("y"),
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    request: readyRequest,
    sleep: async () => {},
    execute: mockPodmanInfo(async () => 0)
  });

  assert.equal(code, 0);
  const reloaded = await loadConfig(root);
  assert.equal(reloaded.volumesPurged, undefined, "repair must clear volumesPurged");
});






