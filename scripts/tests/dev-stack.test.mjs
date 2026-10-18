import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEV_PORTS,
  buildDevStackEnvironment,
  ensureDevStackSecrets,
  readPinnedInfraImages,
  readPinnedOpenCodePackage,
  renderDevStackCompose,
  resolveDevStackConfig
} from "../dev-stack.mjs";
import { assertOwnedState, runDevStackReset, runDevStackDown } from "../dev-stack.mjs";
import { devInstanceIsolationProblems } from "../../packages/contracts/src/space-instance.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

test("reads digest-pinned PostgreSQL and Temporal images directly from the launcher template", async () => {
  const templatePath = join(root, "packages/run-spaceapp/templates/compose.yml");
  const templateText = await readFile(templatePath, "utf8");
  const images = await readPinnedInfraImages(templatePath);

  assert.match(images.postgresImage, /^pgvector\/pgvector:[^\s]+@sha256:[0-9a-f]{64}$/);
  assert.match(images.temporalImage, /^temporalio\/auto-setup:[^\s]+@sha256:[0-9a-f]{64}$/);
  assert.ok(templateText.includes(images.postgresImage));
  assert.ok(templateText.includes(images.temporalImage));

  const openCodePkg = await readPinnedOpenCodePackage(join(root, "Dockerfile"));
  assert.match(openCodePkg, /^opencode-ai@\d+\.\d+\.\d+$/);
});

test("rejects malformed, duplicate and installed ports and dangerous state roots", () => {
  for (const value of ["15432suffix", "-5", "3.1", "4910", "4911", "65536"]) {
    assert.throws(() => resolveDevStackConfig({ SPACE_DEV_API_PORT: value }, root));
  }
  assert.throws(() => resolveDevStackConfig({ SPACE_DEV_WEB_PORT: "14910" }, root), /distinct/);
  for (const state of [root, "/", resolve(root, "..")]) assert.throws(() => resolveDevStackConfig({ SPACE_DEV_STACK_DIR: state }, root));
  assert.throws(() => resolveDevStackConfig({ SPACE_DEV_STACK_PROJECT: "spaceapp" }, root));
});

test("source environment satisfies both real isolation guards and discards installed settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-env-"));
  try {
    const config = resolveDevStackConfig({ SPACE_DEV_STACK_DIR: dir }, root);
    const secrets = await ensureDevStackSecrets(config);
    const env = buildDevStackEnvironment(config, secrets, { PATH: "/usr/bin", SPACE_INSTANCE_ENABLED_JOBS: "telegram-bridge", SPACE_CLI_ROOT_ENABLED: "true", SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.invalid", OPENAI_API_KEY: "private-fixture" });
    assert.deepEqual(devInstanceIsolationProblems(env, "api"), []);
    assert.deepEqual(devInstanceIsolationProblems(env, "worker"), []);
    assert.equal(env.SPACE_INSTANCE_ENABLED_JOBS, "");
    assert.equal(env.SPACE_CLI_ROOT_ENABLED, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
    assert.deepEqual(await ensureDevStackSecrets(config), secrets);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reset refuses nonempty foreign state and symlinked state without removing sentinel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-foreign-"));
  const link = `${dir}-link`;
  try {
    await writeFile(join(dir, "sentinel"), "keep");
    const config = resolveDevStackConfig({ SPACE_DEV_STACK_DIR: dir }, root);
    await assert.rejects(assertOwnedState(config, true), /unowned/);
    await assert.rejects(runDevStackReset(config), /unowned/);
    await symlink(dir, link);
    await assert.rejects(ensureDevStackSecrets(resolveDevStackConfig({ SPACE_DEV_STACK_DIR: link }, root)), /unsafe/);
    assert.equal(await readFile(join(dir, "sentinel"), "utf8"), "keep");
  } finally { await rm(link, { force: true }); await rm(dir, { recursive: true, force: true }); }
});

test("down never signals a recorded PID when its supervisor cannot authenticate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stack-pid-"));
  try {
    const config = resolveDevStackConfig({ SPACE_DEV_STACK_DIR: dir }, root);
    await ensureDevStackSecrets(config);
    await writeFile(config.pidFile, JSON.stringify({ supervisorPid: process.pid }));
    await assert.rejects(runDevStackDown(config), /Refusing to signal/);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("isolates ports, project name, state directory, and 0600 secrets from an installed SpaceApp", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "spaceapp-dev-stack-test-"));
  try {
    const config = resolveDevStackConfig({ SPACE_DEV_STACK_DIR: stateDir }, root);
    assert.equal(config.bindHost, "127.0.0.1");
    assert.equal(config.webPort, DEFAULT_DEV_PORTS.web);
    assert.equal(config.apiPort, DEFAULT_DEV_PORTS.api);
    assert.notEqual(config.webPort, 4911);
    assert.notEqual(config.apiPort, 4910);
    assert.ok(Buffer.byteLength(config.cliSocketPath) <= 100);

    assert.throws(
      () => resolveDevStackConfig({ SPACE_DEV_BIND_HOST: "0.0.0.0" }, root),
      /127\.0\.0\.1/
    );
    assert.throws(
      () => resolveDevStackConfig({ SPACE_DEV_WEB_PORT: "4911" }, root),
      /collides/
    );

    const secrets = await ensureDevStackSecrets(config);
    for (const file of [
      secrets.postgresPasswordFile,
      secrets.sessionSecretFile,
      secrets.setupTokenFile,
      secrets.databaseUrlFile
    ]) {
      const info = await stat(file);
      assert.equal(info.mode & 0o777, 0o600, `${file} must be mode 0600`);
    }

    const images = await readPinnedInfraImages(join(root, "packages/run-spaceapp/templates/compose.yml"));
    const compose = renderDevStackCompose(config, images);
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${config.postgresPort}:5432`));
    assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${config.temporalPort}:7233`));
    assert.doesNotMatch(compose, /0\.0\.0\.0/);

    const env = buildDevStackEnvironment(config, secrets, { PATH: "/usr/bin:/bin" });
    assert.equal(env.SPACE_DEV_LOGIN, "false");
    assert.equal(env.SPACE_API_HOST, "127.0.0.1");
    assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
    assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
    assert.equal(env.SPACE_CLI_HOST_SOCKET, config.cliSocketPath);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
