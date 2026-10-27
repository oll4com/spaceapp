/** Real, non-interactive acceptance: requires Docker and network access for pinned dependencies. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, readFile, realpath, stat, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { waitFor, assertPortsFree } from "./processes.mjs";
import { readState, secretNames } from "./state.mjs";

const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), "../.."));
assert.equal(await readState(root), null, "Smoke requires a fresh stack; reset explicitly first to delete existing dev data.");
const npm = process.env.npm_execpath;
assert.ok(npm, "Run npm run smoke:stack");
const logPath = process.env.SPACE_DEV_SMOKE_LOG;
const log = logPath ? createWriteStream(logPath, { mode: 0o600 }) : process.stdout;
const start = spawn(process.execPath, [npm, "run", "dev:stack"], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
for (const stream of [start.stdout, start.stderr]) stream.pipe(log, { end: false });
const end = new Promise((resolve) => start.once("exit", (code, signal) => resolve({ code, signal })));
const abort = new AbortController();
let exited = false, state, ready;
end.then(() => { exited = true; abort.abort(); });
const invoke = (action) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npm, "run", "dev:stack", "--", action], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${action} failed (${code})`)));
});
let cookie = "", csrf = {};
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(ready.web + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...csrf, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const setCookie = response.headers.getSetCookie().find((item) => item.startsWith("space_session_dev="));
  if (setCookie) cookie = setCookie.split(";")[0];
  const json = await response.json();
  assert.ok(response.ok, `${path}: HTTP${response.status} ${JSON.stringify(json)}`);
  return json;
}
try {
  await waitFor(async () => { ready = JSON.parse(await readFile(join(root, ".dev-stack/ready.json"), "utf8")); return true; }, "stack startup", abort.signal, 900_000);
  state = await readState(root);
  const status = await api("/readyz"); assert.equal(status.ok, true); assert.equal(status.dependencies.worker, "RUNNING");
  for (const name of secretNames) assert.equal((await stat(join(state.dir, "secrets", name))).mode & 0o777, 0o600);
  // Watchers must reload the source checkout, not serve a previously built application.
  const serverSource = join(root, "apps/api/src/server.ts");
  await utimes(serverSource, new Date(), new Date());
  await waitFor(async () => { const next = await api("/readyz"); return next.ok && next.apiStartedAt !== status.apiStartedAt; }, "API source reload", abort.signal, 60_000);
  const clientSource = await (await fetch(ready.web + "/@vite/client")).text();
  const hmrToken = clientSource.match(/const wsToken = "([^"\n]+)"/)?.[1]; assert.ok(hmrToken);
  const cssUrl = "/src/styles.css";
  const cssPath = join(root, "apps/web/src/styles.css"), cssStat = await stat(cssPath);
  assert.equal((await fetch(ready.web + cssUrl)).ok, true);
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${ready.web.replace("http:", "ws:")}/?token=${encodeURIComponent(hmrToken)}`, "vite-hmr", { headers: { Origin: ready.web } });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("Vite did not reload an edited source file.")); }, 20_000);
      ws.on("error", (error) => { clearTimeout(timer); reject(error); });
      ws.on("message", async (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "connected") await utimes(cssPath, new Date(), new Date());
        if (message.type === "update" && message.updates.some((update) => update.path === cssUrl)) { clearTimeout(timer); ws.close(); resolve(); }
      });
    });
  } finally { await utimes(cssPath, cssStat.atime, cssStat.mtime); }
  if (process.argv.includes("--rebuild")) {
    const previousWorker = ready.processPids.worker;
    const artifact = join(root, "packages/contracts/dist/space-instance.js");
    const before = (await stat(artifact)).mtimeMs;
    await invoke("rebuild");
    ready = JSON.parse(await readFile(join(root, ".dev-stack/ready.json"), "utf8"));
    assert.notEqual(ready.processPids.worker, previousWorker);
    assert.ok((await stat(artifact)).mtimeMs > before);
    assert.equal((await api("/readyz")).ok, true);
    console.log(JSON.stringify({ internalPackageRebuild: true, workerRestarted: true }));
  }
  const token = await readFile(join(state.dir, "secrets/setup-token"), "utf8");
  const password = randomBytes(24).toString("hex");
  const claimed = await api("/api/setup/claim", { token, email: "contributor@example.invalid", password });
  assert.equal(claimed.user.role, "ADMIN"); assert.equal(claimed.isSetupRequired, false);
  cookie = "";
  await api("/api/auth/login", { email: "contributor@example.invalid", password }); assert.ok(cookie);
  const challenge = await api("/api/auth/csrf"); csrf = { [challenge.headerName]: challenge.csrfToken };
  const starter = await api("/api/setup/starter-room", {}); assert.equal(starter.room.name, "Getting Started");
  const panes = await api(`/api/panes?roomId=${encodeURIComponent(starter.room.id)}`);
  const pane = panes.data.find((item) => item.terminalRuntimeId === "cli:opencode"); assert.ok(pane);
  const session = await api(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: "cli:opencode" });
  assert.ok(["IDLE", "RUNNING"].includes(session.session.status)); assert.ok(session.websocket);
  const params = new URLSearchParams({ sessionId: session.websocket.sessionId, token: session.websocket.token });
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${ready.web.replace("http:", "ws:")}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal?${params}`, { headers: { Cookie: cookie, Origin: ready.web } });
    let transcript = "";
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("No real OpenCode terminal output received.")); }, 30_000);
    ws.on("error", (error) => { clearTimeout(timer); reject(error); });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "error" || message.type === "status" && message.status === "ERROR") { clearTimeout(timer); ws.close(); reject(new Error(`Terminal attach failed: ${message.message ?? message.reason ?? "unknown"}`)); return; }
      if (message.type !== "output" || message.stream !== "stdout") return;
      transcript += message.data;
      if (/opencode|OpenCode/.test(transcript)) { clearTimeout(timer); ws.close(); resolve(); }
      if (transcript.length > 2_000_000) { clearTimeout(timer); ws.terminate(); reject(new Error("Unexpected terminal output size.")); }
    });
  });
  await waitFor(async () => (await api(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`)).session.status === "RUNNING", "running PTY", abort.signal, 15_000);
  const html = await (await fetch(ready.web)).text(); assert.match(html, /@vite\/client/);
  console.log(JSON.stringify({ platform: process.platform, node: process.version, ownerSetup: true, passwordSignIn: true, gettingStartedRoom: true, openCodePane: "RUNNING", terminalOutput: true, readiness: status, vite: true, apiSourceReload: true, viteHmr: true }));
  if (process.argv.includes("--worker-exit")) {
    // This PID comes from the supervisor just started by this test, never from a process-name scan.
    process.kill(ready.processPids.worker, "SIGTERM");
    const result = await end; assert.equal(result.code, 1);
    console.log(JSON.stringify({ workerExitPropagated: true, supervisorExitCode: result.code }));
  } else { await invoke("down"); await end; }
  assert.equal(exited, true);
  for (const pid of ready.managedPids) {
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `Managed process ${pid} remains after stop`);
  }
  await waitFor(async () => { await assertPortsFree(state.ports); return true; }, "ports released", new AbortController().signal, 20_000);
} finally {
  await invoke("reset");
  if (!exited) { start.kill("SIGTERM"); await end; }
  if (log !== process.stdout) log.end();
}
assert.equal(await readState(root), null);
if (state) {
  for (const kind of ["ps", "volume ls", "network ls"]) {
    const args = kind.split(" "); if (kind === "ps") args.push("-a");
    args.push("--filter", `label=com.docker.compose.project=${state.project}`, "--quiet");
    assert.equal(execFileSync("docker", args, { encoding: "utf8" }).trim(), "", `${kind} resources remain after reset`);
  }
  await waitFor(async () => { await assertPortsFree(state.ports); return true; }, "ports released", new AbortController().signal, 20_000);
  await assert.rejects(access(state.sockets), { code: "ENOENT" });
}
console.log(JSON.stringify({ platform: process.platform, reset: true, noOwnedProcessesPortsContainersVolumesNetworksOrState: true }));
