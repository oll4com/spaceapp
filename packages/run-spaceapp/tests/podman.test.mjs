import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import {
  addWorkspace,
  composeCommand,
  createDefaultConfig,
  installResourceChecks,
  loadConfig,
  renderWorkspaceCompose,
  resolveInstallEngine,
  saveConfig,
  userSlug,
  validateConfig
} from "../src/index.mjs";
import {
  ensurePodmanApiService,
  ensurePodmanAvailable,
  inspectPodmanEnvironment,
  podmanApiServiceHelp,
  podmanApiServiceReady,
  podmanInstallInstructions
} from "../src/prerequisites.mjs";
import { inspectStoragePlan, storageChecks } from "../src/storage.mjs";

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
      if (event === "data") return dataHandlers.length;
      if (event === "end") return endHandlers.length;
      if (event === "keypress") return keypressHandlers.length;
      return 0;
    },
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) return { done: true };
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

async function readyUnclaimedRequest(url) {
  if (url.endsWith("/readyz")) {
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      }
    };
  }
  if (url.endsWith("/api/setup/status")) {
    return {
      ok: true,
      status: 200,
      async json() {
        return { setupRequired: true, expiresAt: null };
      }
    };
  }
  throw new Error(`Unexpected request URL: ${url}`);
}

const VALID_PODMAN_INFO = JSON.stringify({
  host: {
    arch: "amd64",
    cpus: 8,
    memTotal: 16 * 1024 ** 3,
    cgroupVersion: "v2",
    cgroupControllers: ["cpu", "memory", "pids"],
    security: {
      rootless: true
    }
  },
  store: {
    graphDriverName: "overlay",
    graphRoot: "/home/user/.local/share/containers/storage"
  },
  version: {
    Version: "5.3.0"
  }
});

test("composeCommand builds podman compose invocations across all lifecycle actions", () => {
  const root = "/tmp/spaceapp-podman-test";
  const actions = [
    ["up", {}, ["up", "-d", "--remove-orphans"]],
    ["down", {}, ["down"]],
    ["status", {}, ["ps"]],
    ["logs", { lines: 100 }, ["logs", "--tail", "100"]],
    ["pull", {}, ["pull"]],
    ["syncCredentials", {}, ["up", "-d", "--no-deps", "--force-recreate", "spaceapp-cli"]],
    ["backup", {}, [
      "run", "--rm", "--no-deps", "--user", "0:0",
      "--env", "SPACE_DATABASE_URL_FILE=/run/secrets/database-url",
      "--entrypoint", "node", "spaceapp-core", "scripts/portable-backup.mjs"
    ]],
    ["pauseWriters", {}, ["pause", "spaceapp-core", "spaceapp-cli", "spaceapp-browser", "temporal"]],
    ["unpauseWriters", {}, ["unpause", "spaceapp-core", "spaceapp-cli", "spaceapp-browser", "temporal"]],
    ["stopForRestore", {}, ["stop", "spaceapp-core", "spaceapp-cli", "spaceapp-browser"]],
    ["stopForPortableRestore", {}, ["stop", "spaceapp-core", "spaceapp-cli", "spaceapp-browser", "temporal"]],
    ["restore", { backupId: "spaceapp-backup-20261016T120000000Z" }, [
      "run", "--rm", "--no-deps", "--user", "0:0",
      "--env", "SPACE_DATABASE_URL_FILE=/run/secrets/database-url",
      "--entrypoint", "node", "spaceapp-core", "scripts/portable-restore.mjs",
      "--input", "/backups",
      "--backup-id", "spaceapp-backup-20261016T120000000Z",
      "--confirm", "RESTORE"
    ]],
    ["purge", {}, ["down", "--volumes", "--remove-orphans"]],
    ["repair", {}, ["up", "-d", "--remove-orphans", "--force-recreate"]],
    ["ensureCheckpointDatabase", {}, ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "postgres"]],
    ["checkpointDump", {}, ["exec", "-T", "postgres", "pg_dump", "-c", "--if-exists", "-U", "spaceapp", "-d", "spaceapp"]],
    ["checkpointRestore", {}, ["exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "spaceapp", "-d", "spaceapp"]]
  ];

  for (const [action, extraOptions, expectedTail] of actions) {
    const spec = composeCommand(action, root, { engine: "podman", ...extraOptions });
    assert.equal(spec.command, "podman");
    assert.equal(spec.args[0], "compose");
    assert.deepEqual(spec.args.slice(-expectedTail.length), expectedTail);
  }
});

test("renderWorkspaceCompose emits SELinux z label only for podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-workspace-"));
  const wsDir = join(root, "project-alpha");
  await mkdir(wsDir, { recursive: true });

  const basePodman = createDefaultConfig({
    version: RUNTIME_VERSION,
    profile: "small",
    engine: "podman"
  });
  const emptyPodman = renderWorkspaceCompose(basePodman);
  assert.doesNotMatch(emptyPodman, /selinux/);

  const withWorkspacePodman = await addWorkspace(basePodman, wsDir, { readOnly: false });
  const populatedPodman = renderWorkspaceCompose(withWorkspacePodman);
  assert.match(populatedPodman, /bind:\n {10}selinux: z/);
  assert.match(populatedPodman, /read_only: false/);

  await assert.rejects(
    () => addWorkspace(basePodman, "/", { readOnly: false }),
    /protected system or home directory/i
  );

  const baseDocker = createDefaultConfig({
    version: RUNTIME_VERSION,
    profile: "small",
    engine: "docker"
  });
  const withWorkspaceDocker = await addWorkspace(baseDocker, wsDir, { readOnly: false });
  const populatedDocker = renderWorkspaceCompose(withWorkspaceDocker);
  assert.doesNotMatch(populatedDocker, /userns_mode/);
  assert.doesNotMatch(populatedDocker, /selinux/);
});

test("config validation persists engine, rejects invalid engine or podman host-root, and blocks engine switching", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-config-"));

  const podmanConfig = createDefaultConfig({
    version: RUNTIME_VERSION,
    profile: "small",
    engine: "podman"
  });
  assert.equal(podmanConfig.engine, "podman");
  await saveConfig(root, podmanConfig);
  const loaded = await loadConfig(root);
  assert.equal(loaded.engine, "podman");

  assert.throws(
    () => validateConfig({ ...podmanConfig, engine: "containerd" }),
    /engine must be docker or podman/
  );
  assert.throws(
    () => validateConfig({ ...podmanConfig, accessMode: "host-root" }),
    /Host-root access is not supported on Podman/
  );

  assert.equal(
    resolveInstallEngine("podman", "docker", { existingInstallation: false }),
    "podman"
  );
  assert.equal(
    resolveInstallEngine(undefined, "podman", { existingInstallation: true }),
    "podman"
  );
  assert.throws(
    () => resolveInstallEngine("docker", "podman", { existingInstallation: true }),
    /Cannot switch container engine from podman to docker on an existing installation[\s\S]*run-spaceapp@latest backup[\s\S]*run-spaceapp@latest uninstall --purge-data[\s\S]*--engine docker[\s\S]*run-spaceapp@latest restore/
  );
});

test("inspectPodmanEnvironment verifies Podman >= 5, native compose v2, rootless mode, cgroup v2, and CPU/memory delegation", async () => {
  const validProbe = await inspectPodmanEnvironment({
    execute: async (spec, io) => {
      assert.equal(spec.command, "podman");
      if (spec.args[0] === "--version") {
        io.stdout.write("podman version 5.3.1\n");
        return 0;
      }
      if (spec.args[0] === "compose" && spec.args[1] === "version") {
        io.stderr.write('>>>> Executing external compose provider "/usr/libexec/docker/cli-plugins/docker-compose". Please see podman-compose(1) for how to disable this message. <<<<\n');
        io.stdout.write("Docker Compose version v2.29.7\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stdout.write(VALID_PODMAN_INFO);
        return 0;
      }
      return 1;
    }
  });
  assert.equal(validProbe.cliOk, true);
  assert.equal(validProbe.versionOk, true);
  assert.equal(validProbe.composeOk, true);
  assert.equal(validProbe.infoOk, true);
  assert.equal(validProbe.version, "5.3.1");
  assert.equal(validProbe.rootless, true);
  assert.equal(validProbe.cgroupVersion, "v2");
  assert.equal(validProbe.cpuDelegated, true);
  assert.equal(validProbe.memoryDelegated, true);
  assert.equal(validProbe.limitsDelegated, true);

  // Rejects Podman 4.x
  const podman4Probe = await inspectPodmanEnvironment({
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout.write("podman version 4.9.3\n");
        return 0;
      }
      return 0;
    }
  });
  assert.equal(podman4Probe.versionOk, false);
  assert.equal(podman4Probe.majorVersion, 4);

  // Rejects Python podman-compose provider
  const pythonComposeProbe = await inspectPodmanEnvironment({
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout.write("podman version 5.2.0\n");
        return 0;
      }
      if (spec.args[0] === "compose") {
        io.stdout.write("podman-compose version 1.0.6\n");
        return 0;
      }
      return 0;
    }
  });
  assert.equal(pythonComposeProbe.composeOk, false);
  assert.equal(pythonComposeProbe.unsupportedCompose, true);

  // Rejects rootful Podman on Linux via ensurePodmanAvailable
  const rootfulStderr = capture();
  const rootfulRes = await ensurePodmanAvailable({
    platform: "linux",
    stderr: rootfulStderr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout.write("podman version 5.2.0\n");
        return 0;
      }
      if (spec.args[0] === "compose") {
        io.stdout.write("Docker Compose version v2.29.2\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stdout.write(JSON.stringify({
          host: {
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory"],
            security: { rootless: false }
          }
        }));
        return 0;
      }
      return 0;
    }
  });
  assert.equal(rootfulRes.code, 1);
  assert.match(rootfulStderr.value(), /requires rootless Podman on Linux/);

  // Rejects cgroup v1 on Linux
  const cgroupV1Stderr = capture();
  const cgroupV1Res = await ensurePodmanAvailable({
    platform: "linux",
    stderr: cgroupV1Stderr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout.write("podman version 5.2.0\n");
        return 0;
      }
      if (spec.args[0] === "compose") {
        io.stdout.write("Docker Compose version v2.29.2\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stdout.write(JSON.stringify({
          host: {
            cgroupVersion: "v1",
            cgroupControllers: ["cpu", "memory"],
            security: { rootless: true }
          }
        }));
        return 0;
      }
      return 0;
    }
  });
  assert.equal(cgroupV1Res.code, 1);
  assert.match(cgroupV1Stderr.value(), /requires cgroup v2/);

  // Rejects undelegated CPU/memory controllers on Linux
  const undelegatedStderr = capture();
  const undelegatedRes = await ensurePodmanAvailable({
    platform: "linux",
    stderr: undelegatedStderr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout.write("podman version 5.2.0\n");
        return 0;
      }
      if (spec.args[0] === "compose") {
        io.stdout.write("Docker Compose version v2.29.2\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stdout.write(JSON.stringify({
          host: {
            cgroupVersion: "v2",
            cgroupControllers: ["pids"],
            security: { rootless: true }
          }
        }));
        return 0;
      }
      return 0;
    }
  });
  assert.equal(undelegatedRes.code, 1);
  assert.match(undelegatedStderr.value(), /requires delegated CPU and memory cgroup v2 controllers/);
});

test("ensurePodmanAvailable checks macOS podman machine and prints manual install instructions without auto-installing", async () => {
  const stderr = capture();
  const res = await ensurePodmanAvailable({
    platform: "darwin",
    stderr: stderr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout.write("podman version 5.2.2\n");
        return 0;
      }
      if (spec.args[0] === "compose") {
        io.stdout.write("Docker Compose version v2.29.2\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stderr.write("Cannot connect to Podman socket\n");
        return 1;
      }
      return 1;
    }
  });
  assert.equal(res.code, 1);
  assert.match(stderr.value(), /podman machine init --cpus 4 --memory 4096 --disk-size 20 && podman machine start/);
  assert.match(podmanInstallInstructions("linux", { ID: "fedora" }), /sudo dnf install -y podman docker-compose/);
  assert.match(podmanInstallInstructions("linux", { ID: "ubuntu" }), /sudo apt-get update && sudo apt-get install -y podman/);
  assert.match(podmanInstallInstructions("darwin", {}), /brew install podman docker-compose/);
});

test("inspectStoragePlan and installResourceChecks use podman, accept raw 64-hex image IDs, and verify macOS podman machine CPU, memory, and disk capacity", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-storage-"));
  const commands = [];
  const rawHexId = "a".repeat(64);
  const config = createDefaultConfig({
    version: RUNTIME_VERSION,
    profile: "small",
    engine: "podman"
  });
  const hostResources = {
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeDiskBytes: 30 * 1024 ** 3
  };
  // Case 1: Insufficient macOS Podman machine CPU, memory, and disk capacity
  const plan = await inspectStoragePlan({
    root,
    config,
    operation: "fresh",
    platform: "darwin",
    resources: hostResources,
    execute: async (spec, io) => {
      commands.push(`${spec.command} ${spec.args.join(" ")}`);
      if (spec.args[0] === "info") {
        io.stdout.write(JSON.stringify({
          host: {
            arch: "amd64",
            cpus: 2,
            memTotal: 2 * 1024 ** 3
          },
          store: {
            graphDriverName: "overlay",
            graphRoot: "/var/lib/containers/storage"
          }
        }));
        return 0;
      }
      if (spec.args[0] === "machine" && spec.args[1] === "ssh") {
        // 200 MiB total, 100 MiB free (insufficient for 512 MiB fresh reserve)
        io.stdout.write("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 204800 102400 102400 50% /var/lib/containers/storage\n");
        return 0;
      }
      if (spec.args[0] === "image" && spec.args[1] === "inspect") {
        io.stdout.write(`${rawHexId}\n`);
        return 0;
      }
      return 0;
    }
  });

  assert.equal(plan.engine, "podman");
  assert.ok(commands.every((cmd) => cmd.startsWith("podman ")));
  assert.ok(commands.includes("podman machine ssh df -Pk /var/lib/containers/storage"));
  assert.equal(plan.missingImages.length, 0);
  assert.equal(plan.resources.engineCpuCount, 2);
  assert.equal(plan.resources.engineDiskBytes, 200 * 1024 ** 2);
  assert.equal(plan.dockerFreeDiskBytes, 100 * 1024 ** 2);

  const checks = installResourceChecks(plan.resources, "small", {
    operation: "fresh",
    engine: "podman",
    requiredDiskBytes: plan.requiredDiskBytes
  });

  const podmanMemCheck = checks.find((check) => check.name === "Podman memory");
  const podmanCpuCheck = checks.find((check) => check.name === "Podman CPU");
  const podmanDiskCheck = checks.find((check) => check.name === "Podman disk");
  assert.ok(podmanMemCheck);
  assert.equal(podmanMemCheck.ok, false);
  assert.match(podmanMemCheck.detail, /podman machine stop && podman machine set --cpus 4 --memory 3072/);
  assert.ok(podmanCpuCheck);
  assert.equal(podmanCpuCheck.ok, false);
  assert.ok(podmanDiskCheck);
  assert.equal(podmanDiskCheck.ok, false);
  assert.match(podmanDiskCheck.detail, /podman machine stop && podman machine set --cpus 4 --memory 3072 --disk-size [0-9]+/);

  const sChecks = storageChecks(plan, hostResources);
  const podmanStorageCheck = sChecks.find((check) => check.name === "Podman storage");
  assert.ok(podmanStorageCheck);
  assert.equal(podmanStorageCheck.ok, false);

  // Case 2: Sufficient macOS Podman machine CPU, memory, and disk capacity
  const sufficientPlan = await inspectStoragePlan({
    root,
    config,
    operation: "fresh",
    platform: "darwin",
    resources: hostResources,
    execute: async (spec, io) => {
      if (spec.args[0] === "info") {
        io.stdout.write(JSON.stringify({
          host: {
            arch: "arm64",
            cpus: 4,
            memTotal: 8 * 1024 ** 3
          },
          store: {
            graphDriverName: "overlay",
            graphRoot: "/var/lib/containers/storage"
          }
        }));
        return 0;
      }
      if (spec.args[0] === "machine" && spec.args[1] === "ssh") {
        // 30 GiB total, 25 GiB free
        io.stdout.write("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda4 31457280 5242880 26214400 17% /var/lib/containers/storage\n");
        return 0;
      }
      if (spec.args[0] === "image" && spec.args[1] === "inspect") {
        io.stdout.write(`${rawHexId}\n`);
        return 0;
      }
      return 0;
    }
  });
  const sufficientChecks = installResourceChecks(sufficientPlan.resources, "small", {
    operation: "fresh",
    engine: "podman",
    requiredDiskBytes: sufficientPlan.requiredDiskBytes
  });
  assert.equal(sufficientChecks.every((check) => check.ok), true);
  assert.equal(storageChecks(sufficientPlan, hostResources).every((check) => check.ok), true);
});

test("CLI installs with --engine podman, dispatches podman across lifecycle commands, blocks engine switching, and reports podman in doctor and support-bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-podman-"));
  const stdout = capture();
  const stderr = capture();
  const executed = [];

  const podmanExecute = async (spec, io) => {
    executed.push({ command: spec.command, args: spec.args });
    if (spec.command === "podman") {
      if (spec.args[0] === "--version") {
        io.stdout?.write("podman version 5.3.0\n");
        return 0;
      }
      if (spec.args[0] === "compose" && spec.args[1] === "version") {
        io.stdout?.write("Docker Compose version v2.29.7\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stdout?.write(VALID_PODMAN_INFO);
        return 0;
      }
      if (spec.args.includes("pg_dump")) {
        io.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
        return 0;
      }
      if (spec.args.includes("portable-backup.mjs")) {
        io.stdout?.write(JSON.stringify({ backupDir: "/backups/spaceapp-backup-20261016T000000000Z" }) + "\n");
        return 0;
      }
    }
    return 0;
  };

  const baseOptions = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    platform: "linux",
    arch: "x64",
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 40 * 1024 ** 3
    }),
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: podmanExecute
  };

  // Reject --engine podman with --access host-root
  await assert.rejects(
    () => run(
      ["install", "--engine", "podman", "--access", "host-root", "--non-interactive", "--answers", '{"confirm":true,"open":false}'],
      baseOptions
    ),
    /Host-root access is not supported on Podman/
  );

  // Install with --engine podman --non-interactive
  executed.length = 0;
  const installCode = await run(
    ["install", "--engine", "podman", "--profile", "small", "--non-interactive", "--answers", '{"confirm":true,"open":false}', "--no-open"],
    baseOptions
  );
  assert.equal(installCode, 0, `stderr: ${stderr.value()}\nstdout: ${stdout.value()}`);
  const savedConfig = await loadConfig(root);
  assert.equal(savedConfig.engine, "podman");
  assert.ok(executed.length > 0);
  assert.ok(executed.every((item) => item.command === "podman"));

  // Refuse switching to docker on existing podman installation
  await assert.rejects(
    () => run(
      ["install", "--engine", "docker", "--non-interactive", "--answers", '{"confirm":true,"open":false}', "--no-open"],
      baseOptions
    ),
    /Cannot switch container engine from podman to docker on an existing installation/
  );

  // Lifecycle commands use podman
  for (const cmdArgs of [["up"], ["down"], ["status"], ["logs"], ["backup"]]) {
    executed.length = 0;
    const code = await run(cmdArgs, baseOptions);
    assert.equal(code, 0, `Expected ${cmdArgs.join(" ")} to succeed`);
    assert.ok(executed.length > 0, `Expected ${cmdArgs.join(" ")} to execute podman`);
    assert.ok(executed.every((item) => item.command === "podman"));
  }

  // Workspace sync and backup/restore extras (CLI settings export/import) also go through podman
  const backupId = "spaceapp-backup-20261016T000000000Z";
  await mkdir(join(root, "backups", backupId), { recursive: true });
  const workspaceFolder = await mkdtemp(join(tmpdir(), "spaceapp-podman-folder-"));
  for (const [cmdArgs, input, action] of [
    [["workspace", "add", workspaceFolder, "--read-only"], [], "syncWorkspaces"],
    [["backup"], [], "exportCliSettings"],
    [["restore"], ["RESTORE\n"], "importCliSettings"]
  ]) {
    executed.length = 0;
    const code = await run(cmdArgs, { ...baseOptions, stdin: Readable.from(input) });
    assert.equal(code, 0, `Expected ${cmdArgs.join(" ")} to succeed: ${stderr.value()}`);
    const expected = composeCommand(action, root, { engine: "podman" }).args.slice(-3).join(" ");
    assert.ok(
      executed.some((item) => item.args.slice(-3).join(" ") === expected),
      `Expected ${cmdArgs.join(" ")} to run ${action}`
    );
    assert.ok(
      executed.every((item) => item.command === "podman"),
      `Expected ${cmdArgs.join(" ")} to run only podman, got: ${executed.map((item) => item.command).join(", ")}`
    );
  }

  // A user's own restore (restoreUserState) imports their CLI settings and Space Memory through podman too
  assert.equal(await run(["user", "enable"], baseOptions), 0);
  assert.equal(await run(["user", "add", "user:Bob12345"], baseOptions), 0);
  const slug = userSlug("user:Bob12345");
  const userBackup = join(root, "backups", "spaceapp-backup-20261016T010000000Z");
  await mkdir(join(userBackup, "users"), { recursive: true });
  await writeFile(join(userBackup, "manifest.json"), "{}");
  await writeFile(join(userBackup, "users", `${slug}-cli-config.tar.gz`), "settings");
  await writeFile(join(userBackup, "users", `${slug}-memory.tar.gz`), "memory");
  executed.length = 0;
  assert.equal(await run(["user", "restore", "user:Bob12345"], baseOptions), 0, `stderr: ${stderr.value()}`);
  const userConfig = await loadConfig(root);
  for (const action of ["importCliSettings", "importMemory"]) {
    const expected = composeCommand(action, root, {
      profile: userConfig.profile,
      companionsEnabled: userConfig.companionsEnabled,
      service: `spaceapp-cli-${slug}`,
      engine: "podman"
    });
    assert.equal(expected.command, "podman");
    assert.ok(
      executed.some((item) => item.command === "podman" && JSON.stringify(item.args) === JSON.stringify(expected.args)),
      `Expected user restore to run ${action} through podman for spaceapp-cli-${slug}`
    );
  }
  assert.ok(
    executed.every((item) => item.command === "podman"),
    `Expected user restore to run only podman, got: ${executed.map((item) => item.command).join(", ")}`
  );

  // Doctor reports podman engine, rootless, cgroup v2, and delegated CPU/memory
  const doctorOut = capture();
  const doctorCode = await run(["doctor"], { ...baseOptions, stdout: doctorOut.stream });
  assert.equal(doctorCode, 0);
  assert.match(
    doctorOut.value(),
    /PASS Podman Engine: available \(engine=podman, version=5\.3\.0, mode=rootless, cgroup=v2, limitsDelegated=true\)/
  );

  // Support bundle includes podman engine diagnostics
  const bundlePath = join(root, "bundle.json");
  const bundleOut = capture();
  const bundleCode = await run(["support-bundle", "--out", bundlePath], {
    ...baseOptions,
    stdout: bundleOut.stream
  });
  assert.equal(bundleCode, 0);
  const bundleJson = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundleJson.engine.engine, "podman");
  assert.equal(bundleJson.engine.mode, "rootless");
  assert.equal(bundleJson.engine.rootless, true);
  assert.equal(bundleJson.engine.cgroupVersion, "v2");
  assert.equal(bundleJson.engine.limitsDelegated, true);
  assert.equal(bundleJson.engine.cpuDelegated, true);
  assert.equal(bundleJson.engine.memoryDelegated, true);

  // Uninstall --purge-data uses podman
  executed.length = 0;
  const uninstallCode = await run(["uninstall", "--purge-data"], {
    ...baseOptions,
    stdin: Readable.from(["DELETE\n"])
  });
  assert.equal(uninstallCode, 0);
  assert.ok(executed.every((item) => item.command === "podman"));
});

test("interactive setup auto-detects and offers Podman when Docker is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-podman-wizard-"));
  const stdout = capture();
  const stderr = capture();

  const code = await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    arch: "x64",
    stdout: stdout.stream,
    stderr: stderr.stream,
    // Wizard answers:
    // 1: profileChoice ("2" -> small)
    // 2: accessChoice ("1" -> isolated)
    // 3: engineChoice ("1" -> podman, offered because Docker failed and Podman is on PATH)
    // 4: companionsChoice ("n")
    // 5: telemetryChoice ("n")
    // 6: openBrowserChoice ("n")
    // 7: finalConfirmation ("y")
    stdin: ttyStdin("2", "1", "1", "n", "n", "n", "y"),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 40 * 1024 ** 3
    }),
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec, io) => {
      if (spec.command === "docker") {
        return 127;
      }
      if (spec.command === "podman") {
        if (spec.args[0] === "--version") {
          io.stdout?.write("podman version 5.3.0\n");
          return 0;
        }
        if (spec.args[0] === "compose" && spec.args[1] === "version") {
          io.stdout?.write("Docker Compose version v2.29.7\n");
          return 0;
        }
        if (spec.args[0] === "info") {
          io.stdout?.write(VALID_PODMAN_INFO);
          return 0;
        }
        if (spec.args.includes("pg_dump")) {
          io.stdout?.write("-- PostgreSQL database dump\nSELECT 1;\n");
          return 0;
        }
        return 0;
      }
      return 0;
    }
  });

  assert.equal(code, 0, `stderr: ${stderr.value()}\nstdout: ${stdout.value()}`);
  assert.match(stdout.value(), /Docker was not detected, but Podman is available on PATH/);
  const savedConfig = await loadConfig(root);
  assert.equal(savedConfig.engine, "podman");
});

test("podmanApiServiceReady probes the compose path exactly where compose runs", async () => {
  const calls = [];
  const execute = async (spec) => {
    calls.push(spec);
    return spec.args.join(" ") === "compose ls" ? 1 : 0;
  };
  assert.equal(await podmanApiServiceReady(execute), false);
  assert.equal(await podmanApiServiceReady(async () => 0), true);
  assert.deepEqual(calls, [{ command: "podman", args: ["compose", "ls"] }]);
});

test("ensurePodmanApiService starts a detached podman system service when the socket is missing", async () => {
  const calls = [];
  let serviceStarted = false;
  const execute = async (spec) => {
    calls.push(spec);
    const args = spec.args.join(" ");
    if (args === "system service --time=0") {
      serviceStarted = true;
      return 0;
    }
    if (args === "compose ls") {
      return serviceStarted ? 0 : 1;
    }
    return 0;
  };
  const result = await ensurePodmanApiService(execute, { platform: "linux", sleep: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.started, true);
  const service = calls.find((spec) => spec.args.join(" ") === "system service --time=0");
  assert.ok(service, "expected a detached podman system service start");
  assert.equal(service.background, true);
});

test("ensurePodmanApiService explains a missing socket on macOS instead of starting a service", async () => {
  const calls = [];
  const execute = async (spec) => {
    calls.push(spec);
    return spec.args.join(" ") === "compose ls" ? 1 : 0;
  };
  const result = await ensurePodmanApiService(execute, { platform: "darwin" });
  assert.equal(result.ok, false);
  assert.match(result.instructions.join("\n"), /podman machine start/);
  assert.ok(calls.every((spec) => !spec.args.includes("system")));
});

test("ensurePodmanApiService gives up after the wait and prints manual guidance", async () => {
  const execute = async (spec) => (spec.args.join(" ") === "system service --time=0" ? 0 : 1);
  const result = await ensurePodmanApiService(execute, { platform: "linux", waitMs: 5, sleep: async () => {} });
  assert.equal(result.ok, false);
  assert.match(result.instructions.join("\n"), /podman system service/);
});

test("ensurePodmanApiService fails fast when the service cannot start at all", async () => {
  const result = await ensurePodmanApiService(async () => 1, { platform: "linux" });
  assert.equal(result.ok, false);
  assert.match(result.instructions.join("\n"), /podman.socket/);
});

test("ensurePodmanAvailable fails with socket guidance when the API service cannot come up", async () => {
  const stderr = capture();
  const result = await ensurePodmanAvailable({
    platform: "linux",
    stderr: stderr.stream,
    execute: async (spec, io) => {
      if (spec.args[0] === "--version") {
        io.stdout.write("podman version 5.2.0\n");
        return 0;
      }
      if (spec.args[0] === "compose") {
        io.stdout.write("Docker Compose version v2.29.2\n");
        return 0;
      }
      if (spec.args[0] === "info") {
        io.stdout.write(JSON.stringify({
          host: {
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory"],
            security: { rootless: true }
          }
        }));
        return 0;
      }
      return 0;
    },
    apiService: async () => ({ ok: false, instructions: podmanApiServiceHelp() })
  });
  assert.equal(result.code, 1);
  assert.match(stderr.value(), /podman.socket/);
});

