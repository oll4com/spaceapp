import test from "node:test";
import assert from "node:assert/strict";
import { composeCommand, createDefaultConfig, prepareInstallation, validateConfig } from "../src/index.mjs";
import { executeCommand } from "../src/cli.mjs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("composeCommand generates podman compose commands when engine is podman", () => {
  const root = "/tmp/spaceapp-test";
  const cmd = composeCommand("up", root, { engine: "podman", profile: "small" });
  assert.equal(cmd.command, "podman");
  assert.equal(cmd.args[0], "compose");
  assert.ok(cmd.args.includes("up"));
  assert.ok(cmd.args.includes("-d"));
});

test("composeCommand defaults to docker when engine is unspecified", () => {
  const root = "/tmp/spaceapp-test";
  const cmd = composeCommand("status", root, { profile: "small" });
  assert.equal(cmd.command, "docker");
  assert.equal(cmd.args[0], "compose");
  assert.ok(cmd.args.includes("ps"));
});

test("validateConfig accepts engine: podman and engine: docker", () => {
  const cfg = createDefaultConfig({ version: "1.1.7", engine: "podman" });
  assert.equal(cfg.engine, "podman");
  assert.doesNotThrow(() => validateConfig(cfg));

  const invalid = { ...cfg, engine: "containerd" };
  assert.throws(() => validateConfig(invalid), /engine must be docker or podman/);
});

test("prepareInstallation refuses switching engines on existing installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  const { config } = await prepareInstallation(root, { version: "1.1.7", engine: "docker" });
  const { saveConfig } = await import("../src/index.mjs");
  await saveConfig(root, config);

  await assert.rejects(
    () => prepareInstallation(root, { version: "1.1.7", engine: "podman" }),
    /Switching container engines on an existing installation from docker to podman is refused/
  );
});

test("executeCommand allowlists podman executable", () => {
  const promise = executeCommand({ command: "podman", args: ["--version"] });
  assert.ok(promise instanceof Promise);
});

test("validateConfig rejects accessMode: host-root with engine: podman", () => {
  const cfg = createDefaultConfig({ version: "1.1.7", engine: "podman", accessMode: "host-root" });
  assert.throws(
    () => validateConfig(cfg),
    /Host-root access is not supported with rootless Podman/
  );
});

test("podmanIsReady returns false when podman is missing or fails", async () => {
  const { podmanIsReady } = await import("../src/prerequisites.mjs");
  const failingExecute = async () => 1;
  const ready = await podmanIsReady(failingExecute);
  assert.equal(ready, false);

  const passingExecute = async () => 0;
  const readyPass = await podmanIsReady(passingExecute);
  assert.equal(readyPass, true);
});

test("legacy config without engine defaults to docker and refuses podman switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-legacy-engine-"));
  const { config } = await prepareInstallation(root, { version: "1.1.7" });
  const { saveConfig } = await import("../src/index.mjs");
  // Delete engine to simulate legacy pre-podman config
  delete config.engine;
  await saveConfig(root, config);

  await assert.rejects(
    () => prepareInstallation(root, { version: "1.1.7", engine: "podman" }),
    /Switching container engines on an existing installation from docker to podman is refused/
  );
});

test("composeCommand reads engine from existing config when options.engine is omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-compose-engine-"));
  const { config, saveConfig } = await import("../src/index.mjs");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(root, "config.json"), JSON.stringify({
    schemaVersion: 4,
    version: "1.1.7",
    engine: "podman",
    profile: "small",
    accessMode: "isolated",
    companionsEnabled: false,
    bindHost: "127.0.0.1",
    port: 4911,
    telemetry: false,
    optionalModules: "none",
    workspaces: [],
    previousVersion: null
  }));
  await writeFile(join(root, "runtime.env"), "SPACEAPP_IMAGE_TAG=1.1.7\n");
  await writeFile(join(root, "compose.yml"), "services: {}\n");
  await writeFile(join(root, "compose.workspaces.yml"), "services: {}\n");
  await writeFile(join(root, "compose.host-access.yml"), "services: {}\n");

  const cmd = composeCommand("status", root, { profile: "small" });
  assert.equal(cmd.command, "podman");
});

test("verifyPodmanPrerequisites checks binary, compose, version, rootless, and info", async () => {
  const { verifyPodmanPrerequisites } = await import("../src/prerequisites.mjs");
  
  // Failing binary
  const failBinary = async (spec) => spec.command === "podman" && spec.args[0] === "--version" ? 1 : 0;
  const res1 = await verifyPodmanPrerequisites(failBinary, { stderr: null });
  assert.equal(res1.ok, false);
  assert.equal(res1.reason, "podman_missing");

  // Failing compose
  const failCompose = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
      return 0;
    }
    if (spec.args?.[0] === "compose") {
      return 1;
    }
    return 0;
  };
  const res2 = await verifyPodmanPrerequisites(failCompose, { stderr: null });
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, "podman_compose_missing");

  // Passing all with stream verification
  const passAll = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      assert.equal(typeof io.stdout.write, "function", "stdout must be a stream");
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      assert.equal(typeof io.stdout.write, "function", "stdout must be a stream");
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      assert.equal(typeof io.stdout.write, "function", "stdout must be a stream");
      io.stdout.write(JSON.stringify({
        host: {
          security: { rootless: true },
          cgroupVersion: "v2"
        }
      }));
    }
    return 0;
  };
  const res3 = await verifyPodmanPrerequisites(passAll, { stderr: null });
  assert.equal(res3.ok, true);
  assert.equal(res3.code, 0);

  // Unsupported major version (< 5)
  const oldVersion = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 4.9.4\n");
    }
    return 0;
  };
  const res4 = await verifyPodmanPrerequisites(oldVersion, { stderr: null });
  assert.equal(res4.ok, false);
  assert.equal(res4.reason, "podman_version_unsupported");

  // Rootful podman rejection
  const rootful = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.0.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write(JSON.stringify({
        host: {
          security: { rootless: false },
          cgroupVersion: "v2"
        }
      }));
    }
    return 0;
  };
  const res5 = await verifyPodmanPrerequisites(rootful, { stderr: null });
  assert.equal(res5.ok, false);
  assert.equal(res5.reason, "podman_not_rootless");

  // cgroup v1 rejection
  const cgroupV1 = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.0.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write(JSON.stringify({
        host: {
          security: { rootless: true },
          cgroupVersion: "v1"
        }
      }));
    }
    return 0;
  };
  const res6 = await verifyPodmanPrerequisites(cgroupV1, { stderr: null });
  assert.equal(res6.ok, false);
  assert.equal(res6.reason, "podman_cgroup_unsupported");

  // Case 1: Podman version unparseable
  const unparseableVersion = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("custom build without semver\n");
    }
    return 0;
  };
  const resCase1 = await verifyPodmanPrerequisites(unparseableVersion, { stderr: null });
  assert.equal(resCase1.ok, false);
  assert.equal(resCase1.reason, "podman_version_unparseable");

  // Case 2: podman info produces invalid JSON
  const invalidJsonInfo = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write("Error: cannot connect to podman socket\n");
    }
    return 0;
  };
  const resCase2 = await verifyPodmanPrerequisites(invalidJsonInfo, { stderr: null });
  assert.equal(resCase2.ok, false);
  assert.equal(resCase2.reason, "podman_info_invalid_json");

  // Case 3: rootless field missing from info
  const missingRootless = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write(JSON.stringify({
        host: {
          cgroupVersion: "v2"
          // security.rootless missing
        }
      }));
    }
    return 0;
  };
  const resCase3 = await verifyPodmanPrerequisites(missingRootless, { stderr: null });
  assert.equal(resCase3.ok, false);
  assert.equal(resCase3.reason, "podman_not_rootless");

  // Case 4: cgroupVersion missing from info
  const missingCgroup = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write(JSON.stringify({
        host: {
          security: { rootless: true }
          // cgroupVersion missing
        }
      }));
    }
    return 0;
  };
  const resCase4 = await verifyPodmanPrerequisites(missingCgroup, { stderr: null });
  assert.equal(resCase4.ok, false);
  assert.equal(resCase4.reason, "podman_cgroup_unsupported");

  // Case 5: formatted info probe fails (non-zero exit)
  const failedFormattedInfo = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info") {
      return 1;
    }
    return 0;
  };
  const resCase5 = await verifyPodmanPrerequisites(failedFormattedInfo, { stderr: null });
  assert.equal(resCase5.ok, false);
  assert.equal(resCase5.reason, "podman_info_failed");

  // macOS Podman machine validation (success with guest Linux VM, rootless, cgroup v2, sufficient resources)
  const macPass = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write(JSON.stringify({
        host: {
          os: "linux",
          security: { rootless: true },
          cgroupVersion: "v2",
          cpus: 4,
          memTotal: 8 * 1024 ** 3
        }
      }));
    }
    return 0;
  };
  const resMac = await verifyPodmanPrerequisites(macPass, { stderr: null, platform: "darwin", requestedProfile: "small" });
  assert.equal(resMac.ok, true);
  assert.equal(resMac.code, 0);

  // macOS negative 1: host.os=darwin without rootless info
  const macNoRootless = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write(JSON.stringify({
        host: {
          os: "darwin"
          // security.rootless missing
        }
      }));
    }
    return 0;
  };
  const resMacNeg1 = await verifyPodmanPrerequisites(macNoRootless, { stderr: null, platform: "darwin" });
  assert.equal(resMacNeg1.ok, false);
  assert.equal(resMacNeg1.reason, "podman_not_rootless");

  // macOS negative 2: host.os=linux in machine but rootless=false and cgroupVersion=v1
  const macRootfulCgroupV1 = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write(JSON.stringify({
        host: {
          os: "linux",
          security: { rootless: false },
          cgroupVersion: "v1"
        }
      }));
    }
    return 0;
  };
  const resMacNeg2 = await verifyPodmanPrerequisites(macRootfulCgroupV1, { stderr: null, platform: "darwin" });
  assert.equal(resMacNeg2.ok, false);
  assert.equal(resMacNeg2.reason, "podman_not_rootless");

  // macOS negative 3: insufficient CPU in Podman machine
  const macLowCpu = async (spec, io) => {
    if (spec.args?.[0] === "--version" && io?.stdout) {
      io.stdout.write("podman version 5.1.0\n");
    }
    if (spec.args?.[0] === "compose" && io?.stdout) {
      io.stdout.write("podman-compose version 1.2.0\n");
    }
    if (spec.args?.[0] === "info" && io?.stdout) {
      io.stdout.write(JSON.stringify({
        host: {
          os: "linux",
          security: { rootless: true },
          cgroupVersion: "v2",
          cpus: 2, // requires 4
          memTotal: 8 * 1024 ** 3
        }
      }));
    }
    return 0;
  };
  const resMacNeg3 = await verifyPodmanPrerequisites(macLowCpu, { stderr: null, platform: "darwin", requestedProfile: "small" });
  assert.equal(resMacNeg3.ok, false);
  assert.equal(resMacNeg3.reason, "podman_machine_insufficient_cpus");
});

test("renderWorkspaceCompose adds selinux z option when engine is podman", async () => {
  const { renderWorkspaceCompose } = await import("../src/index.mjs");
  const cfg = createDefaultConfig({ version: "1.1.7", engine: "podman" });
  cfg.workspaces = [{ hostPath: "/home/user/code", containerPath: "/workspaces/code", readOnly: false, id: "code-12345678" }];
  const yml = renderWorkspaceCompose(cfg, { selinux: true });
  assert.match(yml, /selinux: z/);
});
