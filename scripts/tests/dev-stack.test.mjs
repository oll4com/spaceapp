import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { configuration, prepareState, assertOwnedState, composeDocument, sourceEnvironment, openCodePackage } from "../dev-stack/config.mjs";
import { Processes, ensureMacNodePtySpawnHelper, redact, waitForReady } from "../dev-stack/processes.mjs";

async function fixture(t) {
  // macOS exposes /var through /private/var; match the launcher's canonical root.
  const root = await realpath(await mkdtemp(join(tmpdir(), "space-dev-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "starter-memory"));
  for (const name of ["space_memory.md", "space_memory_monthly.md", "installation-guide.md"]) await writeFile(join(root, "starter-memory", name), "starter");
  return configuration(root, {});
}

test("secrets persist across starts with private modes and the marker binds cleanup to its checkout", async (t) => {
  const config = await fixture(t);
  const first = await prepareState(config);
  assert.deepEqual(await prepareState(config), first);
  assert.equal((await stat(config.state)).mode & 0o777, 0o700);
  for (const name of Object.keys(first)) assert.equal((await stat(join(config.state, "secrets", name))).mode & 0o777, 0o600);
  await assertOwnedState(config);
  await assert.rejects(assertOwnedState({ ...config, project: "operator-install" }), /does not belong/);
});

test("refuses an unmarked directory or a symlink without changing it", async (t) => {
  const config = await fixture(t);
  await mkdir(config.state);
  await writeFile(join(config.state, "keep"), "important");
  await assert.rejects(prepareState(config));
  assert.equal(await readFile(join(config.state, "keep"), "utf8"), "important");
  await rm(config.state, { recursive: true });
  await symlink(join(config.root, "starter-memory"), config.state);
  await assert.rejects(prepareState(config), /symlink/);
});

test("the dev compose uses the installer's exact image digests and exposes only loopback ports", async (t) => {
  const config = await fixture(t);
  const template = await readFile(new URL("../../packages/run-spaceapp/templates/compose.yml", import.meta.url), "utf8");
  const doc = composeDocument(config, template);
  for (const service of Object.values(doc.services)) {
    assert.ok(template.includes(`image: ${service.image}`));
    assert.match(service.image, /@sha256:[a-f0-9]{64}$/);
    assert.ok(service.ports.every(p => p.startsWith("127.0.0.1:")));
  }
  assert.ok(!JSON.stringify(doc).includes("password-value"));
  assert.throws(() => composeDocument(config, template.replace(/@sha256:[a-f0-9]{64}/g, "")), /pinned/);
});

test("refuses redirected secret directories before writing outside checkout state", async (t) => {
  const config = await fixture(t);
  await prepareState(config);
  await rm(join(config.state, "secrets"), { recursive: true });
  await symlink(join(config.root, "starter-memory"), join(config.state, "secrets"));
  await assert.rejects(prepareState(config), /Invalid dev-stack directory/);
  await assert.rejects(readFile(join(config.root, "starter-memory", "postgres-password")), { code: "ENOENT" });
});

test("rejects installed ports, overlapping ports and invalid values before spawning anything", () => {
  for (const value of ["4910", "4911", "0", "-1", "65536", "hello", "5910.5"]) {
    assert.throws(() => configuration("/checkout", { SPACE_DEV_API_PORT: value }));
  }
  assert.throws(() => configuration("/checkout", { SPACE_DEV_API_PORT: "5911" }), /distinct/);
});

test("source services cannot inherit installed-instance paths, credentials or injected Node flags", async (t) => {
  const config = await fixture(t);
  const env = sourceEnvironment(config, await prepareState(config), {
    PATH: "/usr/bin", SPACE_DATABASE_URL: "postgresql://operator/live", SPACE_CLI_HOST_SOCKET: "/run/live.sock",
    OPENAI_API_KEY: "operator-key", NODE_OPTIONS: "--require operator-script", HOME: "/operator-home"
  });
  assert.equal(env.SPACE_DEV_LOGIN, "false");
  assert.equal(env.SPACE_INSTANCE, "dev");
  assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.ok(env.SPACE_DATABASE_URL.endsWith("/spaceapp_dev"));
  assert.ok(env.HOME.startsWith(config.state));
  assert.equal(env.SPACE_CLI_HOST_SOCKET, config.hostSocket);
});

test("reads both generations of the pinned OpenCode package from Dockerfile", () => {
  assert.equal(openCodePackage("npm install --global opencode-ai@1.18.4"), "opencode-ai@1.18.4");
  assert.equal(openCodePackage("npm install --global @opencode/cli@2.0.32"), "@opencode/cli@2.0.32");
  assert.throws(() => openCodePackage("npm install opencode-ai@latest"), /pinned/);
});

test("a failed worker aborts supervision and real child groups are terminated", async () => {
  const lines = [];
  const processes = new Processes({ output: line => lines.push(line), secrets: ["private-password"] });
  try {
    const alive = processes.start("web", process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, true);
    const failure = processes.start("worker", process.execPath, ["-e", "console.error('private-password'); process.exit(7)"], {}, true);
    await assert.rejects(failure.done, /worker exited unexpectedly \(7\)/);
    assert.equal(processes.abort.signal.aborted, true);
    assert.ok(lines.some(line => line.includes("[REDACTED]")));
    await processes.stop();
    await alive.done;
    assert.throws(() => process.kill(alive.child.pid, 0), { code: "ESRCH" });
  } finally { await processes.stop(); }
});

test("readiness requires ok:true rather than any HTTP response and respects abort", async () => {
  let status = { ok: false };
  const server = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(status)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/readyz`;
    await assert.rejects(waitForReady(url, new AbortController().signal, 30), /timeout/);
    for (const dependencies of [undefined,
      { database: "RUNNING", worker: "disabled", temporal: "disabled" },
      { database: "RUNNING", worker: "STALE", temporal: "enabled" },
      { database: "UNAVAILABLE", worker: "RUNNING", temporal: "enabled" }]) {
      status = { ok: true, dependencies };
      await assert.rejects(waitForReady(url, new AbortController().signal, 30), /timeout/);
    }
    status = { ok: true, dependencies: { database: "RUNNING", worker: "RUNNING", temporal: "enabled" } };
    await waitForReady(url, new AbortController().signal, 1000);
    const abort = new AbortController(); abort.abort(new Error("worker died"));
    await assert.rejects(waitForReady(url, abort.signal), /worker died/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.equal(redact("url: secret-value", ["secret-value"]), "url: [REDACTED]");
});

test("smoke cleanup resets resources even when the launcher has already failed", async (t) => {
  const config = await fixture(t);
  const scripts = join(config.root, "scripts");
  await mkdir(join(scripts, "dev-stack"), { recursive: true });
  for (const file of ["dev-stack-smoke.mjs", "dev-stack/config.mjs", "dev-stack/processes.mjs"]) {
    await copyFile(new URL(`../${file}`, import.meta.url), join(scripts, file));
  }
  await symlink(new URL("../../node_modules", import.meta.url).pathname, join(config.root, "node_modules"));
  const fakeNpm = join(config.root, "fake-npm.mjs");
  await writeFile(fakeNpm, `
    import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
    if (process.argv.includes('reset')) {
      rmSync('.dev-stack', { recursive: true, force: true });
      writeFileSync('reset-proof', 'cleaned');
    } else {
      mkdirSync('.dev-stack');
      process.exitCode = 9;
    }
  `);
  const processes = new Processes({ output: () => {} });
  try {
    await assert.rejects(processes.run("smoke", process.execPath, [join(scripts, "dev-stack-smoke.mjs")], {
      cwd: config.root, env: { ...process.env, npm_execpath: fakeNpm }
    }), /exited unexpectedly \(1\)/);
    assert.equal(await readFile(join(config.root, "reset-proof"), "utf8"), "cleaned");
    await assert.rejects(stat(config.state), { code: "ENOENT" });
  } finally { await processes.stop(); }
});


test("macOS node-pty spawn-helper repairs only the checkout dependency execute bit", async (t) => {
  const config = await fixture(t);
  const dir = join(config.root, "node_modules", "node-pty", "prebuilds", "darwin-x64");
  const helper = join(dir, "spawn-helper");
  await mkdir(dir, { recursive: true });
  await writeFile(helper, "native helper fixture", { mode: 0o644 });
  await chmod(helper, 0o644);
  assert.equal(await ensureMacNodePtySpawnHelper(config.root, "linux", "x64"), false);
  assert.equal((await stat(helper)).mode & 0o111, 0);
  assert.equal(await ensureMacNodePtySpawnHelper(config.root, "darwin", "x64"), true);
  assert.equal((await stat(helper)).mode & 0o111, 0o111);
  assert.equal(await ensureMacNodePtySpawnHelper(config.root, "darwin", "x64"), false);
  await rm(helper);
  await symlink(join(config.root, "starter-memory", "space_memory.md"), helper);
  await assert.rejects(ensureMacNodePtySpawnHelper(config.root, "darwin", "x64"), /symlinked/);
});
