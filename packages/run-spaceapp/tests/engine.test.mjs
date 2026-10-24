import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { checkPodman, composeProviderSupported, delegatedControllers, detectEngines, podmanFacts, podmanMachineResize, selectedEngine } from "../src/engine.mjs";
import { addUser, addWorkspace, commitInstallation, composeCommand, createDefaultConfig, initializeInstallation, prepareInstallation, renderWorkspaceCompose, saveConfig, userSlug, validateConfig } from "../src/index.mjs";
import { executeCommand, run } from "../src/cli.mjs";
import { inspectStoragePlan } from "../src/storage.mjs";

// Windows sandbox temp folders can reject atomic rename; keep stateful fixtures in the writable test directory.
const fixtureParent = process.platform === "win32" ? fileURLToPath(new URL(".", import.meta.url)) : tmpdir();

test("engine detection handles Docker, Podman, both, and neither", async () => {
  for (const [docker, podman] of [[true, false], [false, true], [true, true], [false, false]]) {
    const calls = [];
    const found = await detectEngines(async (spec) => { calls.push(spec); return spec.command === "docker" ? Number(!docker) : Number(!podman); });
    assert.deepEqual(found, { docker, podman });
    assert.deepEqual(calls.map((call) => call.command), ["docker", "podman"]);
    assert.ok(calls.every((call) => call.timeoutMs === 15000));
    assert.equal(selectedEngine({ available: found }), docker || !podman ? "docker" : "podman");
  }
});

test("flag, answers, saved config, and detection have explicit precedence", () => {
  assert.equal(selectedEngine({ flag: "podman", answer: "docker", saved: "docker" }), "podman");
  assert.equal(selectedEngine({ answer: "podman", saved: "docker" }), "podman");
  assert.equal(selectedEngine({ saved: "podman", available: { docker: true, podman: true } }), "podman");
  assert.equal(selectedEngine({ available: { docker: true, podman: true } }), "docker");
  assert.throws(() => selectedEngine({ answer: "containerd" }), /docker or podman/);
});

test("Podman constructs every Compose lifecycle action with the fixed provider", () => {
  const root = join(tmpdir(), "spaceapp-engine-contract");
  const actions = ["up", "down", "status", "logs", "pull", "syncCredentials", "syncWorkspaces", "exportCliSettings", "importCliSettings", "cliHostReady", "exportMemory", "importMemory", "installClaude", "backup", "stopForRestore", "resetOwnerPassword", "rotateOwnerSetupToken", "removeBrowser", "removeTemporal", "enableTemporal", "databaseSize", "storageFree", "purge", "repair", "ensureCheckpointDatabase", "checkpointDump", "checkpointRestore", "restore", "installProvider"];
  for (const action of actions) {
    const options = { engine: "podman", profile: "large", backupId: "spaceapp-backup-20261021T120000000Z", provider: "opencode" };
    const spec = composeCommand(action, root, options);
    assert.equal(spec.command, "podman", action);
    assert.deepEqual(spec.env, { PODMAN_COMPOSE_PROVIDER: "docker-compose" });
    assert.equal(spec.args[0], "compose");
    assert.ok(spec.args.includes("--project-name"));
    assert.ok(spec.args.includes("--profile"));
    assert.ok(spec.args.includes(join(root, "compose.workspaces.yml")));
  }
  assert.ok(composeCommand("ensureCheckpointDatabase", root, { engine: "podman" }).args.includes("--wait"));
  assert.deepEqual(composeCommand("installProvider", root, { engine: "podman", provider: "opencode" }).args.slice(-7),
    ["-T", "--user", "10001:10001", "spaceapp-cli", "sh", "-ec", "command -v opencode && opencode --version"]);
  assert.deepEqual(composeCommand("installProvider", root, { provider: "opencode" }).args.slice(-3),
    ["node", "/app/deploy/docker/provider-install.mjs", "opencode"]);
  assert.equal(composeCommand("up", root).command, "docker");
});

test("the trusted dispatcher has a literal Podman case", async () => {
  const source = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");
  assert.match(source, /case "podman": return spawn\("podman", args, options\)/);
  const code = await executeCommand({ command: "podman", args: ["--version"] });
  assert.ok(code === 0 || code === 127);
  await assert.rejects(executeCommand({ command: "sh", args: ["-c", "true"] }), /untrusted/);
});

test("rootless Podman info, socket, and cgroup delegation are checked before compose", async () => {
  const info = { version: { Version: "5.8.4" }, host: { cgroupVersion: "v2", security: { rootless: true }, remoteSocket: { path: "/run/user/1000/podman/podman.sock" } } };
  const calls = [];
  const execute = async (spec, io) => {
    calls.push(spec);
    io.stdout?.write(spec.args[0] === "info" ? JSON.stringify(info) : "Docker Compose version v2.38.2\n");
    return 0;
  };
  const read = async (path) => { assert.equal(path, "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cgroup.controllers"); return "cpu memory pids"; };
  const inspectSocket = async (path) => { assert.equal(path, info.host.remoteSocket.path); return { isSocket: () => true }; };
  assert.deepEqual(delegatedControllers("cpu memory io"), { cpu: true, memory: true });
  assert.deepEqual(await podmanFacts({ execute, platform: "linux", uid: 1000, read }), {
    version: "5.8.4", rootless: true, cgroupVersion: "v2", socket: info.host.remoteSocket.path, delegated: { cpu: true, memory: true }
  });
  assert.equal((await checkPodman({ execute, platform: "linux", profile: "small", uid: 1000, read, inspectSocket })).version, "5.8.4");
  assert.ok(calls.some((spec) => spec.args[0] === "compose" && spec.env.PODMAN_COMPOSE_PROVIDER === "docker-compose"));
  await assert.rejects(checkPodman({ execute, platform: "linux", profile: "small", uid: 1000, read: async () => "pids", inspectSocket }), /delegated/);
  await assert.rejects(checkPodman({ execute, platform: "linux", profile: "small", uid: 1000, read, inspectSocket: async () => null }), /socket is not listening/);
  await assert.rejects(podmanFacts({ execute: async () => 127, platform: "linux", read: async () => 'ID="fedora"\n' }), /dnf install podman docker-compose-plugin.*Podman info is unavailable/);
  assert.equal(composeProviderSupported("Docker Compose version v2.19.0"), false);
  assert.equal(composeProviderSupported("Docker Compose version v2.20.0"), true);
  assert.equal(composeProviderSupported("Docker Compose version v5.6.0"), true);
});

test("Podman workspace overrides use keep-id and shared SELinux relabeling for owner and multi-user containers", async () => {
  const config = { ...createDefaultConfig({ version: "1.1.6", profile: "small" }), engine: "podman",
    workspaces: [{ id: "project-01234567", hostPath: join(tmpdir(), "project"), containerPath: "/workspaces/project-01234567", readOnly: false },
      { id: "docs-89abcdef", hostPath: join(tmpdir(), "docs"), containerPath: "/workspaces/docs-89abcdef", readOnly: true }] };
  const compose = renderWorkspaceCompose(config);
  assert.equal((compose.match(/userns_mode: keep-id:uid=10001,gid=10001/g) ?? []).length, 3);
  assert.equal((compose.match(/user: 0:0/g) ?? []).length, 3);
  assert.equal((compose.match(/selinux: z/g) ?? []).length, 4);
  assert.match(compose, /read_only: true/);
  assert.doesNotMatch(renderWorkspaceCompose({ ...config, engine: "docker" }), /keep-id|selinux: z/);

  const multiUserConfig = addUser({ ...config, users: [] }, "user:Alice123");
  const slug = userSlug("user:Alice123");
  const multiCompose = renderWorkspaceCompose(multiUserConfig);
  assert.match(multiCompose, new RegExp(`spaceapp-cli-${slug}:\\n    image: [^\\n]+\\n    restart: unless-stopped\\n    userns_mode: keep-id:uid=10001,gid=10001\\n    user: 0:0`));
  assert.equal((multiCompose.match(/userns_mode: keep-id:uid=10001,gid=10001/g) ?? []).length, 4);
  assert.equal((multiCompose.match(/user: 0:0/g) ?? []).length, 4);

  await assert.rejects(addWorkspace({ ...config, workspaces: [] }, homedir()), /SELinux relabeling is unsafe/);
  assert.throws(() => validateConfig({ ...config, accessMode: "host-root" }), /Podman does not support/);
});

test("a missing Podman workspace reports the existing-directory requirement", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { ...createDefaultConfig({ version: "1.1.6", profile: "small" }), engine: "podman" };
  await assert.rejects(addWorkspace(config, join(root, "missing")), /Workspace path must be an existing directory\./);
});

test("non-interactive Podman install on a TTY without confirm does not auto-approve the plan", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-no-auto-approve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stdin = Readable.from([]);
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  const code = await run(["install", "--engine", "podman", "--profile", "small", "--non-interactive", "--no-open"], {
    env: { SPACEAPP_HOME: root }, platform: "linux", stdin, stdout,
    stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    execute: async () => { throw new Error("Install must not execute commands without explicit confirmation."); },
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 })
  });
  assert.equal(code, 0);
  assert.match(output, /Cancelled\. No changes were made\./);
  await assert.rejects(readFile(join(root, "config.json"), "utf8"), /ENOENT/);
});

test("staged Podman install references the seccomp profile written to the project root", async (t) => {
  const projectRoot = await mkdtemp(join(fixtureParent, "spaceapp-podman-project-"));
  const stagedRoot = await mkdtemp(join(fixtureParent, "spaceapp-podman-staged-"));
  t.after(() => Promise.all([rm(projectRoot, { recursive: true, force: true }), rm(stagedRoot, { recursive: true, force: true })]));
  const config = { ...createDefaultConfig({ version: "1.1.6", profile: "small" }), engine: "podman" };
  await commitInstallation(stagedRoot, config, { projectRoot });
  const compose = await readFile(join(stagedRoot, "compose.workspaces.yml"), "utf8");
  assert.ok(compose.includes(`seccomp=${join(projectRoot, "seccomp-cli.json")}`));
  assert.ok(!compose.includes(join(stagedRoot, "seccomp-cli.json")));
  assert.ok((await readFile(join(projectRoot, "seccomp-cli.json"), "utf8")).length > 0);
});

test("unattended Podman install requires an explicit confirmation answer", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-approval-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let errors = "";
  const noOp = new Writable({ write(_chunk, _encoding, done) { done(); } });
  assert.equal(await run(["install", "--engine", "podman", "--profile", "small", "--non-interactive", "--no-open"], {
    env: { SPACEAPP_HOME: root }, platform: "linux", stdin: Readable.from([]), stdout: noOp,
    stderr: new Writable({ write(chunk, _encoding, done) { errors += chunk; done(); } }),
    execute: async () => { throw new Error("Install must stop before executing a command."); },
    inspectResources: async () => { throw new Error("Install must stop before checking resources."); }
  }), 1);
  assert.match(errors, /setup changes require an interactive terminal/);
});

test("an existing Docker installation refuses an engine switch", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-engine-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initializeInstallation(root, { version: "1.1.6", profile: "small" });
  await assert.rejects(prepareInstallation(root, { version: "1.1.6", profile: "small", engine: "podman" }), /Docker volumes are not visible to Podman/);
});

test("saved Podman config drives later CLI commands and both selection paths refuse a switch", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-engine-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { ...createDefaultConfig({ version: "1.1.6", profile: "small" }), engine: "podman" };
  await saveConfig(root, config);
  const specs = [];
  const options = { env: { SPACEAPP_HOME: root }, platform: "linux", execute: async (spec) => { specs.push(spec); return 0; },
    stdout: new Writable({ write(_c, _e, done) { done(); } }), stderr: new Writable({ write(_c, _e, done) { done(); } }) };
  assert.equal(await run(["up"], options), 0);
  assert.equal(specs.at(-1).command, "podman");
  await assert.rejects(run(["install", "--engine", "docker"], options), /Docker volumes are not visible to Podman/);
  await assert.rejects(run(["install", "--answers", '{"engine":"docker"}'], options), /Docker volumes are not visible to Podman/);
});

test("Podman provider install opencode checks its bundled binary", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-opencode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveConfig(root, { ...createDefaultConfig({ version: "1.1.6", profile: "small" }), engine: "podman" });
  let output = "";
  let spec;
  assert.equal(await run(["provider", "install", "opencode"], {
    env: { SPACEAPP_HOME: root }, platform: "linux", execute: async (value) => { spec = value; return 0; },
    stdout: new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } }),
    stderr: new Writable({ write(_chunk, _encoding, done) { done(); } })
  }), 0);
  assert.equal(spec.command, "podman");
  assert.deepEqual(spec.args.slice(-3), ["sh", "-ec", "command -v opencode && opencode --version"]);
  assert.match(output, /OpenCode is bundled/);
});

test("same-version update honors the action answer in unattended mode", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-update-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveConfig(root, { ...createDefaultConfig({ version: "1.1.6", profile: "small" }), engine: "podman" });
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  assert.equal(await run(["update", "--non-interactive", "--answers", '{"confirm":true,"action":"cancel"}'], {
    env: { SPACEAPP_HOME: root }, platform: "linux", runtimeVersion: "1.1.6", stdin: Readable.from([]), stdout,
    stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    execute: async () => { throw new Error("A cancelled update must not run container commands."); }
  }), 0);
  assert.match(output, /Select 1-3 \[1\]: cancel/);
  assert.match(output, /Cancelled\. No changes were made/);
});

test("install rejects Podman host-root before creating state", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-host-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nullStream = new Writable({ write(_c, _e, done) { done(); } });
  await assert.rejects(run(["install", "--engine", "podman", "--access", "host-root", "--profile", "small", "--non-interactive", "--answers", '{"confirm":true}'], {
    env: { SPACEAPP_HOME: root }, platform: "linux", stdin: Readable.from([]), stdout: nullStream, stderr: nullStream,
    execute: async () => 0, inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 })
  }), /Podman cannot use --access host-root/);
});

test("macOS machine sizing reports an exact resize command for both top-level and Resources shapes", () => {
  assert.equal(podmanMachineResize([{ CPUs: 2, Memory: 2048, DiskSize: 5 }], "small"),
    "podman machine stop && podman machine set --cpus 4 --memory 7168 --disk-size 7 && podman machine start");
  assert.equal(podmanMachineResize([{ Resources: { CPUs: 2, Memory: 2048, DiskSize: 5 } }], "small"),
    "podman machine stop && podman machine set --cpus 4 --memory 7168 --disk-size 7 && podman machine start");
  assert.equal(podmanMachineResize([{ CPUs: 8, Memory: 16384, DiskSize: 20 }], "small"), null);
});

test("macOS install preflight inspects the machine and rejects an undersized one", async () => {
  const execute = async (spec, io) => {
    const output = spec.args[0] === "info"
      ? { version: { Version: "5.8.4" }, host: { cgroupVersion: "v2", security: { rootless: true }, remoteSocket: { path: "/tmp/podman.sock" } } }
      : spec.args[0] === "machine" ? [{ CPUs: 2, Memory: 2048, DiskSize: 5 }] : "Docker Compose version v2.20.0";
    io.stdout?.write(typeof output === "string" ? output : JSON.stringify(output));
    return 0;
  };
  await assert.rejects(checkPodman({ execute, platform: "darwin", profile: "small" }),
    /podman machine stop && podman machine set --cpus 4 --memory 7168 --disk-size 7 && podman machine start/);
  await assert.rejects(checkPodman({
    execute: async (spec, io) => {
      if (spec.args[0] === "machine") return 1;
      io.stdout?.write(spec.args[0] === "info"
        ? JSON.stringify({ version: { Version: "5.8.4" }, host: { cgroupVersion: "v2", security: { rootless: true }, remoteSocket: { path: "/tmp/podman.sock" } } })
        : "Docker Compose version v2.20.0");
      return 0;
    },
    platform: "darwin",
    profile: "small"
  }), /Run podman machine init && podman machine start/);
});

test("storage probes use the selected Podman engine and its JSON resource shape", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specs = [];
  const execute = async (spec, io) => {
    specs.push(spec);
    if (spec.args[0] === "info") io.stdout?.write(JSON.stringify({ host: { cpus: 8, memTotal: 16 * 1024 ** 3 }, store: {} }));
    return 0;
  };
  const resources = { cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 };
  const plan = await inspectStoragePlan({ root, config: { profile: "small", version: "1.1.6", engine: "podman" }, resources, execute, operation: "fresh" });
  assert.equal(plan.engine, "podman");
  assert.equal(plan.resources.engineCpuCount, 8);
  assert.equal(plan.resources.engineMemoryBytes, 16 * 1024 ** 3);
  assert.ok(specs.every((spec) => spec.command === "podman"));
  assert.deepEqual(specs[0].args, ["info", "--format", "json"]);
  assert.ok(specs.some((spec) => spec.args[0] === "image" && spec.args[1] === "inspect"));
});

test("Podman unprefixed image IDs count as cached images", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specs = [];
  const execute = async (spec, io) => {
    specs.push(spec);
    io.stdout?.write(spec.args[0] === "info" ? JSON.stringify({ host: {} }) : "a".repeat(64));
    return 0;
  };
  const plan = await inspectStoragePlan({ root, config: { profile: "small", version: "1.1.6", engine: "podman" },
    resources: { cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 }, execute, operation: "fresh" });
  assert.ok(specs.some((spec) => spec.args[0] === "image" && spec.args[1] === "inspect"));
  assert.deepEqual(plan.missingImages, []);
  assert.equal(plan.missingImageBytes, 0);
});

test("doctor reports saved Podman engine facts and provider version", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveConfig(root, { ...createDefaultConfig({ version: "1.1.6", profile: "small" }), engine: "podman" });
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  const execute = async (spec, io) => {
    io.stdout?.write(spec.args[0] === "info"
      ? JSON.stringify({ version: { Version: "5.8.4" }, host: { security: { rootless: true }, cgroupVersion: "v2", remoteSocket: { path: "/tmp/podman.sock" } } })
      : "Docker Compose version v2.20.0");
    return 0;
  };
  assert.equal(await run(["doctor"], { env: { SPACEAPP_HOME: root }, platform: "darwin", execute, stdout,
    stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3 }) }), 0);
  assert.match(output, /Container engine: Podman 5\.8\.4/);
  assert.match(output, /Rootless: yes/);
  assert.match(output, /Cgroup version: v2/);
  assert.match(output, /Compose provider: Docker Compose version v2\.20\.0/);
});

test("support bundle includes Podman facts without secret contents", async (t) => {
  const root = await mkdtemp(join(fixtureParent, "spaceapp-podman-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveConfig(root, { ...createDefaultConfig({ version: "1.1.6", profile: "small" }), engine: "podman" });
  await mkdir(join(root, "secrets"));
  await writeFile(join(root, "secrets", "provider-key"), "podman-test-secret-marker");
  const execute = async (spec, io) => {
    io.stdout?.write(spec.args[0] === "info"
      ? JSON.stringify({ version: { Version: "5.8.4" }, host: { security: { rootless: true }, cgroupVersion: "v2", remoteSocket: { path: "/tmp/podman.sock" } } })
      : "Docker Compose version v2.20.0");
    return 0;
  };
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  assert.equal(await run(["support-bundle"], { env: { SPACEAPP_HOME: root }, platform: "darwin", execute, request: null, stdout,
    stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }) }), 0);
  const path = output.match(/SpaceApp support bundle generated: (.+)\n/)?.[1];
  assert.ok(path);
  const bundle = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(bundle.engine, { name: "podman", version: "5.8.4", rootless: true, cgroupVersion: "v2", socket: "/tmp/podman.sock", delegated: { cpu: null, memory: null } });
  assert.ok(!JSON.stringify(bundle).includes("podman-test-secret-marker"));
});
