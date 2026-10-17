// Opt-in real containers. Never point this at an operator installation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { executeCommand, run } from "../packages/run-spaceapp/src/cli.mjs";
import { composeCommand, composeProjectName } from "../packages/run-spaceapp/src/index.mjs";
import { RUNTIME_VERSION } from "../packages/run-spaceapp/src/package-info.mjs";

const profile = process.argv[2] ?? "small";
const extended = process.argv.includes("--extended");
const localImages = process.argv.includes("--local-images");
const upgradeFrom = process.argv.find((argument) => argument.startsWith("--upgrade-from="))?.slice("--upgrade-from=".length);
if (upgradeFrom !== undefined) assert.match(upgradeFrom, /^\d+\.\d+\.\d+$/);
assert.ok(["small", "medium", "large"].includes(profile), "profile must be small, medium or large");
const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-smoke-"));
const project = composeProjectName(root);
const env = { ...process.env, SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" };
// Only a fresh synthetic instance is created. Do not print its bootstrap token.
let partial = "";
const stdout = new Writable({ write(chunk, _encoding, done) {
  partial += chunk.toString();
  const lines = partial.split(/\r?\n/);
  partial = lines.pop();
  for (const line of lines) process.stdout.write(`${line.replace(/(One-time setup token:).*/, "$1 [redacted]")}\n`);
  done();
} });
const options = () => ({ env, stdin: Readable.from([]), stdout, stderr: stdout,
  execute: (spec, io) => executeCommand(spec, { ...io, stdin: process.stdin }) });
const invoke = async (args, extra = {}) => {
  const code = await run([...(localImages ? ["--local-images"] : []), ...args], { ...options(), ...extra });
  assert.equal(code, 0, `launcher ${args[0]} exited ${code}`);
};
async function podman(args) {
  return new Promise((accept, reject) => {
    const child = spawn("podman", args, { env, shell: false, stdio: ["ignore", "pipe", "inherit"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept(text.trim()) : reject(new Error(`podman ${args[0]} exited ${code}`)));
  });
}
async function ownedResources(kind) {
  const command = kind === "container" ? ["ps", "-a", "-q"] : [kind, "ls", "-q"];
  return (await podman([...command, "--filter", `label=com.docker.compose.project=${project}`])).split(/\s+/).filter(Boolean);
}
async function ready() {
  const deadline = Date.now() + 120000;
  do {
    try {
      const response = await fetch("http://127.0.0.1:4911/readyz", { signal: AbortSignal.timeout(3000) });
      if (response.ok && (await response.json()).ok === true) return;
    } catch {}
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error("/readyz did not recover within two minutes");
}
let purged = false;
try {
  // Avoid accidentally testing against an unrelated listener on the default port.
  let inUse = false;
  try { await fetch("http://127.0.0.1:4911/readyz", { signal: AbortSignal.timeout(1000) }); inUse = true; } catch {}
  assert.equal(inUse, false, "port 4911 is already in use; stop the smoke test, not the other application");
  await invoke(["install", "--engine", "podman", "--profile", profile, "--no-open", "--non-interactive", "--answers",
    JSON.stringify({ confirm: true, engine: "podman", profile, access: "isolated", companions: false, telemetry: false, open: false })],
    upgradeFrom ? { runtimeVersion: upgradeFrom } : {});
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  const response = await fetch("http://127.0.0.1:4911/readyz", { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  await invoke(["doctor"]);
  await invoke(["status"]);
  await invoke(["backup"]);
  const backups = (await readdir(join(root, "backups"))).filter((name) => name.startsWith("spaceapp-backup-"));
  assert.equal(backups.length, 1);
  if (extended) {
    for (const [name, readOnly] of [["readwrite", false], ["readonly", true]]) {
      const path = join(root, name);
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "input"), "synthetic workspace fixture", { mode: 0o600 });
      await invoke(["workspace", "add", path, ...(readOnly ? ["--read-only"] : [])]);
    }
    await invoke(["up"]);
    const spec = composeCommand("status", root, { engine: "podman", profile });
    const base = spec.args.slice(0, -1);
    for (const service of ["spaceapp-core", "spaceapp-cli"]) {
      await podman([...base, "exec", "-T", "--user", "10001:10001", service, "node", "-e",
        "const fs=require('node:fs'); fs.readFileSync('/workspaces/readonly/input'); fs.writeFileSync('/workspaces/readwrite/' + process.argv[1], 'owner'); let denied=false;try{fs.writeFileSync('/workspaces/readonly/forbidden','x')}catch(e){denied=['EROFS','EACCES'].includes(e.code)}if(!denied)process.exit(3)", service]);
      assert.equal((await stat(join(root, "readwrite", service))).uid, process.getuid());
    }
    await invoke(["support-bundle", "--out", join(root, "support.json")]);
    const bundle = JSON.parse(await readFile(join(root, "support.json"), "utf8"));
    assert.equal(bundle.containerEngine.name, "podman");
    assert.equal(bundle.containerEngine.rootless, true);
    await invoke(["restore"], { stdin: Readable.from(["RESTORE\n"]) });
    await invoke(["doctor", "--fix", "--non-interactive", "--answers", '{"confirm":true}']);
    await invoke(["provider", "install", "opencode", "--non-interactive", "--answers", '{"confirm":true}']);
    await invoke(["logs"]);
    await invoke(["down"]);
    await invoke(["up"]);
    await invoke(["uninstall", "--non-interactive", "--answers", '{"confirm":true}']);
    await invoke(["up"]);
  }
  if (upgradeFrom) {
    const approved = ["--non-interactive", "--answers", '{"confirm":true}'];
    await invoke(["update", RUNTIME_VERSION, ...approved]);
    const upgraded = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    assert.equal(upgraded.version, RUNTIME_VERSION);
    assert.equal(upgraded.previousVersion, upgradeFrom);
    assert.equal(upgraded.engine, "podman");
    const checkpoints = await readdir(join(root, "checkpoints"));
    assert.ok(checkpoints.length > 0);
    assert.equal(JSON.parse(await readFile(join(root, "checkpoints", checkpoints.at(-1), "manifest.json"), "utf8")).version, upgradeFrom);
    await stat(join(root, "checkpoints", checkpoints.at(-1), "verified.json"));
    await invoke(["rollback", ...approved]);
    assert.equal(JSON.parse(await readFile(join(root, "config.json"), "utf8")).version, upgradeFrom);
    await ready();
  }
  await invoke(["uninstall", "--purge-data"], { stdin: Readable.from(["DELETE\n"]) });
  for (const kind of ["container", "volume", "network"]) assert.deepEqual(await ownedResources(kind), [], `leaked ${kind}`);
  purged = true;
  console.log(JSON.stringify({ test: "podman-launcher-smoke", profile, runtimeVersion: RUNTIME_VERSION, localImages, readyz: true, backup: true, extended, upgradeFrom: upgradeFrom ?? null, purged: true }));
} finally {
  // Scope every fallback removal to the unpredictable project belonging to this
  // temporary fixture. Never run system prune, image prune or an unfiltered rm.
  if (!purged) {
    for (const kind of ["container", "volume", "network"]) {
      const resources = await ownedResources(kind);
      if (resources.length) await podman([kind, "rm", ...(kind === "container" ? ["--force"] : []), ...resources]);
    }
  }
  assert.equal(resolve(root).startsWith(resolve(tmpdir()) + "/spaceapp-podman-smoke-"), true);
  await rm(root, { recursive: true, force: true });
}
