#!/usr/bin/env node
// Opt-in acceptance against a disposable, uniquely named installation; uses real images and the real launcher.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { RUNTIME_VERSION } from "../packages/run-spaceapp/src/package-info.mjs";
import { composeCommand, composeProjectName, loadConfig } from "../packages/run-spaceapp/src/index.mjs";

const profile = process.argv[2] ?? "small";
assert.ok(["small", "medium", "large"].includes(profile), "Pass small, medium or large");
const fixture = await mkdtemp(join(process.env.SPACEAPP_SMOKE_TMPDIR ?? tmpdir(), "spaceapp-podman-smoke-"));
const root = join(fixture, "installation");
const workspace = join(fixture, "workspace");
const project = composeProjectName(root);
const env = { ...process.env, SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" };
const answers = { confirm: true, profile, access: "isolated", companions: false, telemetry: false, open: false, purgeConfirm: "DELETE" };
const localImages = process.env.SPACEAPP_SMOKE_LOCAL_IMAGES === "1";
const sourceVersion = process.env.SPACEAPP_SMOKE_SOURCE_VERSION;
if (sourceVersion) assert.match(sourceVersion, /^\d+\.\d+\.\d+$/);
const stopping = new AbortController();
const activeCommands = new Set();

// Keep each acceptance command and its descendants in one cancellable process group.
function startCommand(command, args, options) {
  stopping.signal.throwIfAborted();
  const child = spawn(command, args, { ...options, detached: true });
  const stop = () => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") console.error(error); }
    }
  };
  stopping.signal.addEventListener("abort", stop, { once: true });
  const closed = new Promise((resolve) => child.once("close", () => {
    stopping.signal.removeEventListener("abort", stop);
    activeCommands.delete(closed);
    resolve();
  }));
  activeCommands.add(closed);
  return child;
}

function podman(args, input, cleanup = false) {
  return new Promise((resolve, reject) => {
    const child = (cleanup ? spawn : startCommand)("podman", args, { env, stdio: ["pipe", "pipe", "inherit"], shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`podman ${args[0]} exited ${code}`)));
    child.stdin.end(input);
  });
}
async function launch(args, { input, version } = {}) {
  console.log(`ACCEPT ${profile}: ${args.join(" ")}`);
  const flags = input === undefined ? ["--non-interactive", "--answers", JSON.stringify(answers)] : [];
  const code = await new Promise((resolve, reject) => {
    // The exported launcher runs with a real older release for upgrade acceptance; no executor is replaced.
    const entry = version ? ["--input-type=module", "--eval", `import {run} from ${JSON.stringify(new URL("../packages/run-spaceapp/src/cli.mjs", import.meta.url).href)}; process.exitCode = await run(process.argv.slice(1), {runtimeVersion:${JSON.stringify(version)}});`, "--"]
      : [fileURLToPath(new URL("../packages/run-spaceapp/bin/spaceapp.mjs", import.meta.url))];
    const child = startCommand(process.execPath, [...entry,
      ...args, ...flags, ...(localImages ? ["--local-images"] : [])], { env, stdio: ["pipe", "inherit", "inherit"], shell: false });
    child.on("error", reject);
    child.on("close", resolve);
    child.stdin.end(input);
  });
  assert.equal(code, 0, args.join(" "));
}
async function compose(args) {
  const config = await loadConfig(root);
  const spec = composeCommand("status", root, config);
  return podman([...spec.args.slice(0, -1), ...args]);
}
async function ready() {
  for (let attempt = 0; attempt < 90; attempt++) {
    stopping.signal.throwIfAborted();
    try {
      const response = await fetch("http://127.0.0.1:4911/readyz", { signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(2000)]) });
      if (response.ok && (await response.json()).ok === true) {
        assert.equal((await fetch("http://127.0.0.1:4911/", { signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(5000)]) })).status, 200);
        return;
      }
    } catch { /* Startup may not have bound the port yet. */ }
    await delay(2000, undefined, { signal: stopping.signal });
  }
  throw new Error("readyz/web did not become ready");
}
let cleaned = false;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    stopping.abort();
    await Promise.all(activeCommands);
    // A failed install may not have committed its config; only address this project's labelled resources.
    if (!cleaned) {
      const ids = (await podman(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], undefined, true).catch(() => "")).split(/\s+/).filter(Boolean);
      if (ids.length) await podman(["rm", "-f", ...ids], undefined, true);
      for (const kind of ["volume", "network"]) {
        const names = (await podman([kind, "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`], undefined, true).catch(() => "")).split(/\s+/).filter(Boolean);
        if (names.length) await podman([kind, "rm", ...names], undefined, true);
      }
    }
    await rm(fixture, { recursive: true, force: true });
  })();
}
const terminate = () => {
  process.exitCode = 143;
  void cleanup().catch((error) => { console.error(error); process.exitCode = 1; });
};
process.once("SIGTERM", terminate);
try {
  await mkdir(workspace);
  await launch(["install", "--engine", "podman", "--profile", profile], { version: sourceVersion });
  assert.equal((await loadConfig(root)).engine, "podman");
  await ready();
  await launch(["status"]);
  await launch(["logs"]);
  await launch(["workspace", "add", workspace]);
  let config = await loadConfig(root);
  const containerPath = config.workspaces[0].containerPath;
  await compose(["exec", "-T", "--user", "10001:10001", "spaceapp-cli", "node", "-e", "require('node:fs').writeFileSync(process.argv[1], 'rootless ownership')", `${containerPath}/ownership`]);
  assert.equal((await stat(join(workspace, "ownership"))).uid, process.getuid());
  await launch(["workspace", "remove", workspace]);
  await launch(["workspace", "add", workspace, "--read-only"]);
  await compose(["exec", "-T", "--user", "10001:10001", "spaceapp-cli", "node", "-e", "try{require('node:fs').writeFileSync(process.argv[1],'unexpected');process.exit(1)}catch(e){if(!['EROFS','EACCES'].includes(e.code))throw e}", `${containerPath}/must-not-write`]);
  await compose(["exec", "-T", "--user", "10001:10001", "spaceapp-core", "node", "-e",
    "require('node:net').connect('/run/spaceapp-cli/host.sock').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]);
  const coreId = await compose(["ps", "-q", "spaceapp-core"]);
  const inspection = JSON.parse(await podman(["inspect", coreId]))[0];
  assert.ok(inspection.HostConfig.Memory > 0, "memory limit is enforced");
  assert.ok(inspection.HostConfig.CpuQuota > 0, "CPU quota is enforced");
  assert.equal(inspection.HostConfig.Init, true, "container init is enabled");
  assert.equal(await compose(["run", "--rm", "--no-deps", "--user", "10001:10001", "--entrypoint", "node", "spaceapp-cli", "-p", "process.getuid()"]), "10001");
  if (sourceVersion) {
    await launch(["update", RUNTIME_VERSION]);
    await ready();
    assert.equal((await loadConfig(root)).previousVersion, sourceVersion);
    const checkpoints = await readdir(join(root, "checkpoints"));
    assert.ok(checkpoints.length > 0);
    assert.ok(await readFile(join(root, "checkpoints", checkpoints[0], "verified.json"), "utf8"));
    await launch(["rollback"]);
    await ready();
    assert.equal((await loadConfig(root)).version, sourceVersion);
    await launch(["update", RUNTIME_VERSION]);
    await ready();
  }
  await launch(["provider", "install", "opencode"]);
  await compose(["exec", "-T", "--user", "10001:10001", "spaceapp-core", "node", "-e", "require('node:fs').writeFileSync('/var/lib/spaceapp/memory/podman-smoke.txt','before backup')"]);
  await launch(["backup"]);
  assert.ok((await readdir(join(root, "backups"))).some((name) => name.startsWith("spaceapp-backup-")));
  await compose(["exec", "-T", "--user", "10001:10001", "spaceapp-core", "node", "-e", "require('node:fs').writeFileSync('/var/lib/spaceapp/memory/podman-smoke.txt','after backup')"]);
  await launch(["restore"], { input: "RESTORE\n" });
  await ready();
  assert.equal(await compose(["exec", "-T", "--user", "10001:10001", "spaceapp-core", "cat", "/var/lib/spaceapp/memory/podman-smoke.txt"]), "before backup");
  await launch(["doctor"]);
  await launch(["doctor", "--fix"]);
  await launch(["support-bundle"]);
  const bundleName = (await readdir(root)).find((name) => name.startsWith("support-bundle-"));
  const bundle = JSON.parse(await readFile(join(root, bundleName), "utf8"));
  assert.equal(bundle.engine.name, "podman"); assert.equal(bundle.engine.rootless, true);
  await launch(["down"]);
  await launch(["up"]);
  await ready();
  await launch(["uninstall"]);
  assert.equal(await podman(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]), "");
  await launch(["up"]);
  await ready();
  await launch(["uninstall", "--purge"]);
  assert.equal(await podman(["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]), "");
  assert.equal(await podman(["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]), "");
  assert.equal(await podman(["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]), "");
  cleaned = true;
  console.log(JSON.stringify({ profile, passed: true, engine: "podman", rootless: true, cleaned: true }));
} catch (error) {
  if (!stopping.signal.aborted) throw error;
} finally {
  await cleanup();
  process.off("SIGTERM", terminate);
}
