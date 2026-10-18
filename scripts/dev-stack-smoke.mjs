// Disposable acceptance fixture: real Docker services, owner HTTP flow and OpenCode PTY.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { open, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { resolveDevStackConfig, runDevStackReset } from "./dev-stack.mjs";

const state = await mkdtemp(join(tmpdir(), "spaceapp-acceptance-"));
const config = resolveDevStackConfig({ ...process.env, SPACE_DEV_STACK_DIR: state });
const log = await open(join(tmpdir(), `spaceapp-acceptance-${randomBytes(6).toString("hex")}.log`), "wx", 0o600);
const child = spawn(process.execPath, ["scripts/dev-stack.mjs"], { env: { ...process.env, SPACE_DEV_STACK_DIR: state }, stdio: ["ignore", log.fd, log.fd] });
let cookie = "";
let csrf;
const origin = `http://127.0.0.1:${config.webPort}`;
async function request(path, body) {
  const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", headers: { origin, cookie, ...(csrf ? { [csrf.headerName]: csrf.csrfToken } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  return response.json();
}
const wait = async (predicate, timeout = 180000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Dev supervisor exited before acceptance finished; inspect private local log.");
    if (await predicate().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Dev stack acceptance timed out; inspect private local log.");
};
let host;
let recorded;
try {
  await wait(async () => (await request("/readyz")).ok === true, 900000);
  recorded = JSON.parse(await readFile(config.pidFile, "utf8"));
  const token = (await readFile(join(config.secretsDir, "setup-token"), "utf8")).trim();
  const password = randomBytes(24).toString("hex");
  const owner = await request("/api/setup/claim", { token, email: "owner@example.invalid", password });
  assert.equal(owner.isAuthenticated, true);
  await request("/api/auth/login", { email: "owner@example.invalid", password });
  csrf = await request("/api/auth/csrf");
  const pane = await request("/api/panes", { roomId: owner.starterRoomId, title: "Acceptance OpenCode", mode: "TERMINAL", terminalRuntimeId: "cli:opencode", cwd: config.workspacesDir });
  const started = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: "cli:opencode" });
  assert.equal(started.session.status, "RUNNING");
  const { CliHostClient } = await import("../packages/cli-host/dist/client.js");
  host = new CliHostClient({ socketPath: config.cliSocketPath });
  const health = await host.health();
  const identity = health.sessions.find(session => session.paneId === pane.id);
  assert.ok(identity, "HTTP-started pane must exist in real CLI host");
  let output = "";
  const attached = await host.attach({ identity, afterSequence: -1 }, event => { if (event.type === "output") output = (output + event.data).slice(-65536); });
  for (const event of attached.replay) output += event.data;
  await wait(async () => { const live = await host.inspect(identity); return live?.status === "RUNNING" && /opencode|build|agent|model|provider/i.test(output); }, 60000);
  console.log("PASS: real owner claim/login, API pane start, CLI host and OpenCode terminal output");
} finally {
  await host?.close();
  await runDevStackReset(config);
  if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  await log.close();
  for (const pid of [recorded?.supervisorPid, ...(recorded?.childPids ?? [])].filter(Boolean)) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "Owned process must be gone");
  }
  for (const command of [["ps", "-aq"], ["volume", "ls", "-q"]]) {
    assert.equal(execFileSync("docker", [...command, "--filter", `label=com.docker.compose.project=${config.projectName}`], { encoding: "utf8" }).trim(), "");
  }
  await assert.rejects(readFile(join(state, "owner.json")), { code: "ENOENT" });
  await rm(state, { force: true, recursive: true });
  console.log("PASS: owned processes, containers, volumes and state removed");
}
