import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const mode of ["signal", "failure"]) {
  test(`Podman smoke awaits project cleanup after ${mode}`, { skip: process.platform === "win32", timeout: 15000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "podman-cleanup-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const dir of ["scripts", "packages/run-spaceapp/src", "packages/run-spaceapp/bin", "bin", "fixtures"]) await mkdir(join(root, dir), { recursive: true });
    // Run the unmodified smoke entry point against disposable command-boundary fixtures.
    await writeFile(join(root, "scripts/podman-launcher-smoke.mjs"), await readFile(new URL("../podman-launcher-smoke.mjs", import.meta.url)));
    await writeFile(join(root, "packages/run-spaceapp/src/package-info.mjs"), 'export const RUNTIME_VERSION="1.1.8";');
    await writeFile(join(root, "packages/run-spaceapp/src/index.mjs"), 'export const composeProjectName=()=>"spaceapp-signal-test"; export const composeCommand=()=>{}; export const loadConfig=()=>{};');
    await writeFile(join(root, "packages/run-spaceapp/bin/spaceapp.mjs"), mode === "signal"
      ? `import {spawn} from 'node:child_process';
console.log('INSTALLER '+process.pid);
const child=spawn(process.execPath,['-e','console.log("CHILD_READY");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','inherit']});
child.stdout.on('data',()=>{console.log('READY '+child.pid)});setInterval(()=>{},1000);`
      : 'process.exit(7);');
    await writeFile(join(root, "bin/podman"), `#!${process.execPath}
import('node:fs/promises').then(async ({appendFile})=>{
const args=process.argv.slice(2);await appendFile(process.env.TEST_LOG,JSON.stringify(args)+'\\n');
if(args.includes('--filter')&&!args.includes('label=com.docker.compose.project=spaceapp-signal-test'))process.exit(9);
if(args[0]==='ps')console.log('test-container');
else if(args[1]==='ls')console.log('test-'+args[0]);
else if(args.includes('rm'))await new Promise(resolve=>setTimeout(resolve,80));
});`, { mode: 0o755 });
    const child = spawn(process.execPath, [join(root, "scripts/podman-launcher-smoke.mjs")], {
      env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, SPACEAPP_SMOKE_TMPDIR: join(root, "fixtures"), SPACEAPP_SMOKE_SOURCE_VERSION: "", TEST_LOG: join(root, "commands.jsonl") },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const closed = once(child, "close");
    let output = "", errors = "", descendant, installer;
    child.stdout.on("data", (chunk) => {
      output += chunk;
      installer = Number(/INSTALLER (\d+)/.exec(output)?.[1]) || installer;
      const ready = /READY (\d+)/.exec(output);
      if (ready && !descendant) { descendant = Number(ready[1]); child.kill("SIGTERM"); }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    t.after(() => {
      child.kill("SIGKILL");
      if (installer) {
        try { process.kill(-installer, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    });
    const [code, signal] = await closed;
    assert.equal(signal, null, errors);
    assert.equal(code, mode === "signal" ? 143 : 1, errors);
    if (descendant) assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
    assert.deepEqual(await readdir(join(root, "fixtures")), []);
    const commands = (await readFile(join(root, "commands.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(commands.filter((args) => args.includes("rm")), [["rm", "-f", "test-container"], ["volume", "rm", "test-volume"], ["network", "rm", "test-network"]]);
  });
}
