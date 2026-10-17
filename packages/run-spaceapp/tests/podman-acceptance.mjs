#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { composeCommand, composeProjectName } from "../src/index.mjs";

const checkout = fileURLToPath(new URL("../../..", import.meta.url));
const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? checkout, ".podman-acceptance-"));
const project = composeProjectName(root);
const launcher = resolve(checkout, "packages/run-spaceapp/bin/spaceapp.mjs");
const env = { ...process.env, SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" };
const profile = process.env.SPACEAPP_ACCEPTANCE_PROFILE ?? "small";
assert.ok(["small", "medium", "large"].includes(profile));
const answers = JSON.stringify({ confirm: true, profile, access: "isolated", companions: false, telemetry: false, open: false });
// Main can advance before matching images are published. An explicit proof
// override exercises this launcher against a named public release, never an
// implicit fallback to different images. Include that version in the receipt.
const runtimeVersion = process.env.SPACEAPP_ACCEPTANCE_RUNTIME_VERSION;
if (runtimeVersion) assert.match(runtimeVersion, /^\d+\.\d+\.\d+$/);
const upgradeVersion = process.env.SPACEAPP_ACCEPTANCE_UPGRADE_VERSION;
if (upgradeVersion) { assert.match(upgradeVersion, /^\d+\.\d+\.\d+$/); assert.ok(runtimeVersion && upgradeVersion !== runtimeVersion); }
function command(file, args, { quiet = false, tolerate = false } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 20 * 60_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      const safe = output.replace(/One-time setup token:[^\r\n]*/gi, "One-time setup token: [redacted]");
      if (!quiet) process.stdout.write(safe);
      if (code === 0 || tolerate) accept(output); else reject(new Error(`${file} ${args[0]} exited ${code}`));
    });
  });
}
const cli = (...args) => command(process.execPath, runtimeVersion
  ? ["--input-type=module", "--eval", `import {run} from ${JSON.stringify(pathToFileURL(resolve(checkout, "packages/run-spaceapp/src/cli.mjs")).href)}; process.exitCode=await run(process.argv.slice(1),{runtimeVersion:${JSON.stringify(runtimeVersion)}});`, "--", ...args]
  : [launcher, ...args]);
async function ready() {
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:4911/readyz", { signal: AbortSignal.timeout(5000) });
      if (response.ok && (await response.json()).ok === true) return;
    } catch { /* Services can restart during a real version transition. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("SpaceApp readiness timed out");
}
try {
  await cli("install", "--engine", "podman", "--profile", profile, "--no-open", "--non-interactive", "--answers", answers);
  await ready();
  if (upgradeVersion) {
    await cli("update", upgradeVersion, "--non-interactive", "--answers", '{"confirm":true}');
    await ready();
    let installed = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    assert.equal(installed.version, upgradeVersion); assert.equal(installed.previousVersion, runtimeVersion);
    const checkpoints = (await readdir(join(root, "checkpoints"))).filter(name => name.startsWith("spaceapp-checkpoint-"));
    assert.ok(checkpoints.length > 0);
    for (const name of checkpoints) await readFile(join(root, "checkpoints", name, "verified.json"));
    await cli("rollback", "--non-interactive", "--answers", '{"confirm":true}');
    await ready();
    installed = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    assert.equal(installed.version, runtimeVersion);
    await cli("update", upgradeVersion, "--non-interactive", "--answers", '{"confirm":true}');
    await ready();
    console.log(JSON.stringify({ update: true, verifiedCheckpoint: true, rollback: true, from: runtimeVersion, to: upgradeVersion }));
  }
  await cli("doctor"); await cli("status"); await cli("backup");
  assert.ok((await readdir(join(root, "backups"))).some(name => name.startsWith("spaceapp-backup-")));
  if (process.env.SPACEAPP_ACCEPTANCE_EXTENDED === "1") {
    const writable = join(root, "writable"), readonly = join(root, "readonly");
    await mkdir(writable); await mkdir(readonly); await writeFile(join(readonly, "seed"), "read-only fixture");
    await cli("workspace", "add", writable); await cli("workspace", "add", readonly, "--read-only");
    await cli("up");
    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
    const rw = config.workspaces.find(workspace => workspace.hostPath === writable).containerPath;
    const ro = config.workspaces.find(workspace => workspace.hostPath === readonly).containerPath;
    const base = composeCommand("status", root, config).args.slice(0, -1);
    await command("podman", [...base, "exec", "-T", "--user", "10001:10001", "spaceapp-cli", "node", "--input-type=module", "-e",
      `import {readFile,writeFile} from 'node:fs/promises'; await writeFile(${JSON.stringify(rw + "/created")},'owned by caller'); if(await readFile(${JSON.stringify(ro + "/seed")},'utf8')!=='read-only fixture')throw Error('read failed'); try {await writeFile(${JSON.stringify(ro + "/forbidden")},'must fail'); throw Error('read-only write succeeded')}catch(error){if(!['EROFS','EACCES'].includes(error.code))throw error}`]);
    assert.equal((await stat(join(writable, "created"))).uid, process.getuid());
    assert.equal(await readFile(join(writable, "created"), "utf8"), "owned by caller");
    await cli("logs"); await cli("provider", "install", "opencode");
    await cli("doctor", "--fix", "--non-interactive", "--answers", '{"confirm":true}');
    await cli("down"); await cli("up");
    await cli("restore", "--non-interactive", "--answers", '{"confirm":true,"restore":"RESTORE"}');
    await cli("uninstall", "--non-interactive", "--answers", '{"confirm":true}');
    await cli("up");
    await cli("support-bundle", "--out", join(root, "support.json"));
    const bundle = JSON.parse(await readFile(join(root, "support.json"), "utf8"));
    assert.equal(bundle.engine.rootless, true); assert.equal(bundle.engine.cgroupVersion, "v2");
    console.log(JSON.stringify({ workspaceOwnership: true, readonlyMount: true, providerInstall: true, repair: true, restart: true, restore: true, uninstallRetainsData: true, supportBundle: true }));
  }
  await cli("uninstall", "--purge-data", "--non-interactive", "--answers", '{"confirm":true,"purge":"DELETE"}');
  console.log(JSON.stringify({ platform: process.platform, profile, engine: "podman", runtimeVersion: upgradeVersion ?? runtimeVersion ?? "launcher-default", ready: true, backup: true, purge: true }));
} finally {
  // The install may have failed before committing config. Remove only resources
  // labelled with this fresh acceptance project's deterministic identity.
  const ids = (await command("podman", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { quiet: true })).trim().split(/\s+/).filter(Boolean);
  for (const id of ids) { assert.match(id, /^[a-f0-9]+$/); await command("podman", ["rm", "-f", "-v", id], { quiet: true }); }
  for (const type of ["volume", "network"]) {
    const names = (await command("podman", [type, "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.Name}}"], { quiet: true })).trim().split(/\s+/).filter(Boolean);
    for (const name of names) { assert.ok(name.startsWith(project)); await command("podman", [type, "rm", name], { quiet: true }); }
  }
  assert.equal((await command("podman", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { quiet: true })).trim(), "");
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ cleaned: true, project }));
}
