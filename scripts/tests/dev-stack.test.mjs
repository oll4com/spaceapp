import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildServiceEnv,
  CLI_WRAPPER_RUNTIMES,
  ensureOpenCodeBinary,
  ensureRuntimeDirectories,
  ensureSecrets,
  parseComposeImages,
  parseOpenCodeVersion,
  processStartIdentity,
  processTreeAlive,
  renderCliParityWrapper,
  renderCompose,
  renderOpenCodeWrapper,
  renderReadyBanner,
  resolvePorts,
  resolveRepoRoot,
  resolveStatePaths,
  runReset,
  stopManagedProcesses
} from "../dev-stack.mjs";

const repoRoot = resolveRepoRoot();
const launcherComposePath = path.join(
  repoRoot,
  "packages",
  "run-spaceapp",
  "templates",
  "compose.yml"
);

test("dev-stack parses digest-pinned Postgres (pgvector) and Temporal images from launcher compose template", () => {
  const composeText = readFileSync(launcherComposePath, "utf8");
  const images = parseComposeImages(composeText);
  assert.match(
    images.postgresImage,
    /^pgvector\/pgvector:0\.8\.3-pg17-trixie@sha256:[0-9a-f]{64}$/
  );
  assert.match(
    images.temporalImage,
    /^temporalio\/auto-setup:1\.29\.1@sha256:[0-9a-f]{64}$/
  );
});

test("dev-stack parses OPENCODE_VERSION from Dockerfile and renders OpenCode + parity wrappers", () => {
  const dockerfileText = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const version = parseOpenCodeVersion(dockerfileText);
  assert.match(version, /^\d+\.\d+\.\d+$/);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "space-dev-stack-opencode-"));
  try {
    const paths = resolveStatePaths(tmpDir, { SPACE_DEV_STATE_DIR: ".dev-stack" });
    ensureRuntimeDirectories(paths);
    let installArgs = null;
    const result = ensureOpenCodeBinary(repoRoot, paths, {
      runCommand: (cmd, args) => {
        installArgs = { cmd, args };
        return { status: 0 };
      }
    });
    assert.equal(result.version, version);
    assert.ok(installArgs, "Expected npm install to run when binary is missing");
    assert.equal(installArgs.cmd, "npm");
    assert.ok(
      installArgs.args.includes(`@opencode/cli@${version}`) ||
        installArgs.args.includes(`opencode-ai@${version}`)
    );

    const wrapperText = readFileSync(result.wrapperPath, "utf8");
    assert.equal(wrapperText, renderOpenCodeWrapper(result.opencodeBin));

    const parityWrapperPath = path.join(paths.binDir, "opencode-vscode-parity");
    const parityText = readFileSync(parityWrapperPath, "utf8");
    assert.equal(
      parityText,
      renderCliParityWrapper({
        cliStateDir: paths.cliStateDir,
        memoryDir: paths.memoryDir,
        binDir: paths.binDir
      })
    );
    assert.ok(parityText.includes(JSON.stringify(paths.cliStateDir)));
    assert.ok(parityText.includes(JSON.stringify(paths.memoryDir)));

    for (const provider of CLI_WRAPPER_RUNTIMES) {
      assert.ok(
        existsSync(path.join(paths.binDir, `${provider}-vscode-parity`)),
        `Expected ${provider}-vscode-parity wrapper to exist`
      );
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("dev-stack generates and repairs per-state-directory secrets with mode 0600", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "space-dev-stack-secrets-"));
  try {
    const stateDir = path.join(tmpDir, ".dev-stack");
    const ports = resolvePorts({});
    assert.deepEqual(ports, {
      webPort: 5911,
      apiPort: 5910,
      postgresPort: 55432,
      temporalPort: 57233
    });
    assert.notEqual(ports.apiPort, 4910);
    assert.notEqual(ports.webPort, 4911);

    const first = ensureSecrets(stateDir, ports);

    for (const secretPath of [
      first.postgresPasswordPath,
      first.sessionSecretPath,
      first.setupTokenPath,
      first.databaseUrlPath
    ]) {
      assert.ok(existsSync(secretPath), `Expected secret file ${secretPath} to exist`);
      if (process.platform !== "win32") {
        const mode = statSync(secretPath).mode & 0o777;
        assert.equal(
          mode,
          0o600,
          `Expected ${secretPath} to have mode 0600, got ${mode.toString(8)}`
        );
      }
    }

    chmodSync(first.setupTokenPath, 0o644);
    const second = ensureSecrets(stateDir, ports);
    assert.equal(second.postgresPassword, first.postgresPassword);
    assert.equal(second.sessionSecret, first.sessionSecret);
    assert.equal(second.setupToken, first.setupToken);
    if (process.platform !== "win32") {
      const repairedMode = statSync(second.setupTokenPath).mode & 0o777;
      assert.equal(repairedMode, 0o600);
    }

    rmSync(second.setupTokenPath, { force: true });
    const afterClaim = ensureSecrets(stateDir, ports);
    assert.equal(afterClaim.setupToken, null);
    assert.equal(existsSync(afterClaim.setupTokenPath), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("dev-stack renders compose file bound to 127.0.0.1 with digest-pinned images and no embedded secrets", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "space-dev-stack-compose-"));
  try {
    const paths = resolveStatePaths(tmpDir, { SPACE_DEV_STATE_DIR: ".dev-stack" });
    const ports = resolvePorts({});
    const secrets = ensureSecrets(paths.stateDir, ports);
    const images = parseComposeImages(readFileSync(launcherComposePath, "utf8"));
    const composeYaml = renderCompose({ paths, ports, images });

    assert.match(composeYaml, /127\.0\.0\.1:55432:5432/);
    assert.match(composeYaml, /127\.0\.0\.1:57233:7233/);
    assert.ok(composeYaml.includes(images.postgresImage));
    assert.ok(composeYaml.includes(images.temporalImage));
    assert.ok(
      !composeYaml.includes(secrets.postgresPassword),
      "Rendered compose.yml must not embed the generated database password"
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("dev-stack service environment isolates all /opt/spaceapp paths into .dev-stack and wires setup token file", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "space-dev-stack-env-"));
  try {
    const paths = resolveStatePaths(tmpDir, { SPACE_DEV_STATE_DIR: ".dev-stack" });
    const ports = resolvePorts({});
    ensureRuntimeDirectories(paths);
    const secrets = ensureSecrets(paths.stateDir, ports);
    const env = buildServiceEnv({
      repoRoot: tmpDir,
      paths,
      ports,
      secrets,
      baseEnv: { PATH: "/usr/bin:/bin" }
    });

    assert.equal(env.SPACE_PUBLIC_DISTRIBUTION, "true");
    assert.equal(env.SPACE_SETUP_TOKEN_FILE, secrets.setupTokenPath);
    assert.equal(env.SPACE_SESSION_SECRET_FILE, secrets.sessionSecretPath);
    assert.equal(env.SPACE_DATABASE_URL_FILE, secrets.databaseUrlPath);
    assert.equal(env.SPACE_CLI_HOST_SOCKET_PATH, paths.cliHostSocketPath);
    assert.equal(env.SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN, "http://127.0.0.1:5911");
    assert.equal(env.SPACE_API_ORIGIN, "http://127.0.0.1:5910");
    assert.equal(env.SPACE_HOST, "127.0.0.1");
    assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");

    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("SPACE_")) {
        assert.doesNotMatch(
          String(value),
          /^\/opt\/spaceapp\b/,
          `Expected ${key} to not point to /opt/spaceapp (got ${value})`
        );
      }
    }

    const bannerBeforeClaim = renderReadyBanner({ ports, secrets, paths });
    assert.ok(bannerBeforeClaim.includes("http://127.0.0.1:5911"));
    assert.ok(bannerBeforeClaim.includes(secrets.setupToken));

    rmSync(secrets.setupTokenPath, { force: true });
    const bannerAfterClaim = renderReadyBanner({ ports, secrets, paths });
    assert.ok(bannerAfterClaim.includes("Already claimed"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("dev-stack validates port configuration and rejects duplicates or out-of-range ports", async () => {
  assert.throws(
    () => resolvePorts({ SPACE_DEV_WEB_PORT: "70000" }),
    /SPACE_DEV_WEB_PORT must be an integer between 1 and 65535/
  );
  assert.throws(
    () => resolvePorts({ SPACE_DEV_WEB_PORT: "5910", SPACE_DEV_API_PORT: "5910" }),
    /Duplicate host port 5910/
  );
  await assert.rejects(
    () => runReset(repoRoot, { env: { SPACE_DEV_STATE_DIR: "." } }),
    /Refusing to delete unsafe SPACE_DEV_STATE_DIR/
  );
  await assert.rejects(
    () => runReset(repoRoot, { env: { SPACE_DEV_STATE_DIR: ".." } }),
    /Refusing to delete unsafe SPACE_DEV_STATE_DIR/
  );
});

test("dev-stack process supervision detects live processes, rejects stale PIDs, and tears down process groups", async () => {
  assert.equal(processTreeAlive({ pid: 999999, pgid: 999999 }), false);

  const currentPidIdentity = processStartIdentity(process.pid);
  if (currentPidIdentity) {
    assert.equal(
      processTreeAlive({
        pid: process.pid,
        pgid: process.pid,
        startIdentity: "stale-identity"
      }),
      false
    );
  }

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "space-dev-stack-proc-"));
  try {
    const paths = resolveStatePaths(tmpDir, { SPACE_DEV_STATE_DIR: ".dev-stack" });
    ensureRuntimeDirectories(paths);

    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore"
    });
    sleeper.unref();

    const record = {
      name: "sleeper",
      pid: sleeper.pid,
      pgid: sleeper.pid,
      startIdentity: processStartIdentity(sleeper.pid)
    };
    assert.equal(processTreeAlive(record), true);

    const pidFile = path.join(paths.pidsDir, "sleeper.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(pidFile, JSON.stringify(record), "utf8");

    await stopManagedProcesses(paths, { timeoutMs: 2000 });
    assert.equal(processTreeAlive(record), false);
    assert.equal(existsSync(pidFile), false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("apps/web/vite.config.ts proxies API, WebSocket, and health endpoints to SPACE_API_ORIGIN", () => {
  const viteConfig = readFileSync(path.join(repoRoot, "apps", "web", "vite.config.ts"), "utf8");
  assert.match(viteConfig, /process\.env\.SPACE_API_ORIGIN/);
  assert.match(viteConfig, /"\/api":\s*\{\s*target:\s*apiOrigin,\s*ws:\s*true\s*\}/);
  for (const route of ["/plugins", "/healthz", "/livez", "/readyz", "/version", "/logout"]) {
    assert.match(viteConfig, new RegExp(`"${route.replace("/", "\\/")}":\\s*apiOrigin`));
  }
});

test("CONTRIBUTING.md and .github/workflows/ci.yml document and verify the contributor stack", () => {
  const contributing = readFileSync(path.join(repoRoot, "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /^## Run the full app from source$/m);
  assert.match(contributing, /npm run dev:stack/);
  assert.match(contributing, /npm run dev:stack -- verify/);
  assert.match(contributing, /npm run dev:stack -- down/);
  assert.match(contributing, /npm run dev:stack -- reset/);
  assert.match(contributing, /npm run dev:stack -- status/);
  assert.match(contributing, /Colima/);
  assert.match(contributing, /WSL2/);
  for (const envVar of [
    "SPACE_DEV_WEB_PORT",
    "SPACE_DEV_API_PORT",
    "SPACE_DEV_POSTGRES_PORT",
    "SPACE_DEV_TEMPORAL_PORT",
    "SPACE_DEV_STATE_DIR"
  ]) {
    assert.match(contributing, new RegExp(envVar));
  }

  const ci = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /\r?\n  dev-stack:\r?\n[\s\S]*runs-on: ubuntu-latest/);
  assert.match(ci, /npm run dev:stack -- up --detach/);
  assert.match(ci, /http:\/\/127\.0\.0\.1:5910\/livez/);
  assert.match(ci, /http:\/\/127\.0\.0\.1:5910\/readyz/);
  assert.match(ci, /http:\/\/127\.0\.0\.1:5911\//);
  assert.match(ci, /npm run dev:stack -- verify/);
  assert.match(ci, /npm run dev:stack -- reset/);
});
