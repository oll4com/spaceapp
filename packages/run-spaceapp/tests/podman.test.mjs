import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  commitInstallation,
  composeCommand,
  loadConfig,
  prepareInstallation,
  renderPodmanCompose,
  renderWorkspaceCompose,
  writeRuntimeFiles
} from "../src/index.mjs";
import {
  checkPodmanMachineResources
} from "../src/prerequisites.mjs";
import { run } from "../src/cli.mjs";

const home = resolve(tmpdir(), "spaceapp-podman-test-home");

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

const podmanConfig = {
  schemaVersion: 4,
  version: "1.1.5",
  previousVersion: null,
  bindHost: "127.0.0.1",
  port: 4911,
  telemetry: false,
  profile: "standard",
  accessMode: "isolated",
  engine: "podman",
  companionsEnabled: false,
  workspaces: [
    {
      id: "project-a1b2c3d4",
      name: "project",
      hostPath: "/home/user/project",
      containerPath: "/workspaces/project",
      readOnly: false
    }
  ]
};

test("composeCommand with engine: podman uses podman compose and injects compose.podman.yml", () => {
  const upCmd = composeCommand("up", home, { engine: "podman" });
  assert.equal(upCmd.command, "podman");
  assert.equal(upCmd.args[0], "compose");
  assert.ok(upCmd.args.includes("-f"));
  const podmanYamlIndex = upCmd.args.indexOf(join(home, "compose.podman.yml"));
  assert.notEqual(podmanYamlIndex, -1, "must include compose.podman.yml");
  assert.equal(upCmd.args[podmanYamlIndex - 1], "-f");
  assert.deepEqual(upCmd.args.slice(-3), ["up", "-d", "--remove-orphans"]);

  const downCmd = composeCommand("down", home, { engine: "podman" });
  assert.equal(downCmd.command, "podman");
  assert.deepEqual(downCmd.args.slice(-1), ["down"]);

  const pullCmd = composeCommand("pull", home, { engine: "podman" });
  assert.equal(pullCmd.command, "podman");
  assert.deepEqual(pullCmd.args.slice(-1), ["pull"]);

  const syncCmd = composeCommand("syncCredentials", home, { engine: "podman" });
  assert.equal(syncCmd.command, "podman");
  assert.deepEqual(syncCmd.args.slice(-5), ["up", "-d", "--no-deps", "--force-recreate", "spaceapp-cli"]);

  const tokenCmd = composeCommand("rotateOwnerSetupToken", home, { engine: "podman" });
  assert.equal(tokenCmd.command, "podman");
  assert.deepEqual(tokenCmd.args.slice(-8), [
    "exec", "-T", "--user", "10001:10001", "spaceapp-core",
    "node", "scripts/rotate-owner-setup-token.mjs", "--stdin"
  ]);
});

test("renderPodmanCompose applies keep-id user namespace and SELinux :z relabeling", () => {
  const yaml = renderPodmanCompose(podmanConfig);
  assert.match(yaml, /spaceapp-core:/);
  assert.match(yaml, /spaceapp-cli:/);
  assert.match(yaml, /spaceapp-browser:/);

  // keep-id user namespace on core, cli, and browser
  const keepIdMatches = yaml.match(/userns_mode: "keep-id:uid=10001,gid=10001"/g);
  assert.equal(keepIdMatches?.length, 3, "keep-id must be applied to core, cli, and browser");

  // SELinux relabeling on static binds
  assert.match(yaml, /source: "\.\/backups"[\s\S]*?selinux: "z"/);
  assert.match(yaml, /source: "\.\/secrets\/providers"[\s\S]*?selinux: "z"/);

  // Non-podman config returns empty services
  const dockerYaml = renderPodmanCompose({ ...podmanConfig, engine: "docker" });
  assert.equal(dockerYaml, "services: {}\n");
});

test("renderWorkspaceCompose applies SELinux :z only when engine is podman", () => {
  const podmanWorkspaces = renderWorkspaceCompose(podmanConfig);
  assert.match(podmanWorkspaces, /selinux: "z"/);

  const dockerWorkspaces = renderWorkspaceCompose({ ...podmanConfig, engine: "docker" });
  assert.doesNotMatch(dockerWorkspaces, /selinux: "z"/);
});

test("prepareInstallation persists engine and validates safety guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-prep-"));
  try {
    const res = await prepareInstallation(root, {
      version: "1.1.5",
      profile: "small",
      accessMode: "isolated",
      engine: "podman"
    });
    assert.equal(res.config.engine, "podman");
    await commitInstallation(root, res.config);
    await writeRuntimeFiles(root, res.config);

    // Verify compose.podman.yml was written
    const podmanComposeContent = await readFile(join(root, "compose.podman.yml"), "utf8");
    assert.match(podmanComposeContent, /keep-id:uid=10001,gid=10001/);

    // Rejects host-root access mode on Podman
    await assert.rejects(
      prepareInstallation(root, {
        version: "1.1.5",
        profile: "small",
        accessMode: "host-root",
        engine: "podman"
      }),
      /--access host-root is not supported with the Podman container engine/
    );

    // Rejects switching engine on existing installation
    await assert.rejects(
      prepareInstallation(root, {
        version: "1.1.5",
        profile: "small",
        accessMode: "isolated",
        engine: "docker"
      }),
      /Switching container engine on an existing installation is not supported/
    );

    // Also rejects switching when existing config has no engine property (legacy Docker install)
    const legacyConfigPath = join(root, "config.json");
    const currentConfig = JSON.parse(await readFile(legacyConfigPath, "utf8"));
    delete currentConfig.engine;
    await writeFile(legacyConfigPath, JSON.stringify(currentConfig, null, 2), "utf8");

    await assert.rejects(
      prepareInstallation(root, {
        version: "1.1.5",
        profile: "small",
        accessMode: "isolated",
        engine: "podman"
      }),
      /Switching container engine on an existing installation is not supported \(existing engine is docker, requested podman\)/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkPodmanMachineResources validates resources and prevents shrinking disk", async () => {
  // Scenario 1: Insufficient resources
  const mockExecuteFail = async (spec, io) => {
    if (spec.args?.includes("inspect")) {
      io?.stdout?.write(JSON.stringify({
        Resources: {
          CPUs: 2,
          Memory: 4096,
          DiskSize: 5 * 1024 ** 3
        }
      }));
      return 0;
    }
    return 0;
  };

  const resultFail = await checkPodmanMachineResources(mockExecuteFail, "small");
  assert.equal(resultFail.ok, false);
  assert.ok(resultFail.issues.some((i) => i.includes("CPU")));
  assert.ok(resultFail.issues.some((i) => i.includes("Memory")));
  assert.ok(resultFail.issues.some((i) => i.includes("Disk")));

  // Scenario 2: Sufficient resources
  const mockExecutePass = async (spec, io) => {
    if (spec.args?.includes("inspect")) {
      io?.stdout?.write(JSON.stringify({
        Resources: {
          CPUs: 4,
          Memory: 8192,
          DiskSize: 30 * 1024 ** 3
        }
      }));
      return 0;
    }
    return 0;
  };

  const resultPass = await checkPodmanMachineResources(mockExecutePass, "small");
  assert.equal(resultPass.ok, true);
  assert.ok(!resultPass.issues?.length);

  // Scenario 3: Disk resize guidance never specifies a size smaller than current allocation
  let capturedStderr = "";
  const mockStderr = {
    write(chunk) {
      capturedStderr += chunk;
    }
  };
  await checkPodmanMachineResources({
    execute: mockExecuteFail,
    profile: "small",
    stderr: mockStderr
  });
  assert.match(capturedStderr, /podman machine set/);
  assert.match(capturedStderr, /--cpus 4/);
  assert.match(capturedStderr, /--memory 7168/);
  assert.match(capturedStderr, /--disk-size 7/);
});

test("doctor diagnostics validate rootless mode, cgroup v2, and controller delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  try {
    const res = await prepareInstallation(root, {
      version: "1.1.5",
      profile: "small",
      accessMode: "isolated",
      engine: "podman"
    });
    await commitInstallation(root, res.config);
    await writeRuntimeFiles(root, res.config);

    // Case 1: All requirements met (rootless, cgroup v2, cpu+memory+pids)
    let out = "";
    let err = "";
    const stdout = { write: (c) => { out += c; } };
    const stderr = { write: (c) => { err += c; } };

    const mockExecuteGood = async (spec, io) => {
      if (spec.command === "podman") {
        if (spec.args?.includes("--version") || spec.args?.includes("version")) return 0;
        if (spec.args?.includes("info")) {
          io?.stdout?.write(JSON.stringify({
            version: { Version: "5.0.0" },
            host: {
              security: { rootless: true },
              cgroupVersion: "v2",
              cgroupControllers: ["cpu", "memory", "pids", "io"]
            }
          }));
          return 0;
        }
      }
      return 0;
    };

    const codeGood = await run(["doctor"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout,
      stderr,
      execute: mockExecuteGood,
      inspectResources: async () => ({
        cpuCount: 4,
        totalMemoryBytes: 8 * 1024 ** 3,
        freeDiskBytes: 20 * 1024 ** 3
      })
    });
    assert.equal(codeGood, 0);
    assert.match(out, /PASS Podman CLI/);
    assert.match(out, /PASS Podman Compose/);
    assert.match(out, /PASS Podman Engine/);
    assert.match(out, /PASS Podman mode: rootless/);
    assert.match(out, /PASS Cgroup version: v2/);
    assert.match(out, /PASS Cgroup controller delegation/);

    // Case 2: Missing controller delegation (only cpu, missing memory and pids)
    let errBad = "";
    const stderrBad = { write: (c) => { errBad += c; } };
    const mockExecuteBadControllers = async (spec, io) => {
      if (spec.command === "podman") {
        if (spec.args?.includes("--version") || spec.args?.includes("version")) return 0;
        if (spec.args?.includes("info")) {
          io?.stdout?.write(JSON.stringify({
            version: { Version: "5.0.0" },
            host: {
              security: { rootless: true },
              cgroupVersion: "v2",
              cgroupControllers: ["cpu"]
            }
          }));
          return 0;
        }
      }
      return 0;
    };

    const codeBad = await run(["doctor"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: { write() {} },
      stderr: stderrBad,
      execute: mockExecuteBadControllers,
      inspectResources: async () => ({
        cpuCount: 4,
        totalMemoryBytes: 8 * 1024 ** 3,
        freeDiskBytes: 20 * 1024 ** 3
      })
    });
    assert.equal(codeBad, 1);
    assert.match(errBad, /FAIL Cgroup controller delegation: missing required controllers: memory, pids/);

    // Case 3: Rootful mode fails
    let errRootful = "";
    const stderrRootful = { write: (c) => { errRootful += c; } };
    const mockExecuteRootful = async (spec, io) => {
      if (spec.command === "podman") {
        if (spec.args?.includes("--version") || spec.args?.includes("version")) return 0;
        if (spec.args?.includes("info")) {
          io?.stdout?.write(JSON.stringify({
            version: { Version: "5.0.0" },
            host: {
              security: { rootless: false },
              cgroupVersion: "v2",
              cgroupControllers: ["cpu", "memory", "pids"]
            }
          }));
          return 0;
        }
      }
      return 0;
    };

    const codeRootful = await run(["doctor"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: { write() {} },
      stderr: stderrRootful,
      execute: mockExecuteRootful,
      inspectResources: async () => ({
        cpuCount: 4,
        totalMemoryBytes: 8 * 1024 ** 3,
        freeDiskBytes: 20 * 1024 ** 3
      })
    });
    assert.equal(codeRootful, 1);
    assert.match(errRootful, /FAIL Podman mode: rootful/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install with --engine podman initializes rootless Podman engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  try {
    let out = "";
    const stdout = { write: (c) => { out += c; } };
    const stderr = { write: () => {} };
    let ensurePodmanCalled = false;
    let ensureDockerCalled = false;

    const code = await run(["install", "--engine", "podman", "--no-open", "--non-interactive", "--answers", JSON.stringify({
      confirm: true,
      profile: "small",
      access: "isolated",
      companions: false,
      telemetry: false,
      open: false
    })], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout,
      stderr,
      execute: async (spec, io) => {
        if (spec.args?.includes("pg_dump")) {
          io?.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
        }
        return 0;
      },
      inspectResources: async () => ({
        cpuCount: 4,
        totalMemoryBytes: 8 * 1024 ** 3,
        freeDiskBytes: 20 * 1024 ** 3
      }),
      ensurePodman: async () => {
        ensurePodmanCalled = true;
        return { code: 0, reexecuted: false };
      },
      ensureDocker: async () => {
        ensureDockerCalled = true;
        return { code: 0, reexecuted: false };
      },
      request: readyUnclaimedRequest,
      sleep: async () => {}
    });

    assert.equal(code, 0);
    assert.equal(ensurePodmanCalled, true, "ensurePodman must be called");
    assert.equal(ensureDockerCalled, false, "ensureDocker must NOT be called");

    const savedConfig = await loadConfig(root);
    assert.equal(savedConfig.engine, "podman");
    assert.match(out, /Container engine: podman/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install with --answers specifying engine: podman initializes Podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-answers-"));
  try {
    let ensurePodmanCalled = false;
    const code = await run(["install", "--no-open", "--non-interactive", "--answers", JSON.stringify({
      confirm: true,
      profile: "small",
      access: "isolated",
      engine: "podman",
      companions: false,
      telemetry: false,
      open: false
    })], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: { write() {} },
      stderr: { write() {} },
      execute: async (spec, io) => {
        if (spec.args?.includes("pg_dump")) {
          io?.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
        }
        return 0;
      },
      inspectResources: async () => ({
        cpuCount: 4,
        totalMemoryBytes: 8 * 1024 ** 3,
        freeDiskBytes: 20 * 1024 ** 3
      }),
      ensurePodman: async () => {
        ensurePodmanCalled = true;
        return { code: 0, reexecuted: false };
      },
      request: readyUnclaimedRequest,
      sleep: async () => {}
    });

    assert.equal(code, 0);
    assert.equal(ensurePodmanCalled, true);
    const savedConfig = await loadConfig(root);
    assert.equal(savedConfig.engine, "podman");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("factory-reset preserves configured engine: podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-reset-"));
  try {
    const res = await prepareInstallation(root, {
      version: "1.1.5",
      profile: "small",
      accessMode: "isolated",
      engine: "podman"
    });
    await commitInstallation(root, res.config);
    await writeRuntimeFiles(root, res.config);

    let out = "";
    const code = await run(["factory-reset"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: { write: (c) => { out += c; } },
      stderr: { write() {} },
      stdin: {
        isTTY: true,
        setRawMode() {},
        resume() {},
        pause() {},
        [Symbol.asyncIterator]: async function* () {
          yield "FACTORY-RESET\n";
        }
      },
      execute: async () => 0
    });

    assert.equal(code, 0);
    assert.match(out, /factory reset complete/);
    const resetConfig = await loadConfig(root);
    assert.equal(resetConfig.engine, "podman", "factory-reset must preserve podman engine");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("support-bundle includes sanitized container engine details", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-bundle-"));
  try {
    const res = await prepareInstallation(root, {
      version: "1.1.5",
      profile: "small",
      accessMode: "isolated",
      engine: "podman"
    });
    await commitInstallation(root, res.config);
    await writeRuntimeFiles(root, res.config);

    let bundleJson = "";
    const mockExecute = async (spec, io) => {
      if (spec.command === "podman") {
        if (spec.args?.includes("info")) {
          io?.stdout?.write(JSON.stringify({
            version: { Version: "5.0.0" },
            host: {
              security: { rootless: true },
              cgroupVersion: "v2",
              cgroupControllers: ["cpu", "memory", "pids"]
            }
          }));
          return 0;
        }
      }
      return 0;
    };

    const outPath = join(root, "bundle.json");
    const code = await run(["support-bundle", "--out", outPath], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      arch: "x64",
      stdout: { write() {} },
      stderr: { write() {} },
      execute: mockExecute
    });

    assert.equal(code, 0);
    const bundle = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(bundle.engine?.name, "podman");
    assert.equal(bundle.engine?.rootless, true);
    assert.equal(bundle.engine?.cgroupVersion, "v2");
    assert.deepEqual(bundle.engine?.cgroupControllers, ["cpu", "memory", "pids"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
