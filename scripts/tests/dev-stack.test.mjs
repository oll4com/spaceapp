import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  SupervisingRunner,
  buildServiceEnvironment,
  defaultRepoRoot,
  downDevStack,
  ensureDevStackSecrets,
  generateDevStackComposeYaml,
  parsePinnedImagesFromCompose,
  parsePinnedOpenCodePackageFromDockerfile,
  resetDevStack,
  resolveCliHostSocketPath,
  resolveDevStackConfig,
  validateSafeStateDir,
  waitForStackReadiness,
  writeDevStackCliWrappers
} from "../dev-stack.mjs";

test("parsePinnedImagesFromCompose extracts SHA256-pinned postgres and temporal images from template", () => {
  const composeSource = readFileSync(
    resolve(defaultRepoRoot, "packages/run-spaceapp/templates/compose.yml"),
    "utf8"
  );
  const { postgresImage, temporalImage } = parsePinnedImagesFromCompose(composeSource);
  assert.match(postgresImage, /^(?:postgres|pgvector\/pgvector):[^\s#]+@sha256:[0-9a-f]{64}$/);
  assert.match(temporalImage, /^temporalio\/auto-setup:[^\s#]+@sha256:[0-9a-f]{64}$/);
});

test("parsePinnedImagesFromCompose rejects unpinned images", () => {
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

test("resolveCliHostSocketPath keeps short socket paths inside stateDir and falls back when path is too long", () => {
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
    assert.ok(secrets1.setupToken.length >= 32);
    assert.equal(
      secrets1.databaseUrl,
      `postgresql://space:${secrets1.postgresPassword}@127.0.0.1:25432/space`
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

    const serviceEnv = buildServiceEnvironment(config, secrets1, { PATH: "/usr/bin:/bin" });
    assert.equal(serviceEnv.SPACE_RUNTIME_STORE, "postgres");
    assert.equal(serviceEnv.SPACE_PUBLIC_DISTRIBUTION, "true");
    assert.equal(serviceEnv.SPACE_CLI_ENABLED, "true");
    assert.equal(serviceEnv.SPACE_CLI_COMMAND_PATH, config.binDir);
    assert.equal(serviceEnv.SPACE_CLI_WORKSPACE_ROOT, config.projectsDir);
    assert.equal(serviceEnv.SPACE_SETUP_TOKEN_FILE, secrets1.setupTokenPath);
    assert.equal(serviceEnv.SPACE_TEMPORAL_TASK_QUEUE, "space-agent-turns");
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

test(
  "live contributor stack E2E: /readyz, owner setup claim, and Getting Started OpenCode CLI session RUNNING",
  { skip: process.env.SPACE_RUN_DEV_STACK_E2E !== "1" },
  async () => {
    const { WebSocket } = await import("ws");
    const e2eStateDir = mkdtempSync(join(tmpdir(), "spaceapp-dev-stack-e2e-"));
    const readyFilePath = join(e2eStateDir, "ready.json");
    const e2eEnv = {
      ...process.env,
      SPACE_DEV_STACK_STATE_DIR: e2eStateDir,
      SPACE_DEV_READY_FILE: readyFilePath
    };
    const config = resolveDevStackConfig({ stateDir: e2eStateDir, env: e2eEnv });

    const stackChild = spawn(
      process.execPath,
      [resolve(defaultRepoRoot, "scripts/dev-stack.mjs"), "up", "--ready-file", readyFilePath],
      {
        cwd: defaultRepoRoot,
        env: e2eEnv,
        stdio: "inherit"
      }
    );

    try {
      const readyDeadline = Date.now() + 240_000;
      while (!existsSync(readyFilePath)) {
        if (stackChild.exitCode !== null) {
          throw new Error(`dev-stack up exited prematurely with code ${stackChild.exitCode}`);
        }
        if (Date.now() >= readyDeadline) {
          throw new Error("Timed out waiting for dev-stack ready file in E2E test");
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      const setupToken = readFileSync(resolve(config.secretsDir, "setup-token"), "utf8").trim();

      const apiReadyRes = await fetch(`http://127.0.0.1:${config.apiPort}/readyz`);
    assert.equal(apiReadyRes.status, 200);
    const apiReady = await apiReadyRes.json();
    assert.equal(apiReady.ok, true);
    assert.equal(apiReady.dependencies.database, "RUNNING");
    assert.equal(apiReady.dependencies.worker, "RUNNING");
    assert.equal(apiReady.dependencies.cliHost, "RUNNING");

    const webReadyRes = await fetch(`http://127.0.0.1:${config.webPort}/readyz`);
    assert.equal(webReadyRes.status, 200);
    const webReady = await webReadyRes.json();
    assert.equal(webReady.ok, true);

    const claimRes = await fetch(`http://127.0.0.1:${config.webPort}/api/setup/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: setupToken,
        email: "owner@example.com",
        password: "correct horse battery staple"
      })
    });
    assert.equal(claimRes.status, 200, `Expected 200 from /api/setup/claim, got ${claimRes.status}`);
    const setCookieHeader = claimRes.headers.get("set-cookie") ?? "";
    const cookieMatch = setCookieHeader.match(/\b(space_session[^;]*)/);
    assert.ok(cookieMatch, "Expected space_session cookie from /api/setup/claim");
    const sessionCookie = cookieMatch[1];

    const claimBody = await claimRes.json();
    const starterRoomId = claimBody.starterRoomId;
    assert.match(starterRoomId, /^room:/);

    const csrfRes = await fetch(`http://127.0.0.1:${config.webPort}/api/auth/csrf`, {
      headers: { cookie: sessionCookie }
    });
    assert.equal(csrfRes.status, 200);
    const { csrfToken, headerName } = await csrfRes.json();

    const panesRes = await fetch(
      `http://127.0.0.1:${config.webPort}/api/panes?roomId=${encodeURIComponent(starterRoomId)}`,
      { headers: { cookie: sessionCookie } }
    );
    assert.equal(panesRes.status, 200);
    const panesBody = await panesRes.json();
    const openCodePane = (panesBody.data ?? []).find(
      (pane) => pane.mode === "TERMINAL" && pane.terminalRuntimeId === "cli:opencode"
    );
    assert.ok(openCodePane, "Expected Getting Started room to contain an OpenCode CLI terminal pane");

    const createSessionRes = await fetch(
      `http://127.0.0.1:${config.webPort}/api/panes/${encodeURIComponent(openCodePane.id)}/cli/session`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
          [headerName]: csrfToken
        },
        body: JSON.stringify({ runtimeId: "cli:opencode" })
      }
    );
    assert.equal(
      createSessionRes.status,
      200,
      `Expected 200 from POST /api/panes/:id/cli/session, got ${createSessionRes.status}`
    );
    const sessionPayload = await createSessionRes.json();
    const sessionId = sessionPayload.session.sessionId;
    const wsTicket = sessionPayload.websocket.token;

    // Attach terminal WebSocket through the Vite proxy so CliTerminalManager spawns/attaches on cli-host
    const wsUrl = `ws://127.0.0.1:${config.webPort}/api/panes/${encodeURIComponent(openCodePane.id)}/cli/terminal?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(wsTicket)}`;
    await new Promise((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          cookie: sessionCookie,
          origin: `http://127.0.0.1:${config.webPort}`
        }
      });
      const timer = setTimeout(() => {
        ws.close();
        rejectPromise(new Error("Timed out waiting for CLI terminal WebSocket RUNNING status"));
      }, 30_000);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "status" && msg.status === "RUNNING") {
            clearTimeout(timer);
            ws.close();
            resolvePromise();
          } else if (msg.type === "error") {
            clearTimeout(timer);
            ws.close();
            rejectPromise(new Error(`CLI terminal WebSocket error: ${msg.message}`));
          }
        } catch {
          // Ignore non-JSON frames
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });
    });

      const getSessionRes = await fetch(
        `http://127.0.0.1:${config.webPort}/api/panes/${encodeURIComponent(openCodePane.id)}/cli/session`,
        { headers: { cookie: sessionCookie } }
      );
      assert.equal(getSessionRes.status, 200);
      const activeSessionBody = await getSessionRes.json();
      assert.equal(activeSessionBody.session.status, "RUNNING");
    } finally {
      try {
        stackChild.kill("SIGTERM");
      } catch {
        // Ignore
      }
      await resetDevStack(config);
    }
  }
);
