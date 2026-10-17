import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORTS,
  ensureDevStackSecrets,
  ensureOpenCodeWrapperAndVendor,
  extractComposeImages,
  extractOpenCodePackageSpec,
  renderDevComposeFile,
  resolveDevStackConfig,
  superviseProcesses
} from "../dev-stack.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("extractComposeImages reads digest-pinned postgres and temporal images from the launcher template", async () => {
  const composeTemplate = await readFile(
    join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml"),
    "utf8"
  );
  const { postgresImage, temporalImage } = extractComposeImages(composeTemplate);

  assert.match(postgresImage, /^pgvector\/pgvector:[^\s@]+@sha256:[0-9a-f]{64}$/);
  assert.match(temporalImage, /^temporalio\/auto-setup:[^\s@]+@sha256:[0-9a-f]{64}$/);
  assert.throws(() => extractComposeImages("services:\n  postgres:\n    image: postgres:16\n"), /digest-pinned/);
});

test("extractOpenCodePackageSpec reads the pinned opencode-ai package from Dockerfile", async () => {
  const dockerfile = await readFile(join(repoRoot, "Dockerfile"), "utf8");
  const spec = extractOpenCodePackageSpec(dockerfile);

  assert.match(spec, /^opencode-ai@\d+\.\d+\.\d+/);
  assert.throws(() => extractOpenCodePackageSpec("FROM node:22-bookworm-slim\n"), /opencode-ai/);
});

test("resolveDevStackConfig isolates ports, project name, and state directory from an installed instance", () => {
  const config = resolveDevStackConfig({}, repoRoot);

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.composeProjectName, "spaceapp-dev-stack");
  assert.equal(config.stateDir, join(repoRoot, ".dev-stack"));
  assert.deepEqual(config.ports, DEFAULT_PORTS);
  assert.notEqual(config.ports.api, 4910);
  assert.notEqual(config.ports.web, 4911);

  const custom = resolveDevStackConfig(
    {
      SPACE_DEV_WEB_PORT: "24911",
      SPACE_DEV_API_PORT: "24910",
      SPACE_DEV_POSTGRES_PORT: "25432",
      SPACE_DEV_TEMPORAL_PORT: "27233",
      SPACE_DEV_STACK_STATE_DIR: ".custom-dev-stack",
      SPACE_DEV_STACK_COMPOSE_PROJECT: "spaceapp-custom-dev"
    },
    repoRoot
  );
  assert.deepEqual(custom.ports, {
    web: 24911,
    api: 24910,
    postgres: 25432,
    temporal: 27233
  });
  assert.equal(custom.stateDir, join(repoRoot, ".custom-dev-stack"));
  assert.equal(custom.composeProjectName, "spaceapp-custom-dev");

  assert.throws(
    () => resolveDevStackConfig({ SPACE_DEV_WEB_PORT: "14910", SPACE_DEV_API_PORT: "14910" }, repoRoot),
    /Port collision/
  );
  assert.throws(
    () => resolveDevStackConfig({ SPACE_DEV_STACK_COMPOSE_PROJECT: "spaceapp" }, repoRoot),
    /must not be 'spaceapp'/
  );
});

test("renderDevComposeFile binds PostgreSQL and Temporal ports strictly to 127.0.0.1", async () => {
  const composeTemplate = await readFile(
    join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml"),
    "utf8"
  );
  const { postgresImage, temporalImage } = extractComposeImages(composeTemplate);
  const rendered = renderDevComposeFile({
    postgresImage,
    temporalImage,
    postgresPort: 15432,
    temporalPort: 17233,
    postgresPasswordFile: "/tmp/dev-stack/secrets/postgres-password"
  });

  assert.match(rendered, new RegExp(postgresImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, new RegExp(temporalImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(rendered, /- "127\.0\.0\.1:15432:5432"/);
  assert.match(rendered, /- "127\.0\.0\.1:17233:7233"/);
  for (const portMapping of rendered.matchAll(/^\s*-\s*"([^"]+:\d+)"\s*$/gm)) {
    assert.match(portMapping[1], /^127\.0\.0\.1:\d+:\d+$/);
  }
});

test("ensureDevStackSecrets generates per-state-directory secrets with mode 0600 and preserves them across runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-secrets-"));
  try {
    const first = await ensureDevStackSecrets(root, 15432);
    const second = await ensureDevStackSecrets(root, 15432);

    assert.equal(first.postgresPassword, second.postgresPassword);
    assert.equal(first.sessionSecret, second.sessionSecret);
    assert.equal(first.setupToken, second.setupToken);
    assert.match(first.databaseUrl, /^postgresql:\/\/spaceapp:[0-9a-f]{48}@127\.0\.0\.1:15432\/spaceapp$/);

    if (process.platform !== "win32") {
      for (const filePath of [
        first.postgresPasswordPath,
        first.sessionSecretPath,
        first.setupTokenPath,
        first.databaseUrlPath
      ]) {
        const fileStat = await stat(filePath);
        assert.equal(fileStat.mode & 0o777, 0o600, `${filePath} must be mode 0600`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureOpenCodeWrapperAndVendor writes state-dir wrapper and provider config without global state", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-opencode-"));
  try {
    const result = await ensureOpenCodeWrapperAndVendor({
      stateDir: root,
      repoRoot,
      installVendor: false
    });
    const wrapper = await readFile(result.wrapperPath, "utf8");
    const opencodeConfig = JSON.parse(
      await readFile(join(result.providerRoot, "config", "opencode", "opencode.json"), "utf8")
    );

    assert.match(wrapper, /credential-status\)/);
    assert.match(wrapper, /credential-observation\)/);
    assert.match(wrapper, /credential-smoke\)/);
    assert.ok(wrapper.includes(JSON.stringify(join(result.vendorDir, "node_modules", ".bin", "opencode"))));
    assert.equal(opencodeConfig.permission.external_directory["*"], "ask");
    assert.equal(opencodeConfig.permission.external_directory[`${join(result.providerRoot, "tmp")}/*`], "allow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("superviseProcesses surfaces a clear failure and stops remaining processes when one child exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-supervisor-"));
  const workerScript = join(root, "worker.mjs");
  const keepAliveScript = join(root, "keepalive.mjs");
  await writeFile(workerScript, "setTimeout(() => process.exit(2), 80);\n", "utf8");
  await writeFile(keepAliveScript, "setInterval(() => {}, 1000);\n", "utf8");

  const errorLines = [];
  let supervisor = null;
  try {
    supervisor = superviseProcesses(
      [
        { name: "api", command: process.execPath, args: [keepAliveScript], cwd: root, env: process.env },
        { name: "worker", command: process.execPath, args: [workerScript], cwd: root, env: process.env }
      ],
      {
        onLog: () => {},
        onErrorLog: (line) => errorLines.push(line)
      }
    );

    const pids = supervisor.getPids();
    assert.ok(pids.api > 0);
    assert.ok(pids.worker > 0);

    await assert.rejects(
      supervisor.failurePromise,
      /Process "worker" exited unexpectedly \(exit code 2\)/
    );
    assert.ok(errorLines.some((line) => line.includes('Process "worker" exited unexpectedly')));
  } finally {
    await supervisor?.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
