import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");

test("extracts pinned digests and versions directly from source files without duplication", async () => {
  const composePath = join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml");
  const composeContent = await readFile(composePath, "utf8");
  const postgresMatch = composeContent.match(/image:\s*(pgvector\/pgvector:[^\s\r\n]+)/);
  const temporalMatch = composeContent.match(/image:\s*(temporalio\/auto-setup:[^\s\r\n]+)/);

  assert.ok(postgresMatch, "postgres image found in compose.yml");
  assert.ok(postgresMatch[1].includes("@sha256:"), "postgres image is pinned by sha256 digest");
  assert.ok(temporalMatch, "temporal image found in compose.yml");
  assert.ok(temporalMatch[1].includes("@sha256:"), "temporal image is pinned by sha256 digest");

  const dockerfilePath = join(repoRoot, "Dockerfile");
  const dockerfileContent = await readFile(dockerfilePath, "utf8");
  const opencodeMatch = dockerfileContent.match(/opencode-ai@([^\s\\]+)/);
  assert.ok(opencodeMatch, "opencode-ai version found in Dockerfile");
  assert.match(opencodeMatch[1], /^[0-9]+\.[0-9]+\.[0-9]+/, "opencode-ai version has semver format");
});

test("dev:stack lifecycle: starts stack, waits for /readyz, claims setup, starts CLI pane, and resets", async (t) => {
  // Check if docker daemon is running
  const dockerCmd = process.platform === "win32" ? "docker.exe" : "docker";
  try {
    await execFileAsync(dockerCmd, ["info"], { timeout: 3000 });
  } catch (err) {
    t.skip("Docker daemon is not available in current environment; skipping live stack integration.");
    return;
  }

  const testApiPort = 4940;
  const testWebPort = 5190;
  const testPgPort = 5450;
  const testTemporalPort = 7250;
  const testStateDir = resolve(repoRoot, ".dev-stack-test");
  const testProject = "spaceapp-test-stack";

  const env = {
    ...process.env,
    SPACE_DEV_STACK_DIR: testStateDir,
    SPACE_DEV_STACK_PROJECT: testProject,
    SPACE_DEV_STACK_API_PORT: String(testApiPort),
    SPACE_DEV_STACK_WEB_PORT: String(testWebPort),
    SPACE_DEV_STACK_POSTGRES_PORT: String(testPgPort),
    SPACE_DEV_STACK_TEMPORAL_PORT: String(testTemporalPort)
  };

  const stackProcess = spawn(process.execPath, ["scripts/dev-stack.mjs", "--headless"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stackOutput = "";
  stackProcess.stdout.on("data", (d) => (stackOutput += d.toString()));
  stackProcess.stderr.on("data", (d) => (stackOutput += d.toString()));

  try {
    // 1. Wait for /readyz
    const readyUrl = `http://127.0.0.1:${testApiPort}/readyz`;
    const deadline = Date.now() + 120_000;
    let ready = false;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(readyUrl);
        if (res.ok) {
          const body = await res.json();
          if (body.ok === true && body.dependencies?.worker === "RUNNING") {
            ready = true;
            break;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }

    assert.ok(ready, "dev:stack reached readyz ok: true with worker RUNNING");

    // 2. Read setup token
    const tokenPath = join(testStateDir, "secrets", "setup-token");
    assert.ok(existsSync(tokenPath), "setup token file generated");
    const setupToken = (await readFile(tokenPath, "utf8")).trim();
    assert.ok(setupToken.length >= 32, "setup token meets length requirements");

    // 3. Complete Owner Setup over HTTP
    const claimRes = await fetch(`http://127.0.0.1:${testApiPort}/api/setup/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: setupToken,
        email: "owner@dev-stack.test",
        password: "DevPassword123!"
      })
    });
    assert.equal(claimRes.status, 200, "owner claim succeeded");
    const cookie = claimRes.headers.get("set-cookie");
    assert.ok(cookie, "session cookie set on owner claim");

    // 4. Ensure Getting Started starter room
    const starterRes = await fetch(`http://127.0.0.1:${testApiPort}/api/setup/starter-room`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" }
    });
    assert.equal(starterRes.status, 200, "starter room ensured");
    const starterData = await starterRes.json();
    const roomId = starterData.room.id;
    assert.ok(roomId, "starter room has id");

    // 5. Open CLI pane session
    const roomRes = await fetch(`http://127.0.0.1:${testApiPort}/api/rooms/${roomId}`, {
      headers: { Cookie: cookie }
    });
    const roomData = await roomRes.json();
    const opencodePane = roomData.panes?.find((p) => p.terminalRuntimeId === "cli:opencode");
    assert.ok(opencodePane, "found OpenCode CLI pane in Getting Started room");

    const sessionRes = await fetch(`http://127.0.0.1:${testApiPort}/api/panes/${opencodePane.id}/cli/session`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeId: "cli:opencode" })
    });
    assert.equal(sessionRes.status, 200, "OpenCode CLI pane session started");
    const sessionData = await sessionRes.json();
    assert.ok(sessionData.session?.id, "cli session created with id");
  } finally {
    // 6. Tear down and reset
    try {
      stackProcess.kill("SIGTERM");
    } catch {}

    await execFileAsync(process.execPath, ["scripts/dev-stack.mjs", "reset"], {
      cwd: repoRoot,
      env
    });

    assert.equal(existsSync(testStateDir), false, "state directory removed by reset");

    // Check no containers remain
    const { stdout: psOut } = await execFileAsync(dockerCmd, ["ps", "-a", "--filter", `label=com.docker.compose.project=${testProject}`, "--format", "{{.ID}}"]);
    assert.equal(psOut.trim(), "", "no docker containers left");

    const { stdout: volOut } = await execFileAsync(dockerCmd, ["volume", "ls", "--filter", `name=${testProject}`, "--format", "{{.Name}}"]);
    assert.equal(volOut.trim(), "", "no docker volumes left");
  }
});
