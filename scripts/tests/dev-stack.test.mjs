import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  SupervisingRunner,
  defaultRepoRoot,
  downDevStack,
  ensureDevStackSecrets,
  generateDevStackComposeYaml,
  parseCommand,
  parsePinnedImagesFromCompose,
  parsePinnedOpenCodePackageFromDockerfile,
  resetDevStack,
  resolveCliHostSocketPath,
  resolveDevStackConfig,
  validateSafeStateDir,
  waitForStackReadiness,
  writeDevStackCliWrappers
} from "../dev-stack.mjs";

test("parseCommand correctly resolves up, down, reset with or without dashes", () => {
  assert.equal(parseCommand([]), "up");
  assert.equal(parseCommand(["down"]), "down");
  assert.equal(parseCommand(["reset"]), "reset");
  assert.equal(parseCommand(["--down"]), "down");
  assert.equal(parseCommand(["--reset"]), "reset");
  assert.equal(parseCommand(["--", "down"]), "down");
  assert.equal(parseCommand(["--", "reset"]), "reset");
  assert.equal(parseCommand(["unknown"]), "up");
});

test("parsePinnedImagesFromCompose extracts postgres and temporal images with sha256 digests", () => {
  const composeSource = readFileSync(
    resolve(defaultRepoRoot, "packages", "run-spaceapp", "templates", "compose.yml"),
    "utf8"
  );
  const { postgresImage, temporalImage } = parsePinnedImagesFromCompose(composeSource);
  assert.match(postgresImage, /^pgvector\/pgvector:[^\s#]+@sha256:[0-9a-f]{64}$/);
  assert.match(temporalImage, /^temporalio\/auto-setup:[^\s#]+@sha256:[0-9a-f]{64}$/);
});

test("parsePinnedImagesFromCompose rejects unpinned or missing images", () => {
  assert.throws(
    () =>
      parsePinnedImagesFromCompose(`
services:
  postgres:
    image: postgres:16-alpine
  temporal:
    image: temporalio/auto-setup:1.25.2
`),
    /SHA256-pinned postgres service image/
  );
});

test("parsePinnedOpenCodePackageFromDockerfile extracts pinned OpenCode package from Dockerfile", () => {
  const dockerfileSource = readFileSync(resolve(defaultRepoRoot, "Dockerfile"), "utf8");
  const pkg = parsePinnedOpenCodePackageFromDockerfile(dockerfileSource);
  assert.match(pkg, /^(?:@opencode\/cli|opencode-ai)@[0-9]+\.[0-9]+\.[0-9]+/);
});

test("validateSafeStateDir refuses unsafe paths including root, repoRoot, HOME, and ~/.spaceapp", () => {
  assert.throws(() => validateSafeStateDir("", defaultRepoRoot), /non-empty/);
  assert.throws(() => validateSafeStateDir("/", defaultRepoRoot), /filesystem root/);
  assert.throws(() => validateSafeStateDir(defaultRepoRoot, defaultRepoRoot), /repository root/);
  assert.throws(() => validateSafeStateDir(homedir(), defaultRepoRoot), /equal to HOME/);
  assert.throws(
    () => validateSafeStateDir(join(homedir(), ".spaceapp"), defaultRepoRoot),
    /installed operator path/
  );
  assert.throws(
    () => validateSafeStateDir(join(homedir(), ".spaceapp", "nested"), defaultRepoRoot),
    /installed operator path/
  );

  const safePath = validateSafeStateDir(join(defaultRepoRoot, ".dev-stack"), defaultRepoRoot);
  assert.equal(safePath, resolve(defaultRepoRoot, ".dev-stack"));
});

test("resolveCliHostSocketPath keeps short socket paths inside stateDir and falls back on long paths", () => {
  const shortDir = "/tmp/space-dev";
  const shortSock = resolveCliHostSocketPath(shortDir, {});
  assert.equal(shortSock, resolve(shortDir, "var", "run", "cli-host.sock"));

  const longDir = join(
    tmpdir(),
    "very-deeply-nested-directory-segment-one",
    "very-deeply-nested-directory-segment-two",
    "very-deeply-nested-directory-segment-three"
  );
  const fallbackSock = resolveCliHostSocketPath(longDir, {});
  assert.ok(
    fallbackSock.length <= 96,
    `Expected fallback socket path <= 96 chars, got ${fallbackSock.length}: ${fallbackSock}`
  );
});

test("ensureDevStackSecrets, generateDevStackComposeYaml, and writeDevStackCliWrappers isolate all state under stateDir", () => {
  const tempStateDir = mkdtempSync(join(tmpdir(), "spaceapp-dev-stack-test-"));
  try {
    const config = resolveDevStackConfig({
      repoRoot: defaultRepoRoot,
      stateDir: tempStateDir,
      postgresPort: 25432,
      temporalPort: 27233,
      apiPort: 14910,
      webPort: 14911
    });

    const secrets1 = ensureDevStackSecrets(config);
    assert.ok(secrets1.postgresPassword.length >= 32);
    assert.ok(secrets1.sessionSecret.length >= 32);
    assert.ok(secrets1.setupToken.length >= 24);
    assert.equal(
      secrets1.databaseUrl,
      `postgresql://spaceapp:${secrets1.postgresPassword}@127.0.0.1:25432/spaceapp`
    );

    if (process.platform !== "win32") {
      const mode = statSync(secrets1.setupTokenPath).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    // Secrets are reused across restarts until reset
    const secrets2 = ensureDevStackSecrets(config);
    assert.equal(secrets2.postgresPassword, secrets1.postgresPassword);
    assert.equal(secrets2.sessionSecret, secrets1.sessionSecret);
    assert.equal(secrets2.setupToken, secrets1.setupToken);

    const yaml = generateDevStackComposeYaml(config);
    assert.match(yaml, /127\.0\.0\.1:25432:5432/);
    assert.match(yaml, /127\.0\.0\.1:27233:7233/);
    assert.match(yaml, /POSTGRES_PASSWORD_FILE: \/run\/secrets\/postgres_password/);
    assert.ok(!yaml.includes(secrets1.postgresPassword), "Compose YAML must not inline secret values");

    const wrappers = writeDevStackCliWrappers(config);
    assert.ok(existsSync(wrappers.openCodeWrapperPath));
    assert.ok(existsSync(wrappers.parityWrapperPath));
    assert.ok(existsSync(wrappers.credentialStatusPath));
    assert.ok(existsSync(wrappers.credentialObservationPath));
    assert.ok(existsSync(wrappers.credentialSmokePath));
    assert.ok(existsSync(wrappers.inspectEnvPath));

    const parityContent = readFileSync(wrappers.parityWrapperPath, "utf8");
    assert.match(parityContent, /export HOME="\$\{STATE_CLI_DIR\}\/home"/);
    assert.match(parityContent, /export XDG_CONFIG_HOME="\$\{STATE_CLI_DIR\}\/xdg-config"/);
    assert.match(parityContent, /credential-status\)/);
    assert.match(parityContent, /SPACE_OPENCODE_OK/);

    // Verify repo root bin/ was never created
    assert.equal(existsSync(resolve(defaultRepoRoot, "bin")), false);
  } finally {
    rmSync(tempStateDir, { recursive: true, force: true });
  }
});

test("SupervisingRunner fails fast, terminates sibling processes, and aborts waitForStackReadiness when one child exits unexpectedly", async () => {
  const logs = [];
  const logger = {
    log: (msg) => logs.push(msg),
    error: (msg) => logs.push(msg)
  };

  const specs = [
    {
      name: "cli-host",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: defaultRepoRoot,
      env: process.env
    },
    {
      name: "worker",
      command: process.execPath,
      args: ["-e", "setTimeout(() => { console.error('worker fatal'); process.exit(42); }, 120);"],
      cwd: defaultRepoRoot,
      env: process.env
    },
    {
      name: "api",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: defaultRepoRoot,
      env: process.env
    }
  ];

  const runner = new SupervisingRunner(specs, { logger, killGraceMs: 1_000 });
  runner.startAll();

  await assert.rejects(
    () =>
      waitForStackReadiness({
        apiPort: 59998,
        webPort: 59999,
        runner,
        timeoutMs: 10_000,
        pollIntervalMs: 100
      }),
    (err) => {
      assert.match(err.message, /Supervised process "worker" exited unexpectedly/);
      assert.equal(err.processName, "worker");
      assert.equal(err.exitCode, 42);
      return true;
    }
  );

  assert.equal(runner.children.size, 0, "All sibling processes must be terminated after failure");
});

test("downDevStack and resetDevStack stop recorded processes, clean sockets, invoke docker compose down, and remove stateDir on reset", async () => {
  const tempStateDir = mkdtempSync(join(tmpdir(), "spaceapp-dev-stack-reset-"));
  const config = resolveDevStackConfig({
    repoRoot: defaultRepoRoot,
    stateDir: tempStateDir,
    env: {}
  });
  ensureDevStackSecrets(config);
  writeFileSync(config.composeFilePath, generateDevStackComposeYaml(config), "utf8");
  writeFileSync(config.cliHostSocketPath, "", "utf8");

  const dockerCalls = [];
  const runCommand = (cmd, args) => {
    dockerCalls.push({ cmd, args });
    return { status: 0 };
  };

  await downDevStack(config, { runCommand });
  assert.equal(existsSync(config.cliHostSocketPath), false);
  assert.equal(existsSync(config.stateDir), true);
  assert.equal(dockerCalls.length, 1);
  assert.equal(dockerCalls[0].cmd, "docker");
  assert.ok(dockerCalls[0].args.includes("down"));
  assert.ok(!dockerCalls[0].args.includes("-v"));

  await resetDevStack(config, { runCommand });
  assert.equal(existsSync(config.stateDir), false);
  assert.equal(dockerCalls.length, 2);
  assert.ok(dockerCalls[1].args.includes("-v"));
});
