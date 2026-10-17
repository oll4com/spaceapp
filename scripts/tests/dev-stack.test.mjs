import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DevStackRunner, assertSafeStateDir, extractPinnedImages, extractPinnedOpenCode } from "../dev-stack.mjs";

const execFileAsync = promisify(execFile);

test("DevStackRunner extracts pinned container images and opencode version from source", async () => {
  const runner = new DevStackRunner();
  const { images, opencodeVersion } = await runner.readTemplates();
  assert.match(images.postgres, /^pgvector\/pgvector:.*@sha256:[0-9a-f]{64}$/);
  assert.match(images.temporal, /^temporalio\/auto-setup:.*@sha256:[0-9a-f]{64}$/);
  assert.match(opencodeVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/);
});

test("assertSafeStateDir prevents destructive operations on critical directories", async () => {
  const { homedir } = await import("node:os");
  const { parse, resolve } = await import("node:path");
  const root = parse(process.cwd()).root;
  assert.throws(() => assertSafeStateDir(root, process.cwd()), /filesystem root/);
  assert.throws(() => assertSafeStateDir(homedir(), process.cwd()), /user home directory/);
  assert.throws(() => assertSafeStateDir(process.cwd(), process.cwd()), /repository root/);
  assert.throws(() => assertSafeStateDir(resolve(process.cwd(), ".."), process.cwd()), /parent directory of repository/);
});

test("DevStackRunner isolates state directories and eliminates /opt/spaceapp dependency", async () => {
  const testStateDir = join(process.cwd(), ".dev-stack-hermetic-test");
  const runner = new DevStackRunner({ stateDir: testStateDir });
  try {
    await runner.initDirs();
    assert.ok(existsSync(join(testStateDir, "var/app-diagnostics")), "app-diagnostics dir must be isolated");
    assert.ok(existsSync(join(testStateDir, "var/streaming-secrets")), "streaming-secrets dir must be isolated");
    assert.ok(existsSync(join(testStateDir, "secrets/telegram")), "telegram secrets dir must be isolated");
    assert.ok(existsSync(join(testStateDir, "demos")), "demos dir must be isolated");
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(testStateDir, { recursive: true, force: true });
  }
});

test("dev:stack lifecycle: start -> /readyz -> owner setup -> cli pane -> reset", { timeout: 600_000 }, async () => {
  const testStateDir = join(process.cwd(), ".dev-stack-test-suite");
  const testProject = "spaceapp-dev-test";
  const postgresPort = 5440;
  const temporalPort = 7240;
  const apiPort = 4930;
  const webPort = 4931;

  const runner = new DevStackRunner({
    stateDir: testStateDir,
    composeProject: testProject,
    env: {
      ...process.env,
      SPACE_DEV_STACK_DIR: testStateDir,
      SPACE_DEV_COMPOSE_PROJECT: testProject,
      SPACE_DEV_POSTGRES_PORT: String(postgresPort),
      SPACE_DEV_TEMPORAL_PORT: String(temporalPort),
      SPACE_API_PORT: String(apiPort),
      SPACE_WEB_PORT: String(webPort)
    }
  });

  try {
    // 1. Clean previous run if any
    await runner.reset();

    // 2. Start stack
    await runner.start();

    // 3. Verify /readyz
    const readyRes = await fetch(`http://127.0.0.1:${apiPort}/readyz`);
    assert.equal(readyRes.status, 200);
    const readyBody = await readyRes.json();
    assert.equal(readyBody.ok, true);
    assert.equal(readyBody.dependencies?.database, "RUNNING");
    assert.equal(readyBody.dependencies?.worker, "RUNNING");
    assert.equal(readyBody.dependencies?.cliHost, "RUNNING");

    // 4. Complete owner setup over HTTP
    const setupToken = (await readFile(join(testStateDir, "secrets/setup-token"), "utf8")).trim();
    const claimRes = await fetch(`http://127.0.0.1:${apiPort}/api/setup/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: setupToken,
        email: "owner@example.com",
        password: "TestPassword123!"
      })
    });
    assert.equal(claimRes.status, 200);
    const claimBody = await claimRes.json();
    assert.equal(claimBody.isAuthenticated, true);
    assert.equal(claimBody.user?.role, "ADMIN");
    const starterRoomId = claimBody.starterRoomId;
    assert.ok(starterRoomId, "starterRoomId should be present");

    // Extract session cookie
    const setCookie = claimRes.headers.get("set-cookie") || "";
    const cookieMatch = setCookie.match(/(?:space_session|space_session_dev)=[^;]+/);
    assert.ok(cookieMatch, "session cookie should be set");
    const sessionCookie = cookieMatch[0];

    // 5. Open/verify CLI pane
    const csrfRes = await fetch(`http://127.0.0.1:${apiPort}/api/auth/csrf`, {
      headers: { cookie: sessionCookie }
    });
    const csrfBody = await csrfRes.json();
    const csrfHeader = csrfBody.headerName || "x-csrf-token";
    const csrfToken = csrfBody.csrfToken;

    const panesRes = await fetch(`http://127.0.0.1:${apiPort}/api/panes?roomId=${starterRoomId}`, {
      headers: { cookie: sessionCookie }
    });
    assert.equal(panesRes.status, 200);
    const panesBody = await panesRes.json();
    const panes = Array.isArray(panesBody) ? panesBody : panesBody.data;
    assert.ok(Array.isArray(panes) && panes.length > 0, "Starter room should contain panes");
    const opencodePane = panes.find((p) => p.terminalRuntimeId === "cli:opencode" || p.mode === "TERMINAL");
    assert.ok(opencodePane, "OpenCode CLI pane should be in the starter room");

    const sessionRes = await fetch(`http://127.0.0.1:${apiPort}/api/panes/${opencodePane.id}/cli/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: sessionCookie,
        [csrfHeader]: csrfToken
      },
      body: JSON.stringify({ runtimeId: opencodePane.terminalRuntimeId || "cli:opencode" })
    });
    assert.equal(sessionRes.status, 200);
    const sessionBody = await sessionRes.json();
    const session = sessionBody.session || sessionBody;
    assert.ok(
      ["RUNNING", "READY", "ATTACHED", "IDLE"].includes(session.status),
      `CLI session status expected to be active, got ${session.status}`
    );

    // 6. Test reset
    await runner.reset();

    // 7. Verify no containers, volumes, or state directory remain
    assert.equal(existsSync(testStateDir), false, "State directory should be removed after reset");

    const { stdout: psOut } = await execFileAsync("docker", ["ps", "-a", "--filter", `name=${testProject}`, "--format", "{{.ID}}"]);
    assert.equal(psOut.trim(), "", "No containers should remain after reset");

    const { stdout: volOut } = await execFileAsync("docker", ["volume", "ls", "--filter", `name=${testProject}`, "--format", "{{.Name}}"]);
    assert.equal(volOut.trim(), "", "No volumes should remain after reset");

  } finally {
    try {
      await runner.reset();
    } catch {}
  }
});
