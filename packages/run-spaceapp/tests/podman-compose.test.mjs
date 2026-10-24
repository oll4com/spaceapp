import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  addUser,
  composeCommand,
  createDefaultConfig,
  initializeInstallation,
  installResourceChecks,
  loadConfig,
  prepareInstallation,
  renderEngineCompose,
  renderHostAccessCompose,
  renderWorkspaceCompose,
  resolveInstallProfile,
  saveConfig,
  userSlug,
  validateConfig
} from "../src/index.mjs";

const version = "1.1.7";
const home = resolve(tmpdir(), "spaceapp-podman-home");
const workspace = {
  id: "project-a1b2c3d4", name: "project", hostPath: "/home/alice/project",
  containerPath: "/workspaces/project", readOnly: false
};

async function temporaryHome(t) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("both engines construct identical bounded Compose actions and Podman pins its provider", () => {
  const actions = [
    "up", "down", "status", "logs", "pull", "syncCredentials", "syncWorkspaces", "exportCliSettings", "importCliSettings",
    "cliHostReady", "exportMemory", "importMemory", "installClaude", "installProvider", "backup", "restore", "pauseWriters",
    "unpauseWriters", "stopForRestore", "stopForPortableRestore", "resetOwnerPassword", "rotateOwnerSetupToken", "removeBrowser",
    "removeTemporal", "enableTemporal", "databaseSize", "storageFree", "purge", "repair", "ensureCheckpointDatabase",
    "checkpointDump", "checkpointRestore"
  ];
  for (const profile of ["small", "medium", "large"]) {
    for (const action of actions) {
      const options = { profile, provider: "opencode", backupId: "spaceapp-backup-20261024T120000000Z" };
      const docker = composeCommand(action, home, { ...options, engine: "docker" });
      const podman = composeCommand(action, home, { ...options, engine: "podman" });
      assert.equal(docker.command, "docker", action);
      assert.equal(docker.env, undefined, action);
      assert.equal(podman.command, "podman", action);
      assert.deepEqual(podman.args, docker.args, action);
      assert.deepEqual(podman.env, { PODMAN_COMPOSE_PROVIDER: "docker-compose" });
      assert.equal(podman.args[0], "compose");
    }
  }
  assert.ok(composeCommand("ensureCheckpointDatabase", home, { engine: "podman" }).args.includes("--wait"));
  assert.ok(composeCommand("installProvider", home, { engine: "podman", provider: "opencode" }).args.includes("10001:10001"));
  for (const engine of ["podman; touch /tmp/no", "/usr/bin/podman", "nerdctl", "", null]) {
    assert.throws(() => composeCommand("up", home, { engine }), /engine must be docker or podman/i);
  }
});

test("Podman engine is persisted and omitted legacy engines keep Docker semantics", async (t) => {
  const root = await temporaryHome(t);
  const installed = await initializeInstallation(root, { version, engine: "podman", profile: "small" });
  assert.equal(installed.config.engine, "podman");
  assert.equal((await loadConfig(root)).engine, "podman");
  assert.equal((await prepareInstallation(root, { version })).config.engine, "podman");
  const legacy = createDefaultConfig({ version });
  await saveConfig(root, legacy);
  const loaded = await loadConfig(root);
  assert.equal(composeCommand("up", root, loaded).command, "docker");
  assert.deepEqual(loaded, legacy);
  assert.throws(() => validateConfig({ ...legacy, engine: "other" }), /engine must be docker or podman/i);
});

test("engine switching is refused before changing config, runtime files, permissions or secrets", async (t) => {
  for (const initialEngine of [undefined, "docker", "podman"]) {
    const root = await temporaryHome(t);
    const config = createDefaultConfig({ version, engine: initialEngine });
    await saveConfig(root, config);
    await mkdir(join(root, "secrets"));
    await chmod(join(root, "secrets"), 0o755);
    await writeFile(join(root, "runtime.env"), "unchanged\n");
    const before = await readFile(join(root, "config.json"), "utf8");
    await assert.rejects(prepareInstallation(root, {
      version: "1.1.8", engine: initialEngine === "podman" ? "docker" : "podman"
    }), /cannot switch.*engines do not share volumes/i);
    assert.equal(await readFile(join(root, "config.json"), "utf8"), before);
    assert.equal(await readFile(join(root, "runtime.env"), "utf8"), "unchanged\n");
    assert.deepEqual(await readdir(join(root, "secrets")), []);
    await assert.rejects(stat(join(root, "backups")), { code: "ENOENT" });
    if (process.platform !== "win32") assert.equal((await stat(join(root, "secrets"))).mode & 0o777, 0o755);
  }
});

test("Podman refuses host-root access before preparing an installation", async (t) => {
  const root = join(await temporaryHome(t), "not-created");
  assert.throws(() => createDefaultConfig({ version, engine: "podman", accessMode: "host-root" }), /Podman.*host-root/);
  const config = { ...createDefaultConfig({ version, engine: "podman" }), accessMode: "host-root" };
  assert.throws(() => renderHostAccessCompose(config), /Podman.*host-root/);
  await assert.rejects(prepareInstallation(root, { version, engine: "podman", accessMode: "host-root" }), /Podman.*host-root/);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("Podman workspace binds share SELinux labels and map host ownership consistently", () => {
  for (const readOnly of [false, true]) {
    const config = { ...createDefaultConfig({ version, engine: "podman" }), workspaces: [{ ...workspace, readOnly }] };
    const compose = renderWorkspaceCompose(config);
    assert.equal((compose.match(/selinux: z/g) ?? []).length, 2, "core and CLI both label the shared bind");
    assert.equal((compose.match(/create_host_path: true/g) ?? []).length, 2, "Compose 2.20 must use the Bind API to retain SELinux options");
    assert.equal((compose.match(new RegExp(`read_only: ${readOnly}`, "g")) ?? []).length, 2);
    for (const service of ["spaceapp-core", "spaceapp-cli", "spaceapp-browser", "codex-sessions-init"]) {
      assert.match(compose, new RegExp(`  ${service}:\\n    userns_mode: "keep-id:uid=10001,gid=10001"\\n    user: "0:0"`));
    }
    assert.doesNotMatch(compose, /:U|chown|privileged:|label[=:]disable/);
    assert.doesNotMatch(renderWorkspaceCompose({ ...config, engine: "docker" }), /selinux:|keep-id|user: "0:0"/);
  }
});

test("Podman user workspaces and credentials preserve isolation with the same ownership mapping", () => {
  const userId = "user:Alice";
  const config = addUser(createDefaultConfig({ version, engine: "podman" }), userId);
  config.users[0].workspaces = [{ ...workspace, readOnly: true }];
  const compose = renderWorkspaceCompose(config);
  const slug = userSlug(userId);
  const start = compose.indexOf(`  spaceapp-cli-${slug}:`);
  const service = compose.slice(start, compose.indexOf("  spaceapp-browser:", start));
  assert.match(service, /userns_mode: "keep-id:uid=10001,gid=10001"\n {4}user: "0:0"/);
  assert.match(service, /read_only: true\n {8}bind:\n {10}create_host_path: true\n {10}selinux: z/);
  assert.ok(service.includes(`./secrets/users/${slug}/providers:/run/spaceapp-secrets/providers:ro,z`));
  assert.doesNotMatch(compose.slice(0, start), /source: "\/home\/alice\/project"/);
  assert.match(compose, /\.\/cli-hosts\.json:\/etc\/spaceapp\/cli-hosts\.json:ro,z/);
});

test("Podman runtime labels backups, provider folders and file-based secrets without changing Docker templates", async (t) => {
  const template = await readFile(new URL("../templates/compose.yml", import.meta.url), "utf8");
  const config = createDefaultConfig({ version, engine: "podman", profile: "small" });
  const rendered = renderEngineCompose(template, config);
  assert.equal(renderEngineCompose(template, { ...config, engine: "docker" }), template);
  assert.match(rendered, /\.\/backups:\/backups:z/);
  assert.match(rendered, /\.\/secrets\/providers:\/run\/spaceapp-secrets\/providers:ro,z/);
  for (const name of ["database-url", "session-secret", "setup-token", "postgres-password"]) {
    assert.ok(rendered.includes(`./secrets/${name}:/run/secrets/${name}:ro,z`));
  }
  assert.equal((rendered.match(/\.\/secrets\/postgres-password:\/run\/secrets\/postgres-password:ro,z/g) ?? []).length, 2);
  assert.doesNotMatch(rendered, /^ {4}secrets:/m, "avoid duplicate unlabeled secret bind mounts");
  assert.match(rendered, /required: false/);
  assert.match(rendered, /condition: service_healthy/);
  assert.match(rendered, /init: true/);
  assert.match(rendered, /mem_limit:/);
  assert.match(rendered, /cpus:/);
  assert.match(rendered, /spaceapp-cli-socket:\/run\/spaceapp-cli/);
  const root = await temporaryHome(t);
  await initializeInstallation(root, { version, engine: "podman", profile: "small" });
  assert.equal(await readFile(join(root, "compose.yml"), "utf8"), rendered);
});

test("resource checks identify Podman VM CPU and memory limits", () => {
  const resources = { engine: "podman", cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 20 * 1024 ** 3,
    engineCpuCount: 2, engineMemoryBytes: 2 * 1024 ** 3 };
  const checks = installResourceChecks(resources, "small");
  assert.equal(checks.find((check) => check.name === "Podman CPU")?.ok, false);
  assert.equal(checks.find((check) => check.name === "Podman memory")?.ok, false);
});

test("automatic profiles respect Podman machine CPUs even when the host supports large", () => {
  const GiB = 1024 ** 3;
  const resources = { engine: "podman", cpuCount: 16, totalMemoryBytes: 32 * GiB, freeDiskBytes: 40 * GiB,
    engineCpuCount: 4, engineMemoryBytes: 8 * GiB };
  assert.equal(resolveInstallProfile("auto", resources), "medium");
  assert.equal(resolveInstallProfile("auto", { ...resources, engineMemoryBytes: 4 * GiB }), "small");
  assert.equal(resolveInstallProfile("auto", { ...resources, engineCpuCount: 8 }), "large");
  assert.equal(installResourceChecks(resources, "large").find((check) => check.name === "Podman CPU")?.ok, false);
  assert.equal(resolveInstallProfile("auto", { ...resources, engine: "docker" }), "large", "preserve Docker's existing VM CPU threshold");
});
