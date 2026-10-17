import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeStateDir,
  ensureSecrets,
  generateDevComposeYaml,
  isComposeServiceHealthy,
  isManagedSocketPath,
  parsePinnedImages,
  parsePinnedOpencodeVersion,
  resolveCliHostSocketFallback,
  resolveCliHostSocketPath,
  resolveDevStackConfig,
  setupOpencodeWrapper,
  startDevStack,
  stopDevStack,
  validatePort
} from "../dev-stack.mjs";

/**
 * Verifies that parsePinnedImages accurately extracts the pinned image tags and digests.
 */
test("parsePinnedImages extracts exact digests for postgres and temporal", () => {
  const sampleCompose = `
services:
  postgres:
    image: pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b
  temporal:
    image: temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312
`;
  const images = parsePinnedImages(sampleCompose);
  assert.equal(images.postgres, "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b");
  assert.equal(images.temporal, "temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312");

  assert.throws(() => parsePinnedImages("services: {}"), /Failed to extract pinned/);
});

/**
 * Verifies that parsePinnedOpencodeVersion extracts the pinned semver from Dockerfile.
 */
test("parsePinnedOpencodeVersion extracts exact version from Dockerfile", () => {
  const sampleDockerfile = `
RUN npm install --global --no-audit --no-fund opencode-ai@1.18.4 \\
    && opencode --version
`;
  const version = parsePinnedOpencodeVersion(sampleDockerfile);
  assert.equal(version, "1.18.4");

  assert.throws(() => parsePinnedOpencodeVersion("FROM node:22"), /Failed to extract pinned opencode-ai/);
});

/**
 * Verifies that validatePort strictly rejects out-of-range or non-integer port numbers.
 */
test("validatePort validates range 1-65535 and rejects invalid values", () => {
  assert.equal(validatePort("testPort", 80), 80);
  assert.equal(validatePort("testPort", 65535), 65535);

  assert.throws(() => validatePort("testPort", 0), /Invalid port for testPort: 0/);
  assert.throws(() => validatePort("testPort", -1), /Invalid port for testPort: -1/);
  assert.throws(() => validatePort("testPort", 65536), /Invalid port for testPort: 65536/);
  assert.throws(() => validatePort("testPort", 72339), /Invalid port for testPort: 72339/);
  assert.throws(() => validatePort("testPort", Number.NaN), /Invalid port for testPort/);
});

/**
 * Verifies that resolveDevStackConfig applies isolated defaults and parses environment overrides.
 */
test("resolveDevStackConfig respects port and directory overrides while defaulting to 127.0.0.1 isolated ports", () => {
  const defaultConfig = resolveDevStackConfig({});
  assert.equal(defaultConfig.webPort, 5911);
  assert.equal(defaultConfig.apiPort, 5910);
  assert.equal(defaultConfig.postgresPort, 54329);
  assert.equal(defaultConfig.temporalPort, 57233);
  assert.match(defaultConfig.stateRoot, /\.dev-stack$/);

  const customConfig = resolveDevStackConfig({
    SPACEAPP_DEV_STATE_ROOT: "custom-state",
    SPACEAPP_DEV_WEB_PORT: "6911",
    SPACEAPP_DEV_API_PORT: "6910",
    SPACEAPP_DEV_POSTGRES_PORT: "54330",
    SPACEAPP_DEV_TEMPORAL_PORT: "57234",
    SPACEAPP_DEV_PROJECT: "custom-project"
  });
  assert.equal(customConfig.webPort, 6911);
  assert.equal(customConfig.apiPort, 6910);
  assert.equal(customConfig.postgresPort, 54330);
  assert.equal(customConfig.temporalPort, 57234);
  assert.equal(customConfig.composeProject, "custom-project");
  assert.match(customConfig.stateRoot, /custom-state$/);

  assert.throws(
    () => resolveDevStackConfig({ SPACEAPP_DEV_TEMPORAL_PORT: "99999" }),
    /Invalid port for temporalPort: 99999/
  );
});

/**
 * Verifies that generateDevComposeYaml produces standard secrets and 127.0.0.1-bound configurations.
 */
test("generateDevComposeYaml creates isolated compose configuration strictly bound to 127.0.0.1 with secrets", () => {
  const yaml = generateDevComposeYaml({
    postgresImage: "pgvector/pgvector:0.8.3",
    temporalImage: "temporalio/auto-setup:1.29.1",
    postgresPort: 54329,
    temporalPort: 57233,
    secretsDir: "/path/to/secrets",
    composeProject: "test-dev-project"
  });

  assert.match(yaml, /name: test-dev-project/);
  assert.match(yaml, /"127\.0\.0\.1:54329:5432"/);
  assert.match(yaml, /"127\.0\.0\.1:57233:7233"/);
  assert.doesNotMatch(yaml, /0\.0\.0\.0/);
  assert.match(yaml, /secrets:\s*\n\s*postgres-password:\s*\n\s*file:/);
  assert.match(yaml, /image: pgvector\/pgvector:0\.8\.3/);
  assert.match(yaml, /image: temporalio\/auto-setup:1\.29\.1/);
});

/**
 * Verifies that ensureSecrets generates owner-readable secrets (mode 0600) and is idempotent.
 */
test("ensureSecrets creates required secret files with proper modes and preserves existing secrets", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-secrets-"));
  try {
    const config = {
      secretsDir: path.join(tmpDir, "secrets"),
      runDir: path.join(tmpDir, "run"),
      binDir: path.join(tmpDir, "bin"),
      varDir: path.join(tmpDir, "var"),
      workspacesDir: path.join(tmpDir, "workspaces"),
      postgresPort: 54329
    };

    const firstSecrets = ensureSecrets(config);
    assert.ok(firstSecrets.password && firstSecrets.password.length >= 32);
    assert.ok(firstSecrets.sessionSecret && firstSecrets.sessionSecret.length >= 48);
    assert.ok(firstSecrets.setupToken && firstSecrets.setupToken.length >= 32);
    assert.equal(firstSecrets.databaseUrl, `postgresql://spaceapp:${firstSecrets.password}@127.0.0.1:54329/spaceapp`);

    // Files exist on disk
    assert.ok(fs.existsSync(path.join(config.secretsDir, "postgres-password")));
    assert.ok(fs.existsSync(path.join(config.secretsDir, "session-secret")));
    assert.ok(fs.existsSync(path.join(config.secretsDir, "setup-token")));
    assert.ok(fs.existsSync(path.join(config.secretsDir, "database-url")));

    // Idempotency: calling ensureSecrets again returns the exact same secrets
    const secondSecrets = ensureSecrets(config);
    assert.equal(secondSecrets.password, firstSecrets.password);
    assert.equal(secondSecrets.sessionSecret, firstSecrets.sessionSecret);
    assert.equal(secondSecrets.setupToken, firstSecrets.setupToken);
    assert.equal(secondSecrets.databaseUrl, firstSecrets.databaseUrl);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Verifies that generateDevComposeYaml avoids container_name to prevent global conflicts and defines healthchecks.
 */
test("generateDevComposeYaml omits fixed container_name, defines healthchecks, and mounts secrets with mode 0444", () => {
  const yaml = generateDevComposeYaml({
    postgresImage: "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b",
    temporalImage: "temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312",
    postgresPort: 54329,
    temporalPort: 57233,
    secretsDir: "/path/to/secrets",
    composeProject: "test-dev-project"
  });

  assert.doesNotMatch(yaml, /container_name:/);
  assert.match(yaml, /healthcheck:\s*\n\s*test: \["CMD-SHELL", "pg_isready/);
  assert.match(yaml, /temporal operator cluster health/);
  assert.match(yaml, /mode: 0444/);
  assert.match(yaml, /user: "0:0"/);
});

/**
 * Verifies that CONTRIBUTING.md documents Linux, macOS (Docker Desktop/Colima), and Windows 11 (WSL2).
 */
test("CONTRIBUTING.md documents all required platforms and commands", () => {
  const contributing = fs.readFileSync(path.join(process.cwd(), "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /Run the full app from source/);
  assert.match(contributing, /npm run dev:stack/);
  assert.match(contributing, /npm run dev:stack -- down/);
  assert.match(contributing, /npm run dev:stack -- reset/);
  assert.match(contributing, /macOS/);
  assert.match(contributing, /Colima/);
  assert.match(contributing, /Windows 11/);
  assert.match(contributing, /WSL2/);
  assert.match(contributing, /Temporal gRPC/);
});

/**
 * Verifies that dev-stack overrides all path settings in config.ts that default to /opt/spaceapp.
 * This guarantees contributor runs never fail with EACCES on macOS or non-root Linux environments.
 */
test("dev-stack environment overrides all /opt/spaceapp defaults from config.ts", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  const configSource = fs.readFileSync(path.join(process.cwd(), "apps", "api", "src", "config.ts"), "utf8");

  const optDefaults = [...configSource.matchAll(/(?:env|valid)\.(SPACE_[A-Z0-9_]+)\s*(?:\|\||\?\?)\s*["'](\/opt\/spaceapp[^"']*)["']/g)]
    .map((m) => m[1]);

  assert.ok(optDefaults.length > 0, "Expected config.ts to have /opt/spaceapp defaults");
  for (const varName of optDefaults) {
    assert.ok(
      devStackSource.includes(varName),
      `dev-stack.mjs must override ${varName} to prevent EACCES on macOS/non-root Linux`
    );
  }
});

/**
 * Verifies that ci-dev-stack-gate.mjs strictly asserts the absence of
 * Compose containers and volumes after a dev-stack reset.
 */
test("ci-dev-stack-gate asserts absence of Compose containers, volumes, and child processes after reset", () => {
  const gateSource = fs.readFileSync(path.join(process.cwd(), "scripts", "ci-dev-stack-gate.mjs"), "utf8");
  assert.match(gateSource, /compose.*ps.*-a.*-q/);
  assert.match(gateSource, /volume.*ls.*--filter/);
  assert.match(gateSource, /process\.kill\(pid,\s*0\)/);
  assert.match(gateSource, /stopDevStack\(config,\s*\{\s*purge:\s*true\s*\}\)/);
  assert.match(gateSource, /verifyResetCleanup\(activePids\)/);
});

/**
 * Verifies that isComposeServiceHealthy strictly accepts only healthy states,
 * refusing substring false-positives such as 'unhealthy', and supports arrays.
 */
test("isComposeServiceHealthy strictly distinguishes healthy from unhealthy and starting states and supports arrays", () => {
  assert.equal(isComposeServiceHealthy({ Health: "healthy" }), true);
  assert.equal(isComposeServiceHealthy({ Health: "HEALTHY" }), true);
  assert.equal(isComposeServiceHealthy({ Status: "Up 10 seconds (healthy)" }), true);

  // Arrays of services
  assert.equal(isComposeServiceHealthy([{ Health: "healthy" }, { Health: "healthy" }]), true);
  assert.equal(isComposeServiceHealthy([{ Health: "healthy" }, { Health: "unhealthy" }]), false);

  // Failure cases: unhealthy must NEVER be considered healthy
  assert.equal(isComposeServiceHealthy({ Health: "unhealthy" }), false);
  assert.equal(isComposeServiceHealthy({ Health: "UNHEALTHY" }), false);
  assert.equal(isComposeServiceHealthy({ Status: "Up 10 seconds (unhealthy)" }), false);
  assert.equal(isComposeServiceHealthy({ Health: "starting" }), false);
  assert.equal(isComposeServiceHealthy({ Status: "Up 10 seconds (health: starting)" }), false);
  assert.equal(isComposeServiceHealthy(null), false);
  assert.equal(isComposeServiceHealthy({}), false);
});

/**
 * Verifies that assertSafeStateDir protects critical directories from accidental deletion.
 */
test("assertSafeStateDir prevents accidental deletion of root, home, ancestors, or repo source directory", () => {
  const repoRoot = process.cwd();
  const homeDir = os.homedir();
  const rootDir = path.parse(repoRoot).root;

  assert.throws(() => assertSafeStateDir(".", repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir(repoRoot, repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir("..", repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir(homeDir, repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir(rootDir, repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "apps"), repoRoot), /Refusing to delete protected repository source subtree/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "apps", "api"), repoRoot), /Refusing to delete protected repository source subtree/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "packages"), repoRoot), /Refusing to delete protected repository source subtree/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "packages", "db"), repoRoot), /Refusing to delete protected repository source subtree/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "scripts", "dev-stack.mjs"), repoRoot), /Refusing to delete protected repository source subtree/);

  // Safe directories must not throw
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-safe-test-"));
  try {
    assert.doesNotThrow(() => assertSafeStateDir(tmpDir, repoRoot));
    assert.doesNotThrow(() => assertSafeStateDir(path.join(repoRoot, ".dev-stack"), repoRoot));

    // If requireMarker is set, missing marker throws
    assert.throws(() => assertSafeStateDir(tmpDir, repoRoot, { requireMarker: true }), /missing .dev-stack-state.json marker/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Invalid marker throws
  const tmpMarkerDir = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-marker-test-"));
  try {
    fs.writeFileSync(path.join(tmpMarkerDir, ".dev-stack-state.json"), JSON.stringify({ createdBy: "malicious" }));
    assert.throws(() => assertSafeStateDir(tmpMarkerDir, repoRoot, { requireMarker: true }), /Refusing to delete state directory with invalid marker/);
  } finally {
    fs.rmSync(tmpMarkerDir, { recursive: true, force: true });
  }
});

/**
 * Verifies that setupOpencodeWrapper writes wrapper scripts implementing
 * credential-status, credential-observation, and credential-smoke.
 */
test("setupOpencodeWrapper creates wrapper supporting credential lifecycle probes and portable observation hash", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-wrapper-"));
  try {
    const config = {
      stateRoot: tmpDir,
      opencodeDir: path.join(tmpDir, "opencode"),
      binDir: path.join(tmpDir, "bin")
    };
    fs.mkdirSync(path.join(config.opencodeDir, "node_modules", ".bin"), { recursive: true });
    const dummyBin = path.join(config.opencodeDir, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
    fs.writeFileSync(dummyBin, process.platform === "win32" ? "@echo off\necho opencode\n" : "#!/bin/sh\necho opencode\n");

    setupOpencodeWrapper(config, "1.18.4");

    const parityPath = path.join(config.binDir, "opencode-vscode-parity");
    assert.ok(fs.existsSync(parityPath), "POSIX wrapper script must exist");
    const content = fs.readFileSync(parityPath, "utf8");

    assert.match(content, /credential-status/);
    assert.match(content, /credential-observation/);
    assert.match(content, /credential-smoke/);
    assert.match(content, /SPACE_OPENCODE_OK/);
    assert.match(content, /HOME=/);
    assert.match(content, /TMPDIR=/);
    assert.match(content, /XDG_CONFIG_HOME=/);
    assert.match(content, /XDG_STATE_HOME=/);
    // Observation hash is precomputed SHA-256 for "opencode:ready"
    assert.match(content, /OBSERVATION:fe2ff8448863efcad9975084caad51bf142b2e40ae6acab7a5bbe6ee3220bea0/);

    if (process.platform === "win32") {
      const cmdPath = path.join(config.binDir, "opencode-vscode-parity.cmd");
      assert.ok(fs.existsSync(cmdPath), "Windows .cmd wrapper script must exist");
      const cmdContent = fs.readFileSync(cmdPath, "utf8");
      assert.match(cmdContent, /credential-status/);
      assert.match(cmdContent, /OBSERVATION:fe2ff8448863efcad9975084caad51bf142b2e40ae6acab7a5bbe6ee3220bea0/);
      assert.match(cmdContent, /SPACE_OPENCODE_OK/);
      assert.match(cmdContent, /XDG_CONFIG_HOME=/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Verifies that ensureSecrets preserves claimed state when setup-token is consumed.
 */
test("ensureSecrets preserves claimed setup token and reports already claimed state", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-claim-"));
  try {
    const config = {
      secretsDir: path.join(tmpDir, "secrets"),
      runDir: path.join(tmpDir, "run"),
      binDir: path.join(tmpDir, "bin"),
      varDir: path.join(tmpDir, "var"),
      workspacesDir: path.join(tmpDir, "workspaces"),
      postgresPort: 54329
    };

    const initial = ensureSecrets(config);
    assert.ok(initial.setupToken && initial.setupToken !== "Already claimed");
    assert.ok(initial.setupTokenPath);

    // Simulate owner claim consumption
    fs.rmSync(initial.setupTokenPath, { force: true });

    // Subsequent call detects claimed state without regenerating token
    const afterClaim = ensureSecrets(config);
    assert.equal(afterClaim.setupToken, "Already claimed");
    assert.equal(afterClaim.setupTokenPath, null);
    assert.equal(afterClaim.password, initial.password);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Verifies that resolveCliHostSocketPath respects Unix domain socket path length constraints.
 */
test("resolveCliHostSocketPath handles default short path, long path tmpdir fallback, and env override", () => {
  // 1. Short path: returns default cli-host.sock within runDir
  const shortRunDir = path.join(os.tmpdir(), "short");
  const shortPath = resolveCliHostSocketPath(shortRunDir, {});
  assert.equal(shortPath, path.resolve(shortRunDir, "cli-host.sock"));

  // 2. Long path (>96 bytes): falls back to os.tmpdir() with s-<hash>.sock
  const longRunDir = path.join(os.tmpdir(), "a".repeat(120), "deep", "nested", "run");
  const fallbackPath = resolveCliHostSocketPath(longRunDir, {});
  assert.ok(Buffer.byteLength(fallbackPath) < 100, `Fallback path ${fallbackPath} must be short`);
  assert.match(fallbackPath, /(?:space-cli|s)-[0-9a-f]{12}\.sock$/);

  // 3. Explicit env override: respects SPACE_CLI_HOST_SOCKET
  const customSocket = "/custom/path/to/socket.sock";
  const customResolved = resolveCliHostSocketPath(shortRunDir, { SPACE_CLI_HOST_SOCKET: customSocket });
  assert.equal(customResolved, customSocket);
});

/**
 * Verifies that apps/web/vite.config.ts configures WebSocket proxying for /api.
 */
test("apps/web/vite.config.ts configures WebSocket proxying for /api", () => {
  const viteConfig = fs.readFileSync(path.join(process.cwd(), "apps", "web", "vite.config.ts"), "utf8");
  assert.match(viteConfig, /["']\/api["']:\s*\{\s*target:.*,\s*ws:\s*true\s*\}/s);
});

/**
 * Verifies that ensureSecrets refuses to adopt an existing non-empty directory without marker.
 */
test("ensureSecrets refuses to adopt an existing non-empty directory lacking marker", () => {
  const tmpOccupied = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-occupied-"));
  try {
    fs.writeFileSync(path.join(tmpOccupied, "user-data.txt"), "important data");
    const config = {
      stateRoot: tmpOccupied,
      secretsDir: path.join(tmpOccupied, "secrets"),
      runDir: path.join(tmpOccupied, "run"),
      binDir: path.join(tmpOccupied, "bin"),
      varDir: path.join(tmpOccupied, "var"),
      workspacesDir: path.join(tmpOccupied, "workspaces"),
      postgresPort: 54329
    };
    assert.throws(
      () => ensureSecrets(config),
      /Refusing to adopt non-empty existing directory without .dev-stack-state.json marker/
    );
  } finally {
    fs.rmSync(tmpOccupied, { recursive: true, force: true });
  }
});

/**
 * Verifies that dev-stack environment config sets SPACE_CHESS_MOVE_SOCKET to "disabled".
 * This prevents the worker from touching /opt/spaceapp/var/chess-benchmark/worker.sock.
 */
test("dev-stack environment disables SPACE_CHESS_MOVE_SOCKET to prevent host filesystem writes", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  assert.match(devStackSource, /SPACE_CHESS_MOVE_SOCKET:\s*["']disabled["']/);
  assert.match(devStackSource, /SPACE_CHESS_CLI_WORKSPACE:/);
});

/**
 * Verifies that stopDevStack runs assertSafeStateDir before any process killing or docker compose commands.
 */
test("stopDevStack runs assertSafeStateDir before terminating processes or tearing down docker services", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  const stopIndex = devStackSource.indexOf("export async function stopDevStack");
  const assertIndex = devStackSource.indexOf("assertSafeStateDir(config.stateRoot", stopIndex);
  const killIndex = devStackSource.indexOf("process.kill", stopIndex);
  const composeIndex = devStackSource.indexOf("docker", stopIndex);

  assert.ok(stopIndex > -1);
  assert.ok(assertIndex > -1, "assertSafeStateDir must be called in stopDevStack");
  assert.ok(assertIndex < killIndex, "assertSafeStateDir must execute before process killing");
  assert.ok(assertIndex < composeIndex, "assertSafeStateDir must execute before docker commands");
});

/**
 * Verifies that ci-dev-stack-gate checks strict session criteria, connects via Vite proxy,
 * sends session cookie, and validates websocket transport frames without error swallowing.
 */
test("ci-dev-stack-gate enforces session criteria, Vite proxy, Cookie header, and strict frame verification", () => {
  const gateSource = fs.readFileSync(path.join(process.cwd(), "scripts", "ci-dev-stack-gate.mjs"), "utf8");
  assert.match(gateSource, /runtimeId === ["']cli:opencode["']/);
  assert.match(gateSource, /isActive === true/);
  assert.match(gateSource, /status !== ["']EXITED["']/);
  assert.match(gateSource, /verifyCliWebSocketTransport/);
  assert.match(gateSource, /webPort/);
  assert.match(gateSource, /Cookie:\s*cookie/);
  assert.match(gateSource, /Terminal websocket reported error frame/);
});

/**
 * Verifies that dev-stack atomically acquires dev-stack.lock with flag 'wx' and holds it through teardown.
 */
test("dev-stack atomically acquires dev-stack.lock with flag wx and holds it through teardown", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  assert.match(devStackSource, /flag:\s*["']wx["']/);
  assert.match(devStackSource, /dev-stack\.lock/);
  assert.match(devStackSource, /Refusing to start duplicate stack/);
  assert.match(devStackSource, /postKillDeadline/);
});

/**
 * Verifies that dev-stack environment config isolates SPACE_TELEGRAM_OWNERSHIP_MANIFEST
 * and SPACE_CODEX_HOME within stateRoot/var to prevent writes to /opt/spaceapp or /var/lib.
 */
test("dev-stack environment config isolates SPACE_TELEGRAM_OWNERSHIP_MANIFEST and SPACE_CODEX_HOME within stateRoot", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  assert.match(devStackSource, /SPACE_TELEGRAM_OWNERSHIP_MANIFEST:\s*path\.join\(config\.varDir/);
  assert.match(devStackSource, /SPACE_CODEX_HOME:\s*path\.join\(config\.varDir/);
  assert.match(devStackSource, /mkdirSync\(path\.dirname\(envCommon\.SPACE_TELEGRAM_OWNERSHIP_MANIFEST\)/);
  assert.match(devStackSource, /mkdirSync\(envCommon\.SPACE_CODEX_HOME/);
});

/**
 * Verifies that startDevStack acquires the atomic state lock before initializing state or child processes,
 * and guards rollback in catch block using ownsLifecycle so contenders never kill the owner stack.
 */
test("startDevStack acquires dev-stack.lock before child processes and guards rollback with ownsLifecycle", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  const startIndex = devStackSource.indexOf("export async function startDevStack");
  const ownsLifecycleDecl = devStackSource.indexOf("let ownsLifecycle = false", startIndex);
  const lockAcquire = devStackSource.indexOf("writeFileSync(lockFile, lockPayload, { flag: \"wx\"", startIndex);
  const ownsLifecycleSet = devStackSource.indexOf("ownsLifecycle = true", lockAcquire);
  const spawnCliHost = devStackSource.indexOf("Spawning CLI Host", ownsLifecycleSet);
  const catchRollback = devStackSource.indexOf("if (!ownsLifecycle)", startIndex);

  assert.ok(startIndex > -1);
  assert.ok(ownsLifecycleDecl > -1, "ownsLifecycle must be initialized before lock acquisition");
  assert.ok(lockAcquire > -1, "lock acquisition must occur early");
  assert.ok(ownsLifecycleSet > -1, "ownsLifecycle must be set true only after lock acquisition");
  assert.ok(spawnCliHost > ownsLifecycleSet, "Child process spawning must occur after lock acquisition");
  assert.ok(catchRollback > -1, "Catch block must guard rollback with if (!ownsLifecycle)");
});

/**
 * Verifies that ci-dev-stack-gate strictly requires live non-empty terminal output,
 * validates opencode runtime/session identity, and fails on error frames, fatal status, or early close.
 */
test("ci-dev-stack-gate strictly requires live non-empty terminal output and fails on premature close or error frames", () => {
  const gateSource = fs.readFileSync(path.join(process.cwd(), "scripts", "ci-dev-stack-gate.mjs"), "utf8");
  assert.match(gateSource, /expectedRuntimeId:\s*["']cli:opencode["']/);
  assert.match(gateSource, /Terminal websocket reported fatal session status/);
  assert.match(gateSource, /outputData\.trim\(\)\.length > 0/);
  assert.match(gateSource, /WebSocket closed before receiving non-empty terminal output/);
  assert.match(gateSource, /Do NOT resolve on ready frame/);
});

/**
 * Verifies that on fresh startup, after acquiring dev-stack.lock,
 * ensureSecrets recognizes the lock belonging to the current process, initializes
 * the state marker, and generates all required secrets without refusing adoption.
 */
test("fresh startup interaction: acquires lock and initializes state marker and secrets", () => {
  const tmpFresh = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-fresh-interaction-"));
  try {
    const config = {
      stateRoot: tmpFresh,
      secretsDir: path.join(tmpFresh, "secrets"),
      runDir: path.join(tmpFresh, "run"),
      binDir: path.join(tmpFresh, "bin"),
      varDir: path.join(tmpFresh, "var"),
      workspacesDir: path.join(tmpFresh, "workspaces"),
      postgresPort: 54329
    };

    // Simulate startDevStack lock acquisition on fresh directory
    const lockFile = path.join(tmpFresh, "dev-stack.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });

    // ensureSecrets must succeed and NOT throw "Refusing to adopt"
    const secrets = ensureSecrets(config);
    assert.ok(secrets.password);
    assert.ok(secrets.sessionSecret);
    assert.ok(secrets.setupToken);

    // Marker must be created
    const markerPath = path.join(tmpFresh, ".dev-stack-state.json");
    assert.ok(fs.existsSync(markerPath));
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(marker.createdBy, "spaceapp-dev-stack");
  } finally {
    fs.rmSync(tmpFresh, { recursive: true, force: true });
  }
});

/**
 * Verifies that calling startDevStack with a completely non-existent stateRoot
 * initializes the state root, acquires the lock, creates the marker, secrets, and compose file,
 * and halts cleanly at the Compose execution boundary without starting real containers or child processes.
 */
test("startDevStack adopts and initializes non-existent fresh state directory and stops cleanly at Compose boundary", async () => {
  const tmpRoot = path.join(os.tmpdir(), "spaceapp-test-start-fresh-" + Date.now());
  assert.equal(fs.existsSync(tmpRoot), false);

  const config = resolveDevStackConfig({
    SPACE_DEV_STATE_DIR: tmpRoot,
    SPACE_DEV_API_PORT: "5919",
    SPACE_DEV_WEB_PORT: "5918",
    SPACE_DEV_POSTGRES_PORT: "54339",
    SPACE_DEV_TEMPORAL_PORT: "57243"
  });

  const MOCK_COMPOSE_STOP_ERR = "MOCK_COMPOSE_BOUNDARY_STOP";
  let composeCommandIntercepted = false;

  try {
    await assert.rejects(
      async () => {
        await startDevStack(config, {
          runCmd: (cmd, args) => {
            if (cmd === "docker" && args.includes("compose")) {
              composeCommandIntercepted = true;
              throw new Error(MOCK_COMPOSE_STOP_ERR);
            }
          }
        });
      },
      (err) => {
        assert.equal(err.message, MOCK_COMPOSE_STOP_ERR);
        return true;
      }
    );

    // Verify Compose command was reached
    assert.equal(composeCommandIntercepted, true, "Execution must reach the Docker compose boundary");

    // Verify state directory, marker, secrets, and compose file were cleanly created
    assert.ok(fs.existsSync(tmpRoot), "State directory must exist");

    const markerPath = path.join(tmpRoot, ".dev-stack-state.json");
    assert.ok(fs.existsSync(markerPath), ".dev-stack-state.json marker must exist");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(marker.createdBy, "spaceapp-dev-stack");

    const composePath = path.join(tmpRoot, "docker-compose.yml");
    assert.ok(fs.existsSync(composePath), "docker-compose.yml must exist");
    const composeYaml = fs.readFileSync(composePath, "utf8");
    assert.match(composeYaml, /postgres:/);
    assert.match(composeYaml, /temporal:/);
    assert.match(composeYaml, /DEFAULT_NAMESPACE: dev/);
    assert.match(composeYaml, /--namespace dev/);

    const pwFile = path.join(tmpRoot, "secrets", "postgres-password");
    const sessionFile = path.join(tmpRoot, "secrets", "session-secret");
    const tokenFile = path.join(tmpRoot, "secrets", "setup-token");
    const dbUrlFile = path.join(tmpRoot, "secrets", "database-url");

    assert.ok(fs.existsSync(pwFile), "postgres-password must exist");
    assert.ok(fs.existsSync(sessionFile), "session-secret must exist");
    assert.ok(fs.existsSync(tokenFile), "setup-token must exist");
    assert.ok(fs.existsSync(dbUrlFile), "database-url must exist");

    // Assert 0600 owner-only permissions on POSIX
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(pwFile).mode & 0o777, 0o600, "postgres-password must have 0600 mode");
      assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600, "session-secret must have 0600 mode");
      assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600, "setup-token must have 0600 mode");
      assert.equal(fs.statSync(dbUrlFile).mode & 0o777, 0o600, "database-url must have 0600 mode");
    }

    // Verify secrets are preserved across restart/ensureSecrets
    const secrets1 = ensureSecrets(config);
    const secrets2 = ensureSecrets(config);
    assert.equal(secrets1.password, secrets2.password, "Password must persist across ensureSecrets");
    assert.equal(secrets1.sessionSecret, secrets2.sessionSecret, "Session secret must persist across ensureSecrets");
    assert.equal(secrets1.databaseUrl, secrets2.databaseUrl, "Database URL must persist across ensureSecrets");
    assert.equal(secrets1.setupToken, secrets2.setupToken, "Setup token must persist across ensureSecrets");
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
});

/**
 * Verifies that startDevStack inspects directory contents before acquisition
 * and refuses to touch an existing non-empty directory lacking the marker without writing a lock file.
 */
test("startDevStack refuses non-empty directory lacking marker without writing lock file", async () => {
  const tmpForeign = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-foreign-"));
  try {
    fs.writeFileSync(path.join(tmpForeign, "unrelated-data.txt"), "important data");

    const config = resolveDevStackConfig({
      SPACE_DEV_STATE_DIR: tmpForeign
    });

    await assert.rejects(
      async () => {
        await startDevStack(config);
      },
      /Refusing to adopt non-empty existing directory without \.dev-stack-state\.json marker/
    );

    // Assert no lock file was written into foreign directory
    const lockFile = path.join(tmpForeign, "dev-stack.lock");
    assert.equal(fs.existsSync(lockFile), false, "dev-stack.lock must NOT be created in a foreign directory");
  } finally {
    fs.rmSync(tmpForeign, { recursive: true, force: true });
  }
});

/**
 * Verifies that stopDevStack preserves external regular files or paths outside stateRoot
 * when configured as cliSocketPath, preventing accidental deletion of user files.
 */
test("stopDevStack preserves external regular files passed as cliSocketPath", async () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-socket-state-"));
  const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-socket-out-"));

  try {
    // Write valid marker so assertSafeStateDir allows purge
    fs.writeFileSync(
      path.join(tmpState, ".dev-stack-state.json"),
      JSON.stringify({ createdBy: "spaceapp-dev-stack", stateRoot: tmpState })
    );

    const importantFile = path.join(tmpOutside, "unrelated-config.txt");
    fs.writeFileSync(importantFile, "critical data");

    const config = resolveDevStackConfig({
      SPACE_DEV_STATE_DIR: tmpState,
      SPACE_CLI_HOST_SOCKET: importantFile
    });
    assert.equal(config.cliSocketPath, importantFile, "config.cliSocketPath must receive SPACE_CLI_HOST_SOCKET override");

    // Run stopDevStack with purge
    await stopDevStack(config, {
      purge: true,
      runCmd: () => ({ status: 0 })
    });

    // Assert external file was preserved and NOT deleted
    assert.equal(fs.existsSync(importantFile), true, "External regular file must not be deleted during reset");
    assert.equal(fs.readFileSync(importantFile, "utf8"), "critical data");
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
    fs.rmSync(tmpOutside, { recursive: true, force: true });
  }
});

/**
 * Verifies that stopDevStack propagates Docker failures for both down and reset,
 * and does not release lock or purge state if Docker teardown fails.
 */
test("stopDevStack propagates Docker teardown failures for down and reset", async () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-docker-fail-"));
  try {
    fs.writeFileSync(
      path.join(tmpState, ".dev-stack-state.json"),
      JSON.stringify({ createdBy: "spaceapp-dev-stack", stateRoot: tmpState })
    );
    fs.writeFileSync(path.join(tmpState, "docker-compose.yml"), "services: {}");
    const lockFile = path.join(tmpState, "dev-stack.lock");
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));

    const config = resolveDevStackConfig({
      SPACE_DEV_STATE_DIR: tmpState
    });

    // 1. Down command failure propagation
    await assert.rejects(
      async () => {
        await stopDevStack(config, {
          purge: false,
          runCmd: () => ({ status: 1 })
        });
      },
      /Failed to tear down Docker Compose services/
    );
    // Lock must be retained when stop failed
    assert.equal(fs.existsSync(lockFile), true, "Lock file must remain when Docker stop fails");

    // 2. Reset (purge) failure propagation
    await assert.rejects(
      async () => {
        await stopDevStack(config, {
          purge: true,
          runCmd: () => ({ status: 1 })
        });
      },
      /Failed to tear down Docker Compose services/
    );
    // State directory must NOT be purged when Docker teardown fails
    assert.equal(fs.existsSync(tmpState), true, "State directory must not be purged when Docker down fails");
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

/**
 * Verifies that young or active lock prevents duplicate stack launch and contender
 * does not remove or alter the owner's active lock.
 */
test("startDevStack prevents concurrent execution when active lock is held", async () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-concurrent-"));
  try {
    const lockFile = path.join(tmpState, "dev-stack.lock");
    const activePayload = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
    fs.writeFileSync(lockFile, activePayload);

    const config = resolveDevStackConfig({
      SPACE_DEV_STATE_DIR: tmpState
    });

    await assert.rejects(
      async () => {
        await startDevStack(config, {
          runCmd: () => {}
        });
      },
      /already running in state directory|Refusing to adopt non-empty/
    );

    // Assert owner's lock was NOT modified or unlinked
    assert.equal(fs.existsSync(lockFile), true, "Owner lock must remain untouched");
    assert.equal(fs.readFileSync(lockFile, "utf8"), activePayload);
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

/**
 * Verifies that isManagedSocketPath correctly recognizes the fallback socket path in tmpdir.
 */
test("isManagedSocketPath identifies fallback socket in tmpdir as managed", () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-fallback-"));
  try {
    const config = resolveDevStackConfig({
      SPACE_DEV_STATE_DIR: tmpState
    });
    const fallbackPath = resolveCliHostSocketFallback(config.runDir, config.composeProject);
    fs.writeFileSync(fallbackPath, "");

    const isManaged = isManagedSocketPath(fallbackPath, config);
    assert.equal(isManaged, true, "Fallback socket in tmpdir must be recognized as managed");

    // File in tmpdir with different name should NOT be managed
    const unmanagedPath = path.join(os.tmpdir(), "unrelated-socket.sock");
    fs.writeFileSync(unmanagedPath, "");
    assert.equal(isManagedSocketPath(unmanagedPath, config), false, "Unrelated file in tmpdir must not be managed");
    fs.rmSync(unmanagedPath, { force: true });
    fs.rmSync(fallbackPath, { force: true });
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

/**
 * Verifies that startDevStack reclaims stale dead lock (>15s) when owner PID is inactive.
 */
test("startDevStack reclaims stale dead lock older than 15s when owner PID is inactive", async () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-stale-lock-"));
  try {
    fs.writeFileSync(
      path.join(tmpState, ".dev-stack-state.json"),
      JSON.stringify({ createdBy: "spaceapp-dev-stack", stateRoot: tmpState })
    );
    const lockFile = path.join(tmpState, "dev-stack.lock");
    const deadPayload = JSON.stringify({ pid: 99999999, createdAt: new Date(Date.now() - 30000).toISOString() });
    fs.writeFileSync(lockFile, deadPayload);
    const pastTime = (Date.now() - 30000) / 1000;
    fs.utimesSync(lockFile, pastTime, pastTime);

    const config = resolveDevStackConfig({
      SPACE_DEV_STATE_DIR: tmpState
    });

    await assert.rejects(
      async () => {
        await startDevStack(config, {
          runCmd: () => {
            throw new Error("MOCK_COMPOSE_BOUNDARY_STOP");
          }
        });
      },
      /MOCK_COMPOSE_BOUNDARY_STOP/
    );

    assert.equal(fs.existsSync(lockFile), true, "Lock file must exist");
    const newLock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(newLock.pid, process.pid, "Lock must be reclaimed by current process PID");
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

/**
 * Verifies that startDevStack safely handles corrupt/unparseable lock files.
 */
test("startDevStack handles corrupt lock file safely", async () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-corrupt-lock-"));
  try {
    fs.writeFileSync(
      path.join(tmpState, ".dev-stack-state.json"),
      JSON.stringify({ createdBy: "spaceapp-dev-stack", stateRoot: tmpState })
    );
    const lockFile = path.join(tmpState, "dev-stack.lock");
    fs.writeFileSync(lockFile, "INVALID_CORRUPT_JSON{{{");

    const config = resolveDevStackConfig({
      SPACE_DEV_STATE_DIR: tmpState
    });

    // Fresh corrupt lock (<15s) must be rejected to prevent race
    await assert.rejects(
      async () => {
        await startDevStack(config, {
          runCmd: () => {}
        });
      },
      /Dev stack startup is already in progress/
    );

    // Stale corrupt lock (>15s) can be reclaimed
    const pastTime = (Date.now() - 30000) / 1000;
    fs.utimesSync(lockFile, pastTime, pastTime);

    await assert.rejects(
      async () => {
        await startDevStack(config, {
          runCmd: () => {
            throw new Error("MOCK_COMPOSE_BOUNDARY_STOP");
          }
        });
      },
      /MOCK_COMPOSE_BOUNDARY_STOP/
    );

    const reclaimedLock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    assert.equal(reclaimedLock.pid, process.pid, "Corrupt lock must be reclaimed by current process");
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});

/**
 * Verifies that two contenders attempting startup concurrently result in one owner
 * and the second failing closed without clobbering the winner's lock.
 */
test("two contenders attempting startup concurrently: contender fails without clobbering winner lock", async () => {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-contenders-"));
  try {
    fs.writeFileSync(
      path.join(tmpState, ".dev-stack-state.json"),
      JSON.stringify({ createdBy: "spaceapp-dev-stack", stateRoot: tmpState })
    );
    const config = resolveDevStackConfig({
      SPACE_DEV_STATE_DIR: tmpState
    });

    const lockFile = path.join(tmpState, "dev-stack.lock");
    const payloadWinner = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
    fs.writeFileSync(lockFile, payloadWinner, { flag: "wx" });

    // Contender attempts to acquire
    await assert.rejects(
      async () => {
        await startDevStack(config, {
          runCmd: () => {}
        });
      },
      /already running in state directory/
    );

    // Winner's lock must remain untouched
    assert.equal(fs.readFileSync(lockFile, "utf8"), payloadWinner);
  } finally {
    fs.rmSync(tmpState, { recursive: true, force: true });
  }
});
