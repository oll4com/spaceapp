import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as launcher from "../src/index.mjs";

async function temporaryHome(t) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("Podman selection survives installation, reload, and version preparation", async (t) => {
  const root = await temporaryHome(t);
  const result = await launcher.initializeInstallation(root, {
    version: "1.1.6", profile: "small", engine: "podman"
  });
  assert.equal(result.config.engine, "podman");
  assert.equal((await launcher.loadConfig(root)).engine, "podman");
  const prepared = await launcher.prepareInstallation(root, { version: "1.1.7" });
  assert.equal(prepared.config.engine, "podman");
  assert.equal(prepared.config.previousVersion, "1.1.6");
  const backups = await stat(join(root, "backups"));
  if (process.platform !== "win32") {
    assert.equal(backups.mode & 0o777, 0o700);
    assert.equal(backups.uid, process.getuid());
    assert.equal(backups.gid, process.getgid());
  }
  assert.match(await readFile(join(root, "compose.engine.yml"), "utf8"), /keep-id:uid=10001,gid=10001/);
});

test("engine validation rejects arbitrary commands and Podman host-root access", () => {
  for (const engine of ["nerdctl", "podman; whoami", "", null, 5]) {
    assert.throws(() => launcher.createDefaultConfig({ version: "1.1.6", engine }), /engine.*docker.*podman/i);
    assert.throws(() => launcher.validateConfig({ ...launcher.createDefaultConfig({ version: "1.1.6" }), engine }), /engine.*docker.*podman/i);
    assert.throws(() => launcher.composeCommand("up", tmpdir(), { engine }), /engine.*docker.*podman/i);
  }
  assert.throws(() => launcher.createDefaultConfig({ version: "1.1.6", engine: "podman", accessMode: "host-root" }), /host-root.*podman|podman.*host-root/i);
  assert.throws(() => launcher.validateConfig({ ...launcher.createDefaultConfig({ version: "1.1.6", accessMode: "host-root" }), engine: "podman" }), /host-root.*podman|podman.*host-root/i);
});

test("a refused engine switch leaves an existing installation unchanged", async (t) => {
  for (const [stored, requested] of [[undefined, "podman"], ["podman", "docker"]]) {
    const root = await temporaryHome(t);
    await launcher.initializeInstallation(root, { version: "1.1.6", engine: stored });
    await rm(join(root, "backups"), { recursive: true });
    const filesBefore = await readdir(root);
    const configAtAttempt = await readFile(join(root, "config.json"), "utf8");
    await assert.rejects(() => launcher.prepareInstallation(root, { version: "1.1.7", engine: requested }), /switch.*engine|engine.*switch/i);
    assert.equal(await readFile(join(root, "config.json"), "utf8"), configAtAttempt);
    assert.deepEqual(await readdir(root), filesBefore);
  }
});

test("invalid fresh-install settings do not create installation files", async (t) => {
  const parent = await temporaryHome(t);
  const root = join(parent, "install");
  await assert.rejects(() => launcher.prepareInstallation(root, { version: "1.1.6", engine: "podman", accessMode: "host-root" }), /host-root.*podman|podman.*host-root/i);
  await assert.rejects(() => stat(root), { code: "ENOENT" });
});

test("every Podman Compose action retains project identity, profiles, and fixed action arguments", () => {
  const root = join(tmpdir(), "podman-command-home");
  const stateRoot = join(tmpdir(), "podman-command-staging");
  const actions = ["up", "down", "status", "logs", "pull", "syncCredentials", "installClaude", "backup", "stopForRestore", "resetOwnerPassword", "rotateOwnerSetupToken", "removeBrowser", "removeTemporal", "enableTemporal", "databaseSize", "storageFree", "purge", "repair", "ensureCheckpointDatabase", "checkpointDump", "checkpointRestore", "installProvider", "restore"];
  for (const action of actions) {
    const options = { profile: "large", companionsEnabled: true, stateRoot, provider: "codex", backupId: "spaceapp-backup-20260723T120000000Z" };
    const docker = launcher.composeCommand(action, root, options);
    const podman = launcher.composeCommand(action, root, { ...options, engine: "podman" });
    assert.equal(podman.command, "podman", action);
    assert.deepEqual(podman.env, { PODMAN_COMPOSE_PROVIDER: "docker-compose" });
    const startsContainer = ["up", "repair", "syncCredentials", "installClaude", "restore"].includes(action);
    assert.equal(podman.workspaceConfigRoot, startsContainer ? stateRoot : undefined, action);
    assert.equal(docker.workspaceConfigRoot, undefined, action);
    const overrideIndex = podman.args.indexOf(join(stateRoot, "compose.engine.yml"));
    assert.ok(overrideIndex > 0, action);
    assert.equal(podman.args[overrideIndex - 1], "-f");
    const withoutEngineFile = podman.args.toSpliced(overrideIndex - 1, 2);
    assert.deepEqual(withoutEngineFile, docker.args, action);
    assert.equal(docker.command, "docker");
    assert.equal(docker.env, undefined);
  }
});

test("Podman OpenCode installation verifies the bundled binary while other provider routes stay intact", () => {
  const root = join(tmpdir(), "podman-provider-home");
  const suffix = (engine, provider) => launcher.composeCommand("installProvider", root, { engine, provider }).args.slice(-7);
  assert.deepEqual(suffix("podman", "opencode"), ["exec", "-T", "--user", "10001:10001", "spaceapp-cli", "opencode", "--version"]);
  for (const [engine, provider] of [["docker", "opencode"], ["podman", "codex"]]) {
    assert.deepEqual(launcher.composeCommand("installProvider", root, { engine, provider }).args.slice(-8),
      ["exec", "-T", "--user", "10001:10001", "spaceapp-cli", "node", "/app/deploy/docker/provider-install.mjs", provider]);
  }
  assert.throws(() => launcher.composeCommand("installProvider", root, { engine: "podman", provider: "opencode;echo" }), /provider/i);
});

test("Podman override keeps root entrypoint initialization and per-service secret grants", () => {
  const config = launcher.createDefaultConfig({ version: "1.1.6", engine: "podman" });
  const compose = launcher.renderEngineCompose(config);
  const service = (name) => compose.split(`  ${name}:\n`)[1]?.split(/^  \S/m)[0] ?? "";
  for (const name of ["spaceapp-core", "spaceapp-cli", "spaceapp-browser"]) {
    assert.match(service(name), /userns_mode: "keep-id:uid=10001,gid=10001"/);
    assert.match(service(name), /user: "0:0"/);
  }
  for (const name of ["postgres", "temporal"]) assert.doesNotMatch(service(name), /userns_mode:|user:/);
  for (const [name, secrets] of [["spaceapp-core", ["setup-token", "session-secret", "database-url"]], ["spaceapp-browser", ["database-url"]], ["postgres", ["postgres-password"]], ["temporal", ["postgres-password"]]]) {
    assert.match(service(name), /secrets: !reset \[\]/);
    for (const secret of secrets) assert.ok(service(name).includes(`./secrets/${secret}:/run/secrets/${secret}:ro,z`));
    for (const secret of ["setup-token", "session-secret", "database-url", "postgres-password"].filter((secret) => !secrets.includes(secret))) {
      assert.ok(!service(name).includes(`/run/secrets/${secret}:`));
    }
  }
  assert.match(service("spaceapp-core"), /\.\/backups:\/backups:z/);
  assert.match(service("spaceapp-cli"), /\.\/secrets\/providers:\/run\/spaceapp-secrets\/providers:ro,z/);
  assert.doesNotMatch(compose, /label[=:]disable|privileged:|entrypoint:|command:|:U(?:[,"\s]|$)/);
});

test("Podman workspaces share SELinux labels and retain their read-only setting", () => {
  const config = {
    ...launcher.createDefaultConfig({ version: "1.1.6", engine: "podman" }),
    workspaces: [false, true].map((readOnly, index) => ({ id: `project-0000000${index}`, name: `project-${index}`, hostPath: `/home/alice/project-${index}`, containerPath: `/workspaces/project-${index}`, readOnly }))
  };
  const compose = launcher.renderWorkspaceCompose(config);
  assert.equal(compose.match(/selinux: z/g)?.length, 4);
  assert.equal(compose.match(/read_only: true/g)?.length, 2);
  assert.equal(compose.match(/read_only: false/g)?.length, 2);
  assert.doesNotMatch(compose, /:U|chown|label[=:]disable/);
});

test("Docker keeps absent engine semantics and does not need an engine override file", async (t) => {
  const root = await temporaryHome(t);
  const result = await launcher.initializeInstallation(root, { version: "1.1.6" });
  assert.equal(result.config.engine, undefined);
  assert.equal(launcher.resolveContainerEngine(result.config.engine), "docker");
  assert.equal(launcher.renderEngineCompose(result.config), "services: {}\n");
  await assert.rejects(() => stat(join(root, "compose.engine.yml")), { code: "ENOENT" });
});

test("automatic profiles respect the engine VM allocation without relaxing host minimums", () => {
  const GiB = 1024 ** 3;
  const resources = { cpuCount: 16, totalMemoryBytes: 32 * GiB, freeDiskBytes: 50 * GiB, engineCpuCount: 4, engineName: "Podman" };
  assert.equal(launcher.resolveInstallProfile("auto", { ...resources, engineMemoryBytes: 3 * GiB }), "small");
  assert.equal(launcher.resolveInstallProfile("auto", { ...resources, engineMemoryBytes: 5 * GiB }), "medium");
  assert.equal(launcher.resolveInstallProfile("auto", { ...resources, engineCpuCount: 8, engineMemoryBytes: 7 * GiB }), "large");
  assert.equal(launcher.resolveInstallProfile("auto", { ...resources, totalMemoryBytes: 8 * GiB, engineMemoryBytes: 7 * GiB }), "small");
});

test("explicit profiles remain explicit and checks identify insufficient Podman resources", () => {
  const GiB = 1024 ** 3;
  const resources = { cpuCount: 16, totalMemoryBytes: 32 * GiB, freeDiskBytes: 50 * GiB, engineCpuCount: 2, engineMemoryBytes: 3 * GiB, engineName: "Podman" };
  assert.equal(launcher.resolveInstallProfile("large", resources), "large");
  const checks = launcher.installResourceChecks(resources, "large");
  assert.equal(checks.find((check) => check.name === "Podman memory")?.ok, false);
  assert.equal(checks.find((check) => check.name === "Podman CPU")?.ok, false);
  assert.ok(checks.filter((check) => check.name === "CPU" || check.name === "Memory").every((check) => check.ok));
});

test("resource checks keep existing Docker labels and skip unavailable allocation facts", () => {
  const GiB = 1024 ** 3;
  const resources = { cpuCount: 16, totalMemoryBytes: 32 * GiB, freeDiskBytes: 50 * GiB };
  const checks = launcher.installResourceChecks({ ...resources, engineCpuCount: 4, engineMemoryBytes: 3 * GiB }, "small");
  assert.equal(checks.find((check) => check.name === "Docker memory").ok, true);
  assert.equal(checks.find((check) => check.name === "Docker CPU").ok, true);
  for (const engineMemoryBytes of [undefined, null, 0]) {
    assert.equal(launcher.installResourceChecks({ ...resources, engineMemoryBytes }, "small").length, 3);
  }
});

test("Podman automatic sizing applies the large profile's eight CPU allocation floor", () => {
  const GiB = 1024 ** 3;
  const resources = { cpuCount: 16, totalMemoryBytes: 32 * GiB, freeDiskBytes: 50 * GiB,
    engineName: "Podman", engineCpuCount: 4, engineMemoryBytes: 7 * GiB };
  assert.equal(launcher.installResourceChecks(resources, "large").find(check => check.name === "Podman CPU").ok, false);
  assert.equal(launcher.resolveInstallProfile("auto", resources), "medium");
  assert.equal(launcher.resolveInstallProfile("auto", { ...resources, engineCpuCount: 8 }), "large");
  assert.equal(launcher.installResourceChecks({ ...resources, engineName: "Docker" }, "large").find(check => check.name === "Docker CPU").ok, true);
});
