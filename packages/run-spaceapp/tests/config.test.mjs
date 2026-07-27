import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  addWorkspace,
  commitInstallation,
  createDefaultConfig,
  initializeInstallation,
  loadConfig,
  prepareInstallation,
  renderHostAccessCompose,
  resolveInstallAccessMode,
  resolveInstallProfile,
  resolveSpaceAppHome,
  saveConfig
} from "../src/index.mjs";

test("resolves an explicit home before platform defaults", () => {
  const explicitHome = resolve(tmpdir(), "test-spaceapp");
  assert.equal(
    resolveSpaceAppHome({
      env: { SPACEAPP_HOME: explicitHome },
      platform: process.platform,
      home: resolve(tmpdir(), "ignored-home")
    }),
    explicitHome
  );
});

test("default config is versioned, loopback-only, and contains no secret fields", () => {
  const config = createDefaultConfig({ version: "0.1.0" });
  assert.deepEqual(config, {
    schemaVersion: 3,
    version: "0.1.0",
    previousVersion: null,
    bindHost: "127.0.0.1",
    port: 4911,
    telemetry: false,
    profile: "light",
    accessMode: "isolated",
    workspaces: []
  });
  assert.doesNotMatch(JSON.stringify(config), /password|secret|token|api.?key/i);
});

test("install access defaults to isolated and host-root remains explicit", () => {
  assert.equal(resolveInstallAccessMode(undefined), "isolated");
  assert.equal(resolveInstallAccessMode(undefined, "host-root"), "host-root");
  assert.equal(resolveInstallAccessMode("isolated", "host-root"), "isolated");
  assert.equal(resolveInstallAccessMode("host-root", "isolated"), "host-root");
  assert.throws(() => resolveInstallAccessMode("root", "isolated"), /isolated or host-root/i);
});

test("auto profile defaults to light at every supported memory size and standard stays explicit", () => {
  const gibibyte = 1024 ** 3;

  assert.equal(resolveInstallProfile("auto", 8 * gibibyte), "light");
  assert.equal(resolveInstallProfile("auto", 12 * gibibyte), "light");
  assert.equal(resolveInstallProfile("auto", 64 * gibibyte), "light");
  assert.equal(resolveInstallProfile("light", 64 * gibibyte), "light");
  assert.equal(resolveInstallProfile("standard", 8 * gibibyte), "standard");
  assert.throws(() => resolveInstallProfile("full", 16 * gibibyte), /auto, light, or standard/i);
});

test("loads legacy full and core profiles through the stable schema migration", async () => {
  for (const [legacyProfile, stableProfile] of [["full", "standard"], ["core", "light"]]) {
    const root = await mkdtemp(join(tmpdir(), `spaceapp-config-migration-${legacyProfile}-`));
    await writeFile(join(root, "config.json"), `${JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0",
      previousVersion: null,
      bindHost: "127.0.0.1",
      port: 4911,
      telemetry: false,
      profile: legacyProfile,
      workspaces: []
    })}\n`);

    assert.deepEqual(await loadConfig(root), {
      schemaVersion: 3,
      version: "0.1.0",
      previousVersion: null,
      bindHost: "127.0.0.1",
      port: 4911,
      telemetry: false,
      profile: stableProfile,
      accessMode: "isolated",
      workspaces: []
    });
  }
});

test("loads schema 2 installations as isolated without changing durable settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-config-schema-2-"));
  await writeFile(join(root, "config.json"), `${JSON.stringify({
    schemaVersion: 2,
    version: "0.1.14",
    previousVersion: "0.1.10",
    bindHost: "127.0.0.1",
    port: 4911,
    telemetry: false,
    profile: "light",
    workspaces: []
  })}\n`);

  assert.deepEqual(await loadConfig(root), {
    schemaVersion: 3,
    version: "0.1.14",
    previousVersion: "0.1.10",
    bindHost: "127.0.0.1",
    port: 4911,
    telemetry: false,
    profile: "light",
    accessMode: "isolated",
    workspaces: []
  });
});

test("host-root Compose access is explicit, bounded, and reversible", () => {
  const isolated = createDefaultConfig({ version: "0.1.15-hostroot.0" });
  assert.equal(renderHostAccessCompose(isolated), "services: {}\n");

  const hostRoot = {
    ...isolated,
    accessMode: "host-root"
  };
  const compose = renderHostAccessCompose(hostRoot);

  assert.match(compose, /spaceapp-core:[\s\S]*source: "\/"[\s\S]*target: "\/host"[\s\S]*read_only: true/);
  assert.match(compose, /spaceapp-cli:[\s\S]*source: "\/"[\s\S]*target: "\/host"[\s\S]*read_only: false/);
  assert.match(compose, /SPACEAPP_CLI_HOST_ROOT_ACCESS: "true"/);
  assert.match(compose, /SPACE_CLI_WORKSPACE_ROOT: "\/host"/);
  assert.match(compose, /propagation: rslave/);
  assert.doesNotMatch(compose, /docker\.sock|privileged:|network_mode:|pid:|ipc:|devices:/);
});

test("config persists atomically with owner-only POSIX permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-config-"));
  const config = createDefaultConfig({ version: "0.1.0" });

  await saveConfig(root, config);

  assert.deepEqual(await loadConfig(root), config);
  await assertOwnerOnlyFile(join(root, "config.json"));
});

test("workspace registration accepts only existing absolute directories and avoids duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-workspace-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  const config = createDefaultConfig({ version: "0.1.0" });

  const once = await addWorkspace(config, workspace);
  const twice = await addWorkspace(once, workspace);

  assert.equal(once.workspaces.length, 1);
  assert.equal(once.workspaces[0].hostPath, workspace);
  assert.equal(once.workspaces[0].containerPath, "/workspaces/project");
  assert.deepEqual(twice, once);
  await assert.rejects(() => addWorkspace(config, "relative/project"), /absolute/i);
});

test("saved config rejects secret-shaped fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-secret-config-"));
  const config = {
    ...createDefaultConfig({ version: "0.1.0" }),
    apiKey: "must-not-be-written"
  };

  await assert.rejects(() => saveConfig(root, config), /secret/i);
  await assert.rejects(() => readFile(join(root, "config.json"), "utf8"));
});

test("initialization creates idempotent secrets with owner-only POSIX permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-init-"));
  const templateDir = join(root, "templates");
  await mkdir(templateDir);
  await writeFile(join(templateDir, "compose.yml"), "services: {}\n");

  const first = await initializeInstallation(root, {
    version: "0.1.0",
    templateDir
  });
  const passwordBefore = await readFile(join(root, "secrets", "postgres-password"), "utf8");
  const second = await initializeInstallation(root, {
    version: "0.1.0",
    templateDir
  });

  assert.equal(first.setupToken?.length > 30, true);
  assert.equal(second.setupToken, null);
  assert.equal(
    await readFile(join(root, "secrets", "postgres-password"), "utf8"),
    passwordBefore
  );
  assert.match(
    await readFile(join(root, "secrets", "database-url"), "utf8"),
    /^postgresql:\/\/spaceapp:[^@]+@postgres:5432\/spaceapp$/
  );
  for (const file of ["setup-token", "session-secret", "postgres-password", "database-url"]) {
    await assertOwnerOnlyFile(join(root, "secrets", file));
  }
  assert.doesNotMatch(
    await readFile(join(root, "config.json"), "utf8"),
    /password|secret|token|api.?key/i
  );
});

test("initialization resolves the auto profile on a clean install", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-init-auto-profile-"));
  const templateDir = join(root, "templates");
  await mkdir(templateDir);
  await writeFile(join(templateDir, "compose.yml"), "services: {}\n");

  const result = await initializeInstallation(root, {
    version: "0.1.11",
    templateDir,
    profile: "auto",
    accessMode: "host-root"
  });

  assert.equal(result.config.profile, "light");
  assert.equal(result.config.accessMode, "host-root");
  assert.equal((await loadConfig(root)).profile, "light");
  assert.match(
    await readFile(join(root, "compose.host-access.yml"), "utf8"),
    /SPACEAPP_CLI_HOST_ROOT_ACCESS: "true"/
  );
});

test("initialization synchronizes an existing install to the launcher version and preserves rollback and secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-init-version-sync-"));
  const templateDir = join(root, "templates");
  await mkdir(templateDir);
  await writeFile(join(templateDir, "compose.yml"), "services: {}\n");

  await initializeInstallation(root, {
    version: "0.1.10",
    templateDir,
    profile: "standard"
  });
  const passwordBefore = await readFile(join(root, "secrets", "postgres-password"), "utf8");

  const result = await initializeInstallation(root, {
    version: "0.1.11",
    templateDir,
    profile: "light",
    accessMode: "host-root"
  });

  assert.equal(result.config.version, "0.1.11");
  assert.equal(result.config.previousVersion, "0.1.10");
  assert.equal(result.config.profile, "light");
  assert.equal(result.config.accessMode, "host-root");
  assert.equal(
    await readFile(join(root, "secrets", "postgres-password"), "utf8"),
    passwordBefore
  );
  assert.deepEqual(await loadConfig(root), result.config);
});

test("installation preparation defers committed version and runtime changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-prepare-version-sync-"));
  const templateDir = join(root, "templates");
  await mkdir(templateDir);
  await writeFile(join(templateDir, "compose.yml"), "services: {}\n");
  await initializeInstallation(root, {
    version: "0.1.10",
    templateDir,
    profile: "standard"
  });
  const committedConfig = await readFile(join(root, "config.json"), "utf8");
  const committedRuntime = await readFile(join(root, "runtime.env"), "utf8");

  const prepared = await prepareInstallation(root, {
    version: "0.1.13",
    profile: "light",
    accessMode: "host-root"
  });

  assert.equal(prepared.config.version, "0.1.13");
  assert.equal(prepared.config.previousVersion, "0.1.10");
  assert.equal(prepared.config.profile, "light");
  assert.equal(prepared.config.accessMode, "host-root");
  assert.equal(await readFile(join(root, "config.json"), "utf8"), committedConfig);
  assert.equal(await readFile(join(root, "runtime.env"), "utf8"), committedRuntime);

  await commitInstallation(root, prepared.config, { templateDir });
  assert.deepEqual(await loadConfig(root), prepared.config);
  assert.match(await readFile(join(root, "runtime.env"), "utf8"), /^SPACEAPP_IMAGE_TAG=0\.1\.13$/m);
});

async function assertOwnerOnlyFile(path) {
  const metadata = await stat(path);
  assert.equal(metadata.isFile(), true);
  if (process.platform !== "win32") {
    assert.equal(metadata.mode & 0o777, 0o600);
  }
}
