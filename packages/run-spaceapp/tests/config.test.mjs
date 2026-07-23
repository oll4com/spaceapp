import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addWorkspace,
  createDefaultConfig,
  initializeInstallation,
  loadConfig,
  resolveSpaceAppHome,
  saveConfig
} from "../src/index.mjs";

test("resolves an explicit home before platform defaults", () => {
  assert.equal(
    resolveSpaceAppHome({
      env: { SPACEAPP_HOME: "/opt/test-spaceapp" },
      platform: "linux",
      home: "/home/alice"
    }),
    "/opt/test-spaceapp"
  );
});

test("default config is versioned, loopback-only, and contains no secret fields", () => {
  const config = createDefaultConfig({ version: "0.1.0-alpha.1" });
  assert.deepEqual(config, {
    schemaVersion: 1,
    version: "0.1.0-alpha.1",
    previousVersion: null,
    bindHost: "127.0.0.1",
    port: 4911,
    telemetry: false,
    profile: "full",
    workspaces: []
  });
  assert.doesNotMatch(JSON.stringify(config), /password|secret|token|api.?key/i);
});

test("config persists atomically with owner-only permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-config-"));
  const config = createDefaultConfig({ version: "0.1.0-alpha.1" });

  await saveConfig(root, config);

  assert.deepEqual(await loadConfig(root), config);
  assert.equal((await stat(join(root, "config.json"))).mode & 0o777, 0o600);
});

test("workspace registration accepts only existing absolute directories and avoids duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-workspace-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  const config = createDefaultConfig({ version: "0.1.0-alpha.1" });

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
    ...createDefaultConfig({ version: "0.1.0-alpha.1" }),
    apiKey: "must-not-be-written"
  };

  await assert.rejects(() => saveConfig(root, config), /secret/i);
  await assert.rejects(() => readFile(join(root, "config.json"), "utf8"));
});

test("initialization creates idempotent non-config secrets with restrictive permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-init-"));
  const templateDir = join(root, "templates");
  await mkdir(templateDir);
  await writeFile(join(templateDir, "compose.yml"), "services: {}\n");

  const first = await initializeInstallation(root, {
    version: "0.1.0-alpha.1",
    templateDir
  });
  const passwordBefore = await readFile(join(root, "secrets", "postgres-password"), "utf8");
  const second = await initializeInstallation(root, {
    version: "0.1.0-alpha.1",
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
    assert.equal((await stat(join(root, "secrets", file))).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(
    await readFile(join(root, "config.json"), "utf8"),
    /password|secret|token|api.?key/i
  );
});
