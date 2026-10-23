import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { ensureDockerAvailable } from "../src/prerequisites.mjs";
import {
  addWorkspace,
  assertEngineNotSwitched,
  composeCommand,
  composeProjectName,
  initializeInstallation,
  loadConfig,
  parseEngineInfo,
  podmanMachineResizeHint,
  prepareInstallation,
  renderWorkspaceCompose,
  resolveContainerEngine,
  saveConfig,
  writeRuntimeFiles
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

function ttyStdin(...answers) {
  let index = 0;
  let eventMode = false;
  const dataHandlers = [];
  const endHandlers = [];
  const keypressHandlers = [];
  const stream = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on(event, handler) {
      if (event === "data") {
        dataHandlers.push(handler);
        if (!eventMode) {
          eventMode = true;
          queueMicrotask(() => deliverEvents());
        }
      } else if (event === "end") {
        endHandlers.push(handler);
      } else if (event === "keypress") {
        keypressHandlers.push(handler);
        if (!eventMode) {
          eventMode = true;
          queueMicrotask(() => deliverEvents());
        }
      }
      return stream;
    },
    once(event, handler) {
      if (event === "data" || event === "end" || event === "keypress") {
        stream.on(event, handler);
      }
      return stream;
    },
    removeListener() {
      return stream;
    },
    off() {
      return stream;
    },
    listenerCount(event) {
      if (event === "data") {
        return dataHandlers.length;
      }
      if (event === "end") {
        return endHandlers.length;
      }
      if (event === "keypress") {
        return keypressHandlers.length;
      }
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
  function deliverEvents() {
    while (index < answers.length) {
      const answer = answers[index];
      index += 1;
      if (keypressHandlers.length > 0) {
        for (const character of answer) {
          for (const handler of [...keypressHandlers]) {
            handler({ sequence: character, name: undefined, ctrl: false, meta: false, shift: false });
          }
        }
        for (const handler of [...keypressHandlers]) {
          handler({ sequence: "\r", name: "return", ctrl: false, meta: false, shift: false });
        }
      } else {
        for (const handler of [...dataHandlers]) {
          handler(`${answer}\n`);
        }
      }
    }
    for (const handler of [...endHandlers]) {
      handler();
    }
  }
  return stream;
}

const FRESH_APPROVALS = ["", "", "", "", "", "y"];

const ROOTLESS_PODMAN_INFO = JSON.stringify({
  version: {
    Version: "5.3.1"
  },
  host: {
    arch: "amd64",
    cpus: 8,
    memTotal: 16 * 1024 ** 3,
    cgroupVersion: "v2",
    cgroupControllers: ["cpu", "memory", "pids"],
    security: {
      rootless: true,
      selinuxEnabled: true
    }
  },
  store: {
    graphRoot: "/home/user/.local/share/containers/storage",
    graphRootAllocated: 64 * 1024 ** 3,
    graphRootUsed: 4 * 1024 ** 3
  }
});

const LARGE_HOST_RESOURCES = Object.freeze({
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 30 * 1024 ** 3
});

async function readyUnclaimedRequest(url) {
  if (String(url).endsWith("/readyz")) {
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      }
    };
  }
  if (String(url).endsWith("/api/setup/status")) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          setupRequired: true,
          expiresAt: "2026-10-17T22:00:00.000Z"
        };
      }
    };
  }
  throw new Error(`Unexpected request URL: ${url}`);
}

test("resolveContainerEngine validates engine names and defaults to docker", () => {
  assert.equal(resolveContainerEngine(), "docker");
  assert.equal(resolveContainerEngine("docker"), "docker");
  assert.equal(resolveContainerEngine("podman"), "podman");
  assert.equal(resolveContainerEngine(undefined, "podman"), "podman");
  assert.throws(
    () => resolveContainerEngine("containerd"),
    /Container engine must be docker or podman/
  );
});

test("parseEngineInfo extracts version, rootless mode, cgroup v2, and limit delegation for Podman and Docker", () => {
  const podmanRootless = parseEngineInfo({
    engine: "podman",
    infoOutput: ROOTLESS_PODMAN_INFO
  });
  assert.equal(podmanRootless.engine, "podman");
  assert.equal(podmanRootless.version, "5.3.1");
  assert.equal(podmanRootless.rootless, true);
  assert.equal(podmanRootless.mode, "rootless");
  assert.equal(podmanRootless.cgroupVersion, "v2");
  assert.deepEqual(podmanRootless.cgroupControllers, ["cpu", "memory", "pids"]);
  assert.equal(podmanRootless.limitsDelegated.cpu, true);
  assert.equal(podmanRootless.limitsDelegated.memory, true);
  assert.equal(podmanRootless.ok, true);

  const podmanMissingCpu = parseEngineInfo({
    engine: "podman",
    versionOutput: "podman version 5.2.0",
    infoOutput: JSON.stringify({
      host: {
        cgroupVersion: "v2",
        cgroupControllers: ["memory", "pids"],
        security: { rootless: true }
      }
    })
  });
  assert.equal(podmanMissingCpu.limitsDelegated.cpu, false);
  assert.equal(podmanMissingCpu.limitsDelegated.memory, true);
  assert.equal(podmanMissingCpu.ok, false);

  const podmanCgroupV1 = parseEngineInfo({
    engine: "podman",
    versionOutput: "podman version 5.2.0",
    infoOutput: JSON.stringify({
      host: {
        cgroupVersion: "v1",
        security: { rootless: true }
      }
    })
  });
  assert.equal(podmanCgroupV1.cgroupVersion, "v1");
  assert.equal(podmanCgroupV1.ok, false);

  const dockerInfo = parseEngineInfo({
    engine: "docker",
    infoOutput: JSON.stringify({
      ServerVersion: "27.3.1",
      CgroupVersion: "2",
      SecurityOptions: ["name=seccomp,profile=builtin"],
      CPUShares: true,
      CPUSet: true,
      MemoryLimit: true
    })
  });
  assert.equal(dockerInfo.engine, "docker");
  assert.equal(dockerInfo.version, "27.3.1");
  assert.equal(dockerInfo.rootless, false);
  assert.equal(dockerInfo.mode, "rootful");
  assert.equal(dockerInfo.cgroupVersion, "v2");
  assert.equal(dockerInfo.ok, true);
});

test("composeCommand and prepareInstallation construct podman compose commands and SELinux keep-id workspace mounts", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "spaceapp-podman-compose-"));
  const repoRw = join(homeDir, "repo-rw");
  const repoRo = join(homeDir, "repo-ro");
  await mkdir(repoRw, { recursive: true });
  await mkdir(repoRo, { recursive: true });

  try {
    const prepared = await prepareInstallation(homeDir, {
      version: RUNTIME_VERSION,
      engine: "podman",
      profile: "large"
    });
    assert.equal(prepared.config.engine, "podman");

    let updatedConfig = await addWorkspace(prepared.config, repoRw);
    updatedConfig = await addWorkspace(updatedConfig, repoRo, { readOnly: true });
    await saveConfig(homeDir, updatedConfig);
    await writeRuntimeFiles(homeDir, updatedConfig);

    const reloadedConfig = await loadConfig(homeDir);
    assert.equal(reloadedConfig.engine, "podman");

    const workspaceCompose = await readFile(join(homeDir, "compose.workspaces.yml"), "utf8");
    assert.match(workspaceCompose, /user: "0:0"/);
    assert.match(workspaceCompose, /userns_mode: "keep-id:uid=10001,gid=10001"/);
    assert.match(workspaceCompose, /\.\/backups:\/backups:z/);
    assert.match(workspaceCompose, /\.\/secrets\/providers:\/run\/spaceapp-secrets\/providers:ro,z/);
    assert.match(
      workspaceCompose,
      /target: "\/workspaces\/repo-rw"\n\s+read_only: false\n\s+bind:\n\s+selinux: z/
    );
    assert.match(
      workspaceCompose,
      /target: "\/workspaces\/repo-ro"\n\s+read_only: true\n\s+bind:\n\s+selinux: z/
    );

    const dockerComposeText = renderWorkspaceCompose({
      ...reloadedConfig,
      engine: "docker"
    });
    assert.doesNotMatch(dockerComposeText, /userns_mode:/);
    assert.doesNotMatch(dockerComposeText, /selinux: z/);
    assert.doesNotMatch(dockerComposeText, /:\/backups:z/);

    for (const profile of ["small", "medium", "large"]) {
      const cmd = composeCommand("up", homeDir, {
        engine: "podman",
        profile
      });
      assert.equal(cmd.command, "podman");
      assert.deepEqual(cmd.args.slice(0, 3), ["compose", "--project-name", composeProjectName(homeDir)]);
      assert.ok(cmd.args.includes(join(homeDir, "compose.yml")));
      assert.ok(cmd.args.includes(join(homeDir, "compose.workspaces.yml")));
      assert.ok(cmd.args.includes(join(homeDir, "compose.host-access.yml")));
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("ensureDockerAvailable validates Podman 5+, cgroup v2 delegation, and interactive Podman fallback when Docker is missing", async () => {
  const stdout = capture();
  const stderr = capture();

  // 1. Refuse Podman on Windows
  const winResult = await ensureDockerAvailable({
    installArgs: { requestedEngine: "podman" },
    platform: "win32",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async () => 0
  });
  assert.equal(winResult.code, 1);
  assert.match(stderr.value(), /Podman is not supported on Windows/);

  // 2. Reject Podman < 5
  const oldPodmanErr = capture();
  const oldPodmanRes = await ensureDockerAvailable({
    installArgs: { requestedEngine: "podman" },
    platform: "linux",
    stdout: stdout.stream,
    stderr: oldPodmanErr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout?.write("podman version 4.9.3\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stdout?.write(JSON.stringify({ version: { Version: "4.9.3" } }));
        return 0;
      }
      return 0;
    }
  });
  assert.equal(oldPodmanRes.code, 1);
  assert.match(oldPodmanErr.value(), /Podman >= 5 is required/);

  // 3. Reject rootless Podman without delegated CPU/memory controllers
  const undelegatedErr = capture();
  const undelegatedRes = await ensureDockerAvailable({
    installArgs: { requestedEngine: "podman" },
    platform: "linux",
    stdout: stdout.stream,
    stderr: undelegatedErr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout?.write("podman version 5.3.1\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stdout?.write(
          JSON.stringify({
            version: { Version: "5.3.1" },
            host: {
              cgroupVersion: "v2",
              cgroupControllers: ["pids"],
              security: { rootless: true }
            }
          })
        );
        return 0;
      }
      return 0;
    }
  });
  assert.equal(undelegatedRes.code, 1);
  assert.match(undelegatedErr.value(), /Delegate cpu and memory controllers/);

  // 4. Interactive fallback: Docker is missing on Linux, Podman 5+ is ready, user accepts Podman
  const fallbackOut = capture();
  const fallbackErr = capture();
  const fallbackStdin = Readable.from(["y\n"]);
  fallbackStdin.isTTY = true;
  const fallbackRes = await ensureDockerAvailable({
    platform: "linux",
    stdin: fallbackStdin,
    stdout: fallbackOut.stream,
    stderr: fallbackErr.stream,
    execute: async (spec, io) => {
      if (spec.command === "docker") {
        return 127;
      }
      if (spec.command === "podman") {
        if (spec.args[0] === "--version") {
          io.stdout?.write("podman version 5.3.1\n");
          return 0;
        }
        if (spec.args[0] === "info") {
          io.stdout?.write(ROOTLESS_PODMAN_INFO);
          return 0;
        }
        return 0;
      }
      return 0;
    }
  });
  assert.equal(fallbackRes.code, 0);
  assert.equal(fallbackRes.engine, "podman");
  assert.match(fallbackOut.value(), /Podman is ready on this host/);
});

test("install --engine podman on Windows is refused with a clear error message", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "spaceapp-podman-win32-"));
  try {
    await assert.rejects(
      () =>
        run(["install", "--engine", "podman", "--no-open"], {
          env: { SPACEAPP_HOME: homeDir },
          platform: "win32",
          stdin: ttyStdin(...FRESH_APPROVALS),
          stdout: capture().stream,
          stderr: capture().stream,
          execute: async () => 0
        }),
      /Podman is not supported on Windows/
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("switching engines on an existing installation and --access host-root on Podman are refused clearly", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "spaceapp-podman-safety-"));
  try {
    await initializeInstallation(homeDir, {
      version: RUNTIME_VERSION,
      engine: "docker",
      profile: "small"
    });

    assert.throws(
      () => assertEngineNotSwitched({ engine: "docker" }, "podman"),
      /Docker volumes are not visible to Podman[\s\S]*backup[\s\S]*restore/
    );

    await assert.rejects(
      () =>
        run(["install", "--engine", "podman", "--no-open"], {
          env: { SPACEAPP_HOME: homeDir },
          platform: "linux",
          stdin: ttyStdin(...FRESH_APPROVALS),
          stdout: capture().stream,
          stderr: capture().stream,
          execute: async () => 0
        }),
      /Docker volumes are not visible to Podman[\s\S]*backup[\s\S]*restore/
    );

    await assert.rejects(
      () =>
        run(["install", "--engine", "podman", "--access", "host-root", "--no-open"], {
          env: { SPACEAPP_HOME: join(homeDir, "fresh") },
          platform: "linux",
          stdin: ttyStdin(...FRESH_APPROVALS),
          stdout: capture().stream,
          stderr: capture().stream,
          execute: async () => 0
        }),
      /--access host-root.*not supported with Podman/i
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("macOS podman machine resource checks explain how to resize CPU, memory, and disk", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "spaceapp-podman-macos-"));
  try {
    const hint = podmanMachineResizeHint("small");
    assert.match(
      hint,
      /podman machine stop && podman machine set --cpus 4 --memory 8192 --disk-size 20 && podman machine start/
    );

    const undersizedInfo = JSON.stringify({
      version: { Version: "5.3.1" },
      host: {
        arch: "arm64",
        cpus: 2,
        memTotal: 2 * 1024 ** 3,
        cgroupVersion: "v2",
        cgroupControllers: ["cpu", "memory", "pids"],
        security: { rootless: true }
      },
      store: {
        graphRoot: "/var/home/core/.local/share/containers/storage",
        graphRootAllocated: 4 * 1024 ** 3,
        graphRootUsed: 3.8 * 1024 ** 3
      }
    });

    await initializeInstallation(homeDir, {
      version: RUNTIME_VERSION,
      engine: "podman",
      profile: "small"
    });

    const docOut = capture();
    const docErr = capture();
    const docCode = await run(["doctor"], {
      env: { SPACEAPP_HOME: homeDir },
      platform: "darwin",
      stdout: docOut.stream,
      stderr: docErr.stream,
      inspectResources: async () => LARGE_HOST_RESOURCES,
      execute: async (spec, io) => {
        assert.equal(spec.command, "podman");
        if (spec.args[0] === "--version") {
          io.stdout?.write("podman version 5.3.1\n");
          return 0;
        }
        if (spec.args[0] === "info") {
          io.stdout?.write(undersizedInfo);
          return 0;
        }
        return 0;
      }
    });
    assert.equal(docCode, 1);
    assert.match(docErr.value(), /FAIL Podman memory:/);
    assert.match(docErr.value(), /FAIL Podman CPU:/);
    assert.match(docErr.value(), /FAIL Podman disk:/);
    assert.match(
      docErr.value(),
      /podman machine stop && podman machine set --cpus 4 --memory 8192 --disk-size 20 && podman machine start/
    );

    // Properly sized podman machine on macOS succeeds with install --engine podman --profile small
    const macInstallHome = join(homeDir, "install-ok");
    const installOut = capture();
    const installErr = capture();
    const installCode = await run(
      ["install", "--engine", "podman", "--profile", "small", "--no-open"],
      {
        env: { SPACEAPP_HOME: macInstallHome },
        platform: "darwin",
        stdin: ttyStdin(...FRESH_APPROVALS),
        stdout: installOut.stream,
        stderr: installErr.stream,
        inspectResources: async () => LARGE_HOST_RESOURCES,
        request: readyUnclaimedRequest,
        sleep: async () => {},
        execute: async (spec, io) => {
          assert.equal(spec.command, "podman");
          if (spec.args[0] === "--version") {
            io.stdout?.write("podman version 5.3.1\n");
            return 0;
          }
          if (spec.args[0] === "info") {
            io.stdout?.write(ROOTLESS_PODMAN_INFO);
            return 0;
          }
          return 0;
        }
      }
    );
    assert.equal(installCode, 0, installErr.value());
    const savedMacConfig = await loadConfig(macInstallHome);
    assert.equal(savedMacConfig.engine, "podman");
    assert.equal(savedMacConfig.profile, "small");
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("doctor and support-bundle report Podman engine, version, rootless mode, cgroup version, and limit delegation without secrets", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  try {
    await initializeInstallation(homeDir, {
      version: RUNTIME_VERSION,
      engine: "podman",
      profile: "small"
    });

    const docOut = capture();
    const docErr = capture();
    const docCode = await run(["doctor"], {
      env: { SPACEAPP_HOME: homeDir },
      platform: "linux",
      stdout: docOut.stream,
      stderr: docErr.stream,
      inspectResources: async () => LARGE_HOST_RESOURCES,
      execute: async (spec, io) => {
        assert.equal(spec.command, "podman");
        if (spec.args[0] === "--version") {
          io.stdout?.write("podman version 5.3.1\n");
          return 0;
        }
        if (spec.args[0] === "info") {
          io.stdout?.write(ROOTLESS_PODMAN_INFO);
          return 0;
        }
        return 0;
      }
    });
    assert.equal(docCode, 0, docErr.value());
    assert.match(docOut.value(), /PASS Podman CLI: available \(podman 5\.3\.1\)/);
    assert.match(docOut.value(), /PASS Podman Compose: available/);
    assert.match(
      docOut.value(),
      /PASS Podman Engine: available \(engine=podman, version=5\.3\.1, mode=rootless, cgroup=v2\)/
    );
    assert.match(
      docOut.value(),
      /PASS Container limits: CPU and memory limits delegated \(cpu=true, memory=true\)/
    );

    const bundlePath = join(homeDir, "support-bundle.json");
    const bundleOut = capture();
    const bundleErr = capture();
    const bundleCode = await run(["support-bundle", "--out", bundlePath], {
      env: { SPACEAPP_HOME: homeDir },
      platform: "linux",
      stdout: bundleOut.stream,
      stderr: bundleErr.stream,
      request: readyUnclaimedRequest,
      execute: async (spec, io) => {
        assert.equal(spec.command, "podman");
        if (spec.args[0] === "--version") {
          io.stdout?.write("podman version 5.3.1\n");
          return 0;
        }
        if (spec.args[0] === "info") {
          io.stdout?.write(ROOTLESS_PODMAN_INFO);
          return 0;
        }
        return 0;
      }
    });
    assert.equal(bundleCode, 0, bundleErr.value());
    const bundleRaw = await readFile(bundlePath, "utf8");
    const bundle = JSON.parse(bundleRaw);
    assert.equal(bundle.installation.config.engine, "podman");
    assert.equal(bundle.containerEngine.engine, "podman");
    assert.equal(bundle.containerEngine.version, "5.3.1");
    assert.equal(bundle.containerEngine.rootless, true);
    assert.equal(bundle.containerEngine.mode, "rootless");
    assert.equal(bundle.containerEngine.cgroupVersion, "v2");
    assert.equal(bundle.containerEngine.limitsDelegated.cpu, true);
    assert.equal(bundle.containerEngine.limitsDelegated.memory, true);
    assert.doesNotMatch(bundleRaw, /session-secret|setup-token/);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("Linux rootless Podman runs the full command lifecycle across small, medium, and large profiles", async () => {
  for (const profile of ["small", "medium", "large"]) {
    const homeDir = await mkdtemp(join(tmpdir(), `spaceapp-podman-${profile}-`));
    try {
      const invokedCommands = [];
      const mockExecute = async (spec, io) => {
        invokedCommands.push(spec);
        assert.equal(spec.command, "podman", `Expected podman, got ${spec.command} for profile ${profile}`);
        if (spec.args[0] === "--version") {
          io.stdout?.write("podman version 5.3.1\n");
          return 0;
        }
        if (spec.args[0] === "info") {
          io.stdout?.write(ROOTLESS_PODMAN_INFO);
          return 0;
        }
        if (spec.args.includes("pg_dump")) {
          io.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
          return 0;
        }
        return 0;
      };

      const baseOptions = {
        env: { SPACEAPP_HOME: homeDir },
        platform: "linux",
        inspectResources: async () => LARGE_HOST_RESOURCES,
        request: readyUnclaimedRequest,
        sleep: async () => {},
        execute: mockExecute
      };

      // 1. install --engine podman --profile <small|medium|large>
      const out = capture();
      const err = capture();
      assert.equal(
        await run(["install", "--engine", "podman", "--profile", profile, "--no-open"], {
          ...baseOptions,
          stdin: ttyStdin(...FRESH_APPROVALS),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );
      const cfg = await loadConfig(homeDir);
      assert.equal(cfg.engine, "podman");
      assert.equal(cfg.profile, profile);

      // 2. up, status, logs, down
      for (const subcmd of [["up"], ["status"], ["logs"], ["down"]]) {
        assert.equal(
          await run(subcmd, {
            ...baseOptions,
            stdout: out.stream,
            stderr: err.stream
          }),
          0,
          `Failed ${subcmd.join(" ")} on ${profile}: ${err.value()}`
        );
      }

      // 3. backup & restore
      await mkdir(join(homeDir, "backups", "spaceapp-backup-20261017T120000000Z"), {
        recursive: true
      });
      assert.equal(
        await run(["backup"], {
          ...baseOptions,
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );
      assert.equal(
        await run(["restore"], {
          ...baseOptions,
          stdin: Readable.from(["RESTORE\n"]),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );

      // 4. update (with checkpoint) & rollback
      await saveConfig(homeDir, { ...cfg, version: "1.1.0", previousVersion: null });
      assert.equal(
        await run(["update", RUNTIME_VERSION], {
          ...baseOptions,
          stdin: ttyStdin("y"),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );
      assert.equal(
        await run(["rollback"], {
          ...baseOptions,
          stdin: ttyStdin("y"),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );

      // 5. doctor, doctor --fix, repair
      assert.equal(
        await run(["doctor"], {
          ...baseOptions,
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );
      assert.equal(
        await run(["doctor", "--fix"], {
          ...baseOptions,
          stdin: ttyStdin("y"),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );
      assert.equal(
        await run(["repair"], {
          ...baseOptions,
          stdin: ttyStdin("y"),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );

      // 6. provider install opencode, credentials set, owner rotate-setup-token
      assert.equal(
        await run(["provider", "install", "opencode"], {
          ...baseOptions,
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );
      assert.equal(
        await run(["credentials", "set", "gemini"], {
          ...baseOptions,
          stdin: Readable.from(["sk-test-credential-value-123456\n"]),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );
      assert.equal(
        await run(["owner", "rotate-setup-token"], {
          ...baseOptions,
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );

      // 7. uninstall & uninstall --purge-data
      assert.equal(
        await run(["uninstall"], {
          ...baseOptions,
          stdin: ttyStdin("y"),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );
      assert.equal(
        await run(["uninstall", "--purge-data"], {
          ...baseOptions,
          stdin: Readable.from(["DELETE\n"]),
          stdout: out.stream,
          stderr: err.stream
        }),
        0,
        err.value()
      );

      assert.ok(invokedCommands.length > 0);
      assert.ok(invokedCommands.every((spec) => spec.command === "podman"));
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  }
});
