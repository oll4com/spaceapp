import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertSafeStateRoot,
  dockerResources,
  ensureBuild,
  installOpenCode,
  ownerSetupBanner,
  waitReady,
  parseOpenCodeVersion,
  parsePinnedImages,
  prepareState,
  renderCompose,
  resolveConfig,
  run,
  sleep,
  sourceEnv
} from "./dev-stack-lib.mjs";
import { ensureDarwinNodePtySpawnHelpers, reset, spawnService } from "./dev-stack.mjs";
import {
  assertSafeDevStackOverrides,
  claimStateOwnership,
  claimSupervisor,
  ownedSupervisorPid,
  readStateOwnership,
  releaseSupervisor,
  spawnOwnedProcess,
  supervisorRecordMatches,
  terminateOwnedProcessGroups,
  writeProcessRecords
} from "./dev-stack-safety.mjs";

const ownership = (rootHash) => ({ version: 1, rootHash, token: "a".repeat(48) });

test("captured commands wait for inherited output streams to close", async () => {
  const delayedOutput = 'setTimeout(() => { process.stdout.write("complete output"); process.stderr.write("complete error"); }, 100)';
  const script = `
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(delayedOutput)}], { stdio: ["ignore", process.stdout, process.stderr] });
    process.exit(0);
  `;
  const result = await run(process.execPath, ["-e", script], { capture: true });
  assert.equal(result.stdout, "complete output");
  assert.match(result.stderr, /complete error$/);
});

test("build markers ignore generated-directory timestamps but detect source changes and deletions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-build-marker-"));
  const config = { root, buildMarker: join(root, "build.json") };
  const source = join(root, "packages", "contracts", "src", "index.ts");
  const artifacts = ["packages/contracts/dist/index.js", "packages/runtime/dist/index.js", "packages/db/dist/migrate.js", "packages/cli-host/dist/main.js", "apps/worker/dist/worker.js"];
  let builds = 0;
  try {
    await mkdir(join(root, "packages", "contracts", "src"), { recursive: true });
    await mkdir(join(root, "apps", "worker", "src"), { recursive: true });
    await writeFile(source, "export const value = 1;\n");
    const runner = async () => {
      builds += 1;
      for (const artifact of artifacts) {
        const target = join(root, artifact);
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, "// built\n");
      }
      const future = new Date(Date.now() + 2000);
      await utimes(join(root, "packages"), future, future);
    };
    await ensureBuild(config, false, runner);
    await ensureBuild(config, false, runner);
    assert.equal(builds, 1, "startup must not rebuild solely because dist directories were created");

    await writeFile(source, "export const value = 22;\n");
    await ensureBuild(config, false, runner);
    assert.equal(builds, 2);
    await rm(source);
    await ensureBuild(config, false, runner);
    assert.equal(builds, 3, "source deletion must invalidate the marker");
    await rm(join(root, artifacts[0]));
    await ensureBuild(config, false, runner);
    assert.equal(builds, 4, "missing artifacts must trigger a build");
    await ensureBuild(config, true, runner);
    assert.equal(builds, 5, "explicit rebuild must remain unconditional");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup build ownership covers cancellation, success, and failure", { skip: process.platform === "win32" }, async (t) => {
  for (const mode of ["cancel", "renamed-cancel", "slow-down", "repeated-stop", "success", "failure", "spawn-failure"]) await t.test(mode, async () => {
    const delayedDocker = ["slow-down", "repeated-stop"].includes(mode);
    const cancel = mode.endsWith("cancel") || delayedDocker;
    const root = await mkdtemp(join(tmpdir(), "spaceapp-build-cancel-"));
    const config = await resolveConfig({}, root);
    const bin = join(root, "fake-bin");
    const familyFile = join(root, "build-family.json");
    const migrationFile = join(root, "migration-started");
    const dockerStopping = join(root, "docker-stopping");
    const dockerStopped = join(root, "docker-stopped");
    let supervisor;
    let downCaller;
    let unrelated;
    let family;
    let output = "";
    try {
      await mkdir(bin);
      await mkdir(join(root, "packages", "run-spaceapp", "templates"), { recursive: true });
      await writeFile(join(root, "packages", "run-spaceapp", "templates", "compose.yml"), `services:\n  postgres:\n    image: pgvector/pgvector:test@sha256:${"a".repeat(64)}\n  temporal:\n    image: temporalio/auto-setup:test@sha256:${"b".repeat(64)}\n`);
      await writeFile(join(root, "Dockerfile"), "RUN npm install opencode-ai@1.18.4\n");
      await writeFile(join(bin, "docker"), `#!${process.execPath}
        const args = process.argv.slice(2);
        const fs = require("node:fs");
        if (${delayedDocker} && args[0] === "ps" && !fs.existsSync(${JSON.stringify(dockerStopped)})) console.log("fixture-container");
        else if (${delayedDocker} && args[0] === "compose" && args.includes("down")) {
          fs.appendFileSync(${JSON.stringify(dockerStopping)}, "down\\n");
          setTimeout(() => fs.writeFileSync(${JSON.stringify(dockerStopped)}, "stopped"), ${mode === "slow-down" ? 16100 : 300});
        }
        else if (args[0] === "inspect") console.log("healthy");
        else if (args[0] === "compose" && args.includes("ps")) console.log("fixture-service");
      `, { mode: 0o700 });
      await writeFile(join(bin, "npm"), `#!${process.execPath}
        const fs = require("node:fs");
        if (process.argv[3] === "build") {
          if (${!cancel}) {
            fs.writeFileSync(${JSON.stringify(familyFile)}, JSON.stringify({ leader: process.pid }));
            process.exit(${mode === "failure" ? 2 : 0});
          }
          process.title = "npm run build";
          const descendant = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: {}, stdio: ["ignore", "inherit", "inherit"] });
          fs.writeFileSync(${JSON.stringify(familyFile)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
          setInterval(() => {}, 1000);
        } else if (process.argv[3] === "db:migrate") {
          fs.writeFileSync(${JSON.stringify(migrationFile)}, fs.readFileSync(${JSON.stringify(config.processFile)}, "utf8"));
          process.exit(2); // Stop the fixture before launching real services.
        }
      `, { mode: 0o700 });
      if (mode === "renamed-cancel") {
        // Darwin ps can stop at process.title's NUL padding before reaching
        // the environment. Model that output on every test platform.
        await writeFile(join(bin, "ps"), `#!${process.execPath}
          const fs = require("node:fs");
          const args = process.argv.slice(2);
          const family = fs.existsSync(${JSON.stringify(familyFile)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(familyFile)}, "utf8")) : {};
          if (args[0] === "eww" && Number(args[args.indexOf("-p") + 1]) === family.leader) {
            console.log("npm run build");
          } else {
            const result = require("node:child_process").spawnSync("/bin/ps", args, { encoding: "utf8" });
            process.stdout.write(result.stdout || "");
            process.stderr.write(result.stderr || "");
            process.exit(result.status ?? 1);
          }
        `, { mode: 0o700 });
      }
      if (mode === "spawn-failure") {
        await writeFile(join(bin, "npm"), "#!/spaceapp-test-nonexistent-interpreter\n", { mode: 0o700 });
      }
      const launcher = join(root, "dev-stack.mjs");
      await writeFile(launcher, `
        import { start } from ${JSON.stringify(new URL("./dev-stack.mjs", import.meta.url).href)};
        import { resolveConfig } from ${JSON.stringify(new URL("./dev-stack-lib.mjs", import.meta.url).href)};
        start(await resolveConfig({}, ${JSON.stringify(root)})).catch(error => { console.error(error.message); process.exitCode = 1; });
      `);
      unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      supervisor = spawn(process.execPath, [launcher], {
        detached: true,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` },
        stdio: ["ignore", "pipe", "pipe"]
      });
      supervisor.stdout.on("data", chunk => { output += chunk.toString(); });
      supervisor.stderr.on("data", chunk => { output += chunk.toString(); });
      const startedDeadline = Date.now() + 10000;
      while (!existsSync(familyFile) && Date.now() < startedDeadline && supervisor.exitCode === null) await sleep(25);
      assert.equal(existsSync(familyFile), mode !== "spawn-failure", output);
      if (existsSync(familyFile)) family = JSON.parse(await readFile(familyFile, "utf8"));
      if (delayedDocker) {
        const downLauncher = join(root, "down.mjs");
        await writeFile(downLauncher, `
          import { down } from ${JSON.stringify(new URL("./dev-stack.mjs", import.meta.url).href)};
          import { resolveConfig } from ${JSON.stringify(new URL("./dev-stack-lib.mjs", import.meta.url).href)};
          down(await resolveConfig({}, ${JSON.stringify(root)})).catch(error => { console.error(error.message); process.exitCode = 1; });
        `);
        downCaller = spawn(process.execPath, [downLauncher], { env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` }, stdio: ["ignore", "pipe", "pipe"] });
        downCaller.stdout.on("data", chunk => { output += chunk.toString(); });
        downCaller.stderr.on("data", chunk => { output += chunk.toString(); });
        const stoppingDeadline = Date.now() + 10000;
        while (!existsSync(dockerStopping) && Date.now() < stoppingDeadline) await sleep(25);
        assert.equal(existsSync(dockerStopping), true, output);
        if (mode === "repeated-stop") {
          supervisor.kill("SIGTERM");
          supervisor.kill("SIGINT");
          await sleep(25);
          supervisor.kill("SIGINT");
        }
      } else if (cancel) supervisor.kill("SIGTERM");
      const stoppedDeadline = Date.now() + (delayedDocker ? 25000 : 10000);
      while (supervisor.exitCode === null && supervisor.signalCode === null && Date.now() < stoppedDeadline) await sleep(25);
      assert.notEqual(supervisor.exitCode ?? supervisor.signalCode, null, output);
      if (downCaller) {
        while (downCaller.exitCode === null && downCaller.signalCode === null && Date.now() < stoppedDeadline) await sleep(25);
        assert.equal(downCaller.exitCode, 0, output);
        assert.equal(supervisor.signalCode, null, "Repeated stop signals must not interrupt the supervisor's cleanup.");
        assert.equal(await readFile(dockerStopping, "utf8"), "down\n", "Only the supervisor should run Docker teardown while it is alive.");
      }
      for (const pid of [family?.leader, family?.descendant].filter(Number.isInteger)) {
        const result = await run("ps", ["-p", String(pid), "-o", "stat="], { capture: true, allowFailure: true });
        assert.ok(result.code !== 0 || result.stdout.startsWith("Z"), `build PID ${pid} survived cancellation: ${result.stdout}`);
      }
      assert.equal(existsSync(migrationFile), mode === "success", "only successful builds may advance startup to migrations");
      assert.equal(existsSync(config.buildMarker), mode === "success", "only successful builds may write a success marker");
      if (mode === "success") {
        assert.deepEqual(JSON.parse(await readFile(migrationFile, "utf8")).groups.map(record => record.name), ["migrations"], "completed builds must be untracked while migrations own their command group");
      }
      if (existsSync(config.processFile)) {
        assert.deepEqual(JSON.parse(await readFile(config.processFile, "utf8")).groups, [], "terminated builds must leave no tracked groups");
      }
      assert.equal(existsSync(config.pidFile), false);
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "an unrelated process must remain alive");
    } finally {
      if (downCaller?.exitCode === null && downCaller?.signalCode === null) downCaller.kill("SIGKILL");
      for (const pid of [supervisor?.pid, family?.leader, unrelated?.pid]) {
        if (Number.isInteger(pid)) try { process.kill(-pid, "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("down and reset terminate in-progress migrations and OpenCode installs", { skip: process.platform === "win32" }, async (t) => {
  for (const phase of ["db:migrate", "opencode-install"]) await t.test(phase, async () => {
    const root = await mkdtemp(join(tmpdir(), "spaceapp-startup-command-"));
    const config = await resolveConfig({}, root);
    const bin = join(root, "fake-bin");
    const familyFile = join(root, "command-family.json");
    let supervisor;
    let downCaller;
    let unrelated;
    let family;
    let output = "";
    try {
      await mkdir(bin);
      await mkdir(join(root, "packages", "run-spaceapp", "templates"), { recursive: true });
      await writeFile(join(root, "packages", "run-spaceapp", "templates", "compose.yml"), `services:\n  postgres:\n    image: pgvector/pgvector:test@sha256:${"a".repeat(64)}\n  temporal:\n    image: temporalio/auto-setup:test@sha256:${"b".repeat(64)}\n`);
      await writeFile(join(root, "Dockerfile"), "RUN npm install opencode-ai@1.18.4\n");
      await writeFile(join(bin, "docker"), `#!${process.execPath}
        const args = process.argv.slice(2);
        if (args[0] === "inspect") console.log("healthy");
        else if (args[0] === "compose" && args.includes("ps")) console.log("fixture-service");
      `, { mode: 0o700 });
      await writeFile(join(bin, "npm"), `#!${process.execPath}
        const args = process.argv.slice(2);
        const phase = args[0] === "install" ? "opencode-install" : args[1];
        if (phase === ${JSON.stringify(phase)}) {
          process.title = "npm " + args.slice(0, 2).join(" ");
          const descendant = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: {}, stdio: ["ignore", "inherit", "inherit"] });
          require("node:fs").writeFileSync(${JSON.stringify(familyFile)}, JSON.stringify({ leader: process.pid, descendant: descendant.pid }));
          setInterval(() => {}, 1000);
        }
      `, { mode: 0o700 });
      const launcher = join(root, "dev-stack.mjs");
      const lifecycle = join(root, "lifecycle.mjs");
      const libUrl = new URL("./dev-stack-lib.mjs", import.meta.url).href;
      const stackUrl = new URL("./dev-stack.mjs", import.meta.url).href;
      await writeFile(launcher, `
        import { start } from ${JSON.stringify(stackUrl)};
        import { resolveConfig } from ${JSON.stringify(libUrl)};
        start(await resolveConfig({}, ${JSON.stringify(root)})).catch(error => { console.error(error.message); process.exitCode = 1; });
      `);
      await writeFile(lifecycle, `
        import { down, reset } from ${JSON.stringify(stackUrl)};
        import { resolveConfig } from ${JSON.stringify(libUrl)};
        const command = process.argv[2] === "reset" ? reset : down;
        command(await resolveConfig({}, ${JSON.stringify(root)})).catch(error => { console.error(error.message); process.exitCode = 1; });
      `);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH || ""}` };
      unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      supervisor = spawn(process.execPath, [launcher], { detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
      supervisor.stdout.on("data", chunk => { output += chunk.toString(); });
      supervisor.stderr.on("data", chunk => { output += chunk.toString(); });
      const startedDeadline = Date.now() + 10000;
      while (!existsSync(familyFile) && Date.now() < startedDeadline && supervisor.exitCode === null) await sleep(25);
      assert.equal(existsSync(familyFile), true, output);
      family = JSON.parse(await readFile(familyFile, "utf8"));
      downCaller = spawn(process.execPath, [lifecycle, "down"], { env, stdio: ["ignore", "pipe", "pipe"] });
      downCaller.stdout.on("data", chunk => { output += chunk.toString(); });
      downCaller.stderr.on("data", chunk => { output += chunk.toString(); });
      const stoppedDeadline = Date.now() + 10000;
      while ((downCaller.exitCode === null && downCaller.signalCode === null || supervisor.exitCode === null && supervisor.signalCode === null) && Date.now() < stoppedDeadline) await sleep(25);
      assert.equal(downCaller.exitCode, 0, output);
      assert.notEqual(supervisor.exitCode, null, output);
      const survivors = [];
      for (const pid of [family.leader, family.descendant]) {
        const result = await run("ps", ["-p", String(pid), "-o", "stat="], { capture: true, allowFailure: true });
        if (result.code === 0 && !result.stdout.startsWith("Z")) survivors.push({ pid, state: result.stdout });
      }
      assert.deepEqual(survivors, [], `${phase} processes survived down: ${JSON.stringify(survivors)}`);
      assert.equal(existsSync(config.pidFile), false);
      assert.equal(existsSync(config.processFile), false);
      await run(process.execPath, [lifecycle, "reset"], { env, capture: true });
      assert.equal(existsSync(config.stateRoot), false);
      assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "an unrelated process must remain alive");
    } finally {
      if (downCaller?.exitCode === null && downCaller?.signalCode === null) downCaller.kill("SIGKILL");
      for (const pid of [supervisor?.pid, family?.leader, unrelated?.pid]) {
        if (Number.isInteger(pid)) try { process.kill(-pid, "SIGKILL"); } catch {}
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("owner setup banner only reveals a live, unclaimed token", async () => {
  const config = { ports: { api: 5910 }, secretsDir: "/test/secrets" };
  const token = "a".repeat(64);
  const nowMs = Date.parse("2026-10-19T00:00:00Z");
  let status = { setupRequired: true, expiresAt: "2026-10-19T00:15:00Z" };
  let reads = 0;
  const readSecret = async (path, encoding) => {
    reads++;
    assert.equal(path, join(config.secretsDir, "setup-token"));
    assert.equal(encoding, "utf8");
    return `${token}\n`;
  };
  const request = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:5910/api/setup/status");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, status: 200, json: async () => status };
  };
  const options = { request, readSecret, nowMs };

  assert.equal(await ownerSetupBanner(config, options), `Owner setup token: ${token}`);
  assert.equal(reads, 1);

  status = { setupRequired: false, expiresAt: null };
  const claimed = await ownerSetupBanner(config, options);
  assert.match(claimed, /Owner setup already complete/);
  assert.doesNotMatch(claimed, /[a-f0-9]{64}/);
  assert.equal(reads, 1, "claimed owner must never cause a secret read");

  status = { setupRequired: true, expiresAt: "2026-10-18T23:59:59Z" };
  assert.match(await ownerSetupBanner(config, options), /expired or unavailable/);
  assert.equal(reads, 1, "expired setup token must not be read");

  status = { setupRequired: true, expiresAt: null };
  assert.match(await ownerSetupBanner(config, options), /expired or unavailable/);
  assert.equal(reads, 1, "missing expiry must not disclose a token");

  status = { setupRequired: true, expiresAt: "2026-10-19T00:15:00Z" };
  await assert.rejects(() => ownerSetupBanner(config, {
    request,
    nowMs,
    readSecret: async () => "unsafe\\nvalue"
  }), /Invalid dev-stack owner setup token file/);
});

test("owner setup banner fails closed on unverifiable API status", async () => {
  const config = { ports: { api: 5910 }, secretsDir: "/test/secrets" };
  const readSecret = async () => {
    assert.fail("unverified owner status must not read local token");
  };
  for (const [name, response] of [
    ["unauthorized response", { ok: false, status: 503 }],
    ["missing field", { ok: true, json: async () => ({ expiresAt: null }) }],
    ["invalid expiry type", { ok: true, json: async () => ({ setupRequired: true, expiresAt: 123 }) }],
    ["malformed payload", { ok: true, json: async () => null }]
  ]) {
    await assert.rejects(
      () => ownerSetupBanner(config, { readSecret, request: async () => response }),
      /status|token/,
      name
    );
  }
});

test("readiness returns on deadline when HTTP headers or body never finish", { timeout: 7000 }, async () => {
  for (const stallAfterHeaders of [false, true]) {
    const server = createServer((_request, response) => {
      if (stallAfterHeaders) {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
      }
      // Deliberately never send a response body or end the connection.
    });
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    try {
      const startedAt = Date.now();
      await assert.rejects(
        () => waitReady({ ports: { api: server.address().port } }, 150),
        /did not reach \/readyz/,
        stallAfterHeaders ? "stalled response body" : "stalled response headers"
      );
      assert.ok(Date.now() - startedAt < 2500, "readiness must honor an overall deadline");
    } finally {
      server.closeAllConnections();
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
    }
  }
});

test("source stack derives third-party pins from canonical files", () => {
  const images = parsePinnedImages(`
services:
  postgres:
    image: pgvector/pgvector:0.8.3-pg17-trixie@sha256:${"a".repeat(64)}
  temporal:
    image: temporalio/auto-setup:1.29.1@sha256:${"b".repeat(64)}
`);
  assert.equal(images.postgres, `pgvector/pgvector:0.8.3-pg17-trixie@sha256:${"a".repeat(64)}`);
  assert.equal(images.temporal, `temporalio/auto-setup:1.29.1@sha256:${"b".repeat(64)}`);
  assert.equal(parseOpenCodeVersion("RUN npm install --global opencode-ai@1.18.4"), "1.18.4");
  assert.throws(() => parsePinnedImages("services: {}"), /digest-pinned/);
  assert.throws(() => parseOpenCodeVersion("RUN npm install opencode-ai@latest"), /pinned/);
});

test("OpenCode wrapper isolates writable state and preserves literal checkout paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-opencode-$literal-'quote-"));
  try {
    const config = await resolveConfig({}, root);
    await mkdir(config.binDir, { recursive: true });
    await mkdir(join(config.vendorDir, "node_modules", "opencode-ai"), { recursive: true });
    await mkdir(join(config.vendorDir, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(config.vendorDir, "node_modules", "opencode-ai", "package.json"), JSON.stringify({ version: "1.18.4" }));
    const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP"];
    await writeFile(join(config.vendorDir, "node_modules", ".bin", "opencode"),
      `#!${process.execPath}\nconsole.log(JSON.stringify({paths:Object.fromEntries(${JSON.stringify(keys)}.map(k=>[k,process.env[k]])),key:process.env.OPENCODE_API_KEY,args:process.argv.slice(2)}));\n`, { mode: 0o700 });
    const wrapper = await installOpenCode(config, "1.18.4");
    const { stdout } = await promisify(execFile)(wrapper, ["argument with spaces", "$literal"], {
      env: { ...process.env, ...Object.fromEntries(keys.map((key) => [key, "/proc/spaceapp-unwritable"])), OPENCODE_API_KEY: "parent-key" }
    });
    const result = JSON.parse(stdout);
    const dirs = ["home", "config", "data", "cache", "state", "tmp", "tmp", "tmp"];
    for (const [index, key] of keys.entries()) {
      assert.equal(result.paths[key], join(config.providerRoot, dirs[index]));
      assert.equal((await stat(result.paths[key])).isDirectory(), true);
    }
    assert.equal(result.key, undefined);
    assert.deepEqual(result.args, ["argument with spaces", "$literal"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reset removes only the state directory it initialized when Docker inventory is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-reset-empty-"));
  const oldPath = process.env.PATH;
  try {
    const bin = join(root, "fake-bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.PATH = `${bin}:${oldPath || ""}`;
    const config = await resolveConfig({}, root);
    await claimStateOwnership(config);
    await reset(config);
    assert.equal(existsSync(config.stateRoot), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming credentials stay private inside owned state and reset preserves an installed instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-streaming-isolation-"));
  const installedRoot = join(root, "installed-streaming");
  const oldPath = process.env.PATH;
  const oldStreamingRoot = process.env.SPACE_STREAMING_SECRET_ROOT;
  try {
    await mkdir(installedRoot, { mode: 0o755 });
    const sentinel = join(installedRoot, "keep.json");
    await writeFile(sentinel, "installed instance\n", { mode: 0o600 });
    const installedMode = (await stat(installedRoot)).mode & 0o777;
    process.env.SPACE_STREAMING_SECRET_ROOT = installedRoot;
    const config = await resolveConfig({}, root);
    const env = sourceEnv(config, "postgresql://unused", "test-session-secret", join(config.binDir, "opencode-vscode-parity"));
    assert.equal(env.SPACE_STREAMING_SECRET_ROOT, join(config.secretsDir, "streaming"));
    await claimStateOwnership(config);
    await prepareState(config);
    await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { StreamingCredentialStore } from "./packages/streaming/src/credential-store.ts";
      const store = new StreamingCredentialStore(process.env.SPACE_STREAMING_SECRET_ROOT);
      await store.writeCredential("dev-stack-probe", { probe: "owned test data" });
    `], { env, capture: true });
    const streamingRoot = env.SPACE_STREAMING_SECRET_ROOT;
    const credentials = join(streamingRoot, "credentials");
    assert.equal((await stat(streamingRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(credentials)).mode & 0o777, 0o700);
    const files = await readdir(credentials);
    assert.equal(files.length, 1);
    assert.equal((await stat(join(credentials, files[0]))).mode & 0o777, 0o600);

    const bin = join(root, "fake-bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.PATH = `${bin}:${oldPath || ""}`;
    await reset(config);
    assert.equal(existsSync(config.stateRoot), false);
    assert.equal(await readFile(sentinel, "utf8"), "installed instance\n");
    assert.equal((await stat(installedRoot)).mode & 0o777, installedMode);
    assert.deepEqual(await readdir(installedRoot), ["keep.json"]);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldStreamingRoot === undefined) delete process.env.SPACE_STREAMING_SECRET_ROOT;
    else process.env.SPACE_STREAMING_SECRET_ROOT = oldStreamingRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults isolate installed SpaceApp and bind Docker ports to loopback", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-test-"));
  try {
    const config = await resolveConfig({}, root);
    assert.notEqual(config.ports.api, 4910);
    assert.notEqual(config.ports.web, 4911);
    assert.match(config.project, /^spaceapp-dev-[a-f0-9]{10}$/);
    const compose = renderCompose(config, {
      postgres: `pgvector/pgvector:0.8.3@sha256:${"c".repeat(64)}`,
      temporal: `temporalio/auto-setup:1.29.1@sha256:${"d".repeat(64)}`
    }, ownership(config.rootHash));
    for (const port of [config.ports.postgres, config.ports.temporal]) assert.match(compose, new RegExp(`127\\.0\\.0\\.1:${port}:`));
    assert.match(compose, /POSTGRES_PASSWORD: \$\{SPACEAPP_DEV_POSTGRES_PASSWORD/);
    assert.match(compose, /POSTGRES_PWD: \$\{SPACEAPP_DEV_POSTGRES_PASSWORD/);
    assert.doesNotMatch(compose, /\/run\/secrets\/postgres-password|secrets:\s*\[postgres-password\]/);
    assert.match(compose, /condition: service_healthy/);
    assert.match(compose, /temporal operator cluster health --address temporal:7233/);
    assert.equal((compose.match(/com\.spaceapp\.dev-stack\.owner:/g) || []).length, 4);

    const wrapper = join(config.binDir, "opencode-vscode-parity");
    const oldComposePassword = process.env.SPACEAPP_DEV_POSTGRES_PASSWORD;
    const oldProcessToken = process.env.SPACE_DEV_PROCESS_TOKEN;
    process.env.SPACEAPP_DEV_POSTGRES_PASSWORD = "compose-only-secret";
    process.env.SPACE_DEV_PROCESS_TOKEN = "caller-supplied-token";
    try {
      const env = sourceEnv(config, "postgresql://spaceapp:test@127.0.0.1:55432/spaceapp_dev", "session-secret-with-enough-length", wrapper);
      assert.equal(env.SPACE_CLI_COMMAND_PATH, config.binDir);
      assert.equal(env.SPACE_CLI_OPENCODE_COMMAND, "opencode-vscode-parity");
      assert.equal(env.SPACE_DEV_LOGIN, "false");
      assert.equal(env.SPACE_API_HOST, "127.0.0.1");
      assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
      assert.equal(env.SPACEAPP_DEV_POSTGRES_PASSWORD, undefined);
      assert.equal(env.SPACE_DEV_PROCESS_TOKEN, undefined);
      assert.throws(() => sourceEnv(config, "postgresql://x", "session-secret-with-enough-length", "/tmp/opencode-vscode-parity"), /controlled dev-stack command directory/);
    } finally {
      if (oldComposePassword === undefined) delete process.env.SPACEAPP_DEV_POSTGRES_PASSWORD;
      else process.env.SPACEAPP_DEV_POSTGRES_PASSWORD = oldComposePassword;
      if (oldProcessToken === undefined) delete process.env.SPACE_DEV_PROCESS_TOKEN;
      else process.env.SPACE_DEV_PROCESS_TOKEN = oldProcessToken;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source services do not inherit provider or cloud credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-source-env-"));
  const keys = ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY", "QWEN_API_KEY", "KIMI_API_KEY", "XAI_API_KEY", "AUTOHAND_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "CUSTOM_PROVIDER_CREDENTIAL"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = `sentinel-${key}`;
    const config = await resolveConfig({}, root);
    const env = sourceEnv(config, "postgresql://unused", "test-session-secret", join(config.binDir, "opencode-vscode-parity"));
    for (const key of keys) assert.equal(env[key], undefined, `${key} must not cross into source services`);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.SPACE_MEMORY_ROOT, config.memoryRoot);
  } finally {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an overlong UTF-8 TMPDIR socket fallback before startup", async () => {
  const base = await mkdtemp(join(tmpdir(), "spaceapp-socket-path-"));
  const checkout = join(base, `checkout-${"é".repeat(35)}`);
  const deepTmp = join(base, `temporary-${"é".repeat(35)}`);
  const oldTmpdir = process.env.TMPDIR;
  try {
    await mkdir(checkout, { recursive: true });
    await mkdir(deepTmp, { recursive: true });
    process.env.TMPDIR = deepTmp;
    assert.ok(Buffer.byteLength(join(checkout, "run", "cli-host.sock")) > 96);
    await assert.rejects(() => resolveConfig({}, checkout), /Unix socket path exceeds the 96-byte limit after fallback/);
  } finally {
    if (oldTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmpdir;
    await rm(base, { recursive: true, force: true });
  }
});

test("spawn failure is handled before PID validation can interrupt cleanup", async () => {
  const failures = [];
  assert.throws(() => spawnService(
    { root: process.cwd() },
    "missing-service",
    join(tmpdir(), `no-such-spaceapp-command-${process.pid}`),
    [],
    {},
    ownership("a".repeat(10)),
    (...args) => failures.push(args)
  ), /Could not establish a process-group leader/);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(failures.length, 1);
  assert.equal(failures[0][0], "missing-service");
  assert.equal(failures[0][2], null);
  assert.equal(failures[0][3].code, "ENOENT");
});

test("unsafe state roots and installed-instance ports fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-dev-root-"));
  try {
    await assert.rejects(() => assertSafeStateRoot(root, root), /Unsafe dev-stack state directory/);
    const target = join(root, "real-state");
    const link = join(root, ".dev-stack-link");
    await mkdir(target);
    await symlink(target, link);
    await assert.rejects(() => assertSafeStateRoot(link, join(root, "checkout")), /may not be a symlink/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_API_PORT: "4910" }, root), /reserved for an installed SpaceApp/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_WEB_PORT: "4911" }, root), /reserved for an installed SpaceApp/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_POSTGRES_PORT: "4910" }, root), /postgres port 4910 is reserved/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_TEMPORAL_PORT: "4911" }, root), /temporal port 4911 is reserved/);
    await assert.rejects(() => resolveConfig({ SPACE_DEV_API_PORT: "6000", SPACE_DEV_WEB_PORT: "6000" }, root), /conflicts/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("destructive ownership selectors cannot be overridden", () => {
  assert.doesNotThrow(() => assertSafeDevStackOverrides({}));
  assert.throws(() => assertSafeDevStackOverrides({ SPACE_DEV_STACK_DIR: "/tmp/shared" }), /SPACE_DEV_STACK_DIR/);
  assert.throws(() => assertSafeDevStackOverrides({ SPACE_DEV_COMPOSE_PROJECT: "someone-elses-project" }), /SPACE_DEV_COMPOSE_PROJECT/);
});

test("state ownership never adopts a pre-existing or corrupt directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-state-owner-"));
  const config = await resolveConfig({}, root);
  try {
    const owner = await claimStateOwnership(config);
    assert.equal(owner.rootHash, config.rootHash);
    assert.match(owner.token, /^[a-f0-9]{48}$/);
    assert.deepEqual(await readStateOwnership(config), owner);

    await writeFile(config.ownerFile, "not-json\n", { mode: 0o600 });
    await assert.rejects(() => readStateOwnership(config), /unreadable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const preexistingRoot = await mkdtemp(join(tmpdir(), "spaceapp-state-preexisting-"));
  const preexistingConfig = await resolveConfig({}, preexistingRoot);
  try {
    await mkdir(preexistingConfig.stateRoot, { mode: 0o700 });
    await assert.rejects(() => claimStateOwnership(preexistingConfig), /Refusing to adopt pre-existing state directory/);
    await writeFile(join(preexistingConfig.stateRoot, "keep-me"), "foreign\n");
    await assert.rejects(() => claimStateOwnership(preexistingConfig), /Refusing to adopt pre-existing state directory/);
    assert.equal(await readFile(join(preexistingConfig.stateRoot, "keep-me"), "utf8"), "foreign\n");
  } finally {
    await rm(preexistingRoot, { recursive: true, force: true });
  }
});

test("docker inventory fails closed and rejects same-project resources without the ownership label", async () => {
  const config = { project: "spaceapp-dev-test" };
  const owner = { token: "b".repeat(48) };
  const failingRunner = async () => ({ code: 1, stdout: "", stderr: "daemon unavailable" });
  await assert.rejects(() => dockerResources(config, owner, failingRunner), /Docker inventory failed/);

  const collisionRunner = async (_command, args) => {
    const owned = args.some((arg) => String(arg).includes("com.spaceapp.dev-stack.owner="));
    const kind = args[0] === "ps" ? "container" : args[0] === "volume" ? "volume" : "network";
    return { code: 0, stdout: owned ? "" : `${kind}-1`, stderr: "" };
  };
  await assert.rejects(() => dockerResources(config, owner, collisionRunner), /not proven to belong/);

  const cleanRunner = async (_command, args) => {
    const kind = args[0] === "ps" ? "container" : args[0] === "volume" ? "volume" : "network";
    return { code: 0, stdout: `${kind}-1`, stderr: "" };
  };
  assert.deepEqual(await dockerResources(config, owner, cleanRunner), {
    containers: ["container-1"],
    volumes: ["volume-1"],
    networks: ["network-1"]
  });
});

test("supervisor identity rejects PID reuse and atomically claims a checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-supervisor-test-"));
  const config = {
    rootHash: "0123456789",
    pidFile: join(root, "supervisor.pid")
  };
  const ownedIdentity = async () => ({ startedAt: "Sun Oct 18 07:40:00 2026", args: "node deploy/docker/dev-stack.mjs" });
  try {
    const record = await claimSupervisor(config, ownedIdentity);
    assert.equal(record.pid, process.pid);
    assert.equal(JSON.parse(await readFile(config.pidFile, "utf8")).rootHash, config.rootHash);
    assert.equal(supervisorRecordMatches(config, record, await ownedIdentity()), true);
    await assert.rejects(() => claimSupervisor(config, ownedIdentity), /already running/);

    const reusedIdentity = async () => ({ startedAt: "Sun Oct 18 07:41:00 2026", args: "node unrelated-tool.mjs" });
    await assert.rejects(() => ownedSupervisorPid(config, { identityProvider: reusedIdentity }), /Refusing to signal PID/);

    await releaseSupervisor(config, process.pid);
    await writeFile(config.pidFile, `${process.pid}\n`, { mode: 0o600 });
    await assert.rejects(() => claimSupervisor(config, ownedIdentity), /stale or unverified/);
  } finally {
    await releaseSupervisor(config, process.pid).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("persisted process-group ownership cleans descendants after the leader exits", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-process-owner-"));
  const config = {
    rootHash: "abcdef0123",
    processFile: join(root, "process-groups.json")
  };
  const owner = ownership(config.rootHash);
  const childPidFile = join(root, "child.pid");
  const childScript = "setInterval(() => {}, 1000)";
  const leaderScript = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore", env: process.env });
    fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
    setTimeout(() => process.exit(0), 50);
  `;
  const leader = spawn(process.execPath, ["-e", leaderScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, SPACE_DEV_PROCESS_TOKEN: owner.token }
  });
  leader.unref();
  const record = { name: "orphan-probe", pid: leader.pid, pgid: leader.pid, sid: leader.pid };
  try {
    await writeProcessRecords(config, owner, [record]);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (existsSync(childPidFile)) {
        const leaderStatus = await run("ps", ["-p", String(leader.pid), "-o", "stat="], { capture: true, allowFailure: true });
        if (leaderStatus.code !== 0 || leaderStatus.stdout.startsWith("Z")) break;
      }
      await sleep(50);
    }
    assert.equal(existsSync(childPidFile), true);
    const childPid = Number(await readFile(childPidFile, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 1);

    await terminateOwnedProcessGroups(config, owner, { timeoutMs: 1500 });
    const groupStatus = await run("ps", ["-axo", "pid=,pgid=,stat="], { capture: true });
    assert.equal(groupStatus.code, 0);
    const liveMembers = groupStatus.stdout.split(/\r?\n/).filter((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)/);
      return match && Number(match[2]) === record.pgid && !match[3].startsWith("Z");
    });
    assert.deepEqual(liveMembers, []);
    assert.equal(existsSync(config.processFile), false);
  } finally {
    try { process.kill(-leader.pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("registered renamed children clean sanitized descendants without relaxing persisted recovery", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-sanitized-descendant-"));
  const config = { rootHash: "abcdef0123", processFile: join(root, "process-groups.json") };
  const owner = ownership(config.rootHash);
  const readyFile = join(root, "descendant.json");
  const descendantScript = `
    process.on("SIGTERM", () => {});
    require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ pid: process.pid, token: process.env.SPACE_DEV_PROCESS_TOKEN }));
    setInterval(() => {}, 1000);
  `;
  const leader = spawnOwnedProcess(owner, process.execPath, ["-e", `
    process.title = "npm exec tsx watch";
    require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore", env: {} });
    setInterval(() => {}, 1000);
  `], { stdio: "ignore" });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const record = { name: "sanitized-probe", pid: leader.pid, pgid: leader.pid, sid: leader.pid };
  const runner = (command, args, options) => args[0] === "eww" && Number(args[args.indexOf("-p") + 1]) === leader.pid
    ? Promise.resolve({ code: 0, stdout: "npm exec tsx watch", stderr: "" })
    : run(command, args, options);
  try {
    await writeProcessRecords(config, owner, [record]);
    const deadline = Date.now() + 3000;
    while (!existsSync(readyFile) && Date.now() < deadline) await sleep(20);
    const descendant = JSON.parse(await readFile(readyFile, "utf8"));
    assert.equal(descendant.token, undefined);
    assert.equal(leader.exitCode, null);

    await assert.rejects(() => terminateOwnedProcessGroups(config, owner, { runner }), /does not carry this dev-stack ownership token/);
    await assert.rejects(() => terminateOwnedProcessGroups(config, owner, { liveChildren: [leader], runner }), /does not carry this dev-stack ownership token/);
    await assert.rejects(() => terminateOwnedProcessGroups(config, owner, { records: [record], runner }), /does not carry this dev-stack ownership token/);
    assert.equal(existsSync(config.processFile), true);

    await terminateOwnedProcessGroups(config, owner, { records: [record], liveChildren: [leader], runner, timeoutMs: 100 });
    const status = await run("ps", ["-p", String(descendant.pid), "-o", "stat="], { capture: true, allowFailure: true });
    assert.ok(status.code !== 0 || status.stdout.startsWith("Z"));
    assert.notEqual(leader.signalCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "an unrelated process must remain alive");
  } finally {
    try { process.kill(-leader.pid, "SIGKILL"); } catch {}
    try { process.kill(-unrelated.pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  }
});

test("spawn registration rejects spoofed handles, other tokens, reused identities, and exit races", { skip: process.platform === "win32" }, async (t) => {
  const config = { rootHash: "abcdef0123" };
  const owner = ownership(config.rootHash);
  const startedAt = "Sun Oct 18 07:40:00 2026";
  for (const scenario of ["spoofed handle", "other token", "reused identity", "exit during snapshot"]) await t.test(scenario, async () => {
    const leader = spawnOwnedProcess(owner, process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const record = { name: "registered-probe", pid: leader.pid, pgid: leader.pid, sid: leader.pid };
    const signals = [];
    let inventories = 0;
    try {
      const runner = async (_command, args) => {
        if (args[0] !== "-axo") return { code: 0, stdout: "npm", stderr: "" };
        inventories += 1;
        if (scenario === "exit during snapshot" && inventories === 1) {
          const exited = new Promise(resolvePromise => leader.once("exit", resolvePromise));
          leader.kill("SIGTERM");
          await exited;
        }
        const identity = scenario === "reused identity" && inventories > 1 ? "Sun Oct 18 07:41:00 2026" : startedAt;
        return { code: 0, stdout: `${leader.pid} ${leader.pid} S ${identity}\n`, stderr: "" };
      };
      const child = scenario === "spoofed handle" ? { pid: leader.pid, exitCode: null, signalCode: null } : leader;
      const candidateOwner = scenario === "other token" ? { ...owner, token: "b".repeat(48) } : owner;
      await assert.rejects(() => terminateOwnedProcessGroups(config, candidateOwner, {
        records: [record], liveChildren: [child], runner, timeoutMs: 0,
        signaler: (...args) => signals.push(args)
      }), /does not carry this dev-stack ownership token/);
      assert.deepEqual(signals, []);
    } finally {
      try { process.kill(-leader.pid, "SIGKILL"); } catch {}
    }
  });
});

test("live group snapshots fail closed on stale leaders and changed process identities", { skip: process.platform === "win32" }, async (t) => {
  const config = { rootHash: "abcdef0123" };
  const owner = ownership(config.rootHash);
  const record = { name: "identity-probe", pid: 4100, pgid: 4100, sid: 4100 };
  const startedAt = "Sun Oct 18 07:40:00 2026";

  for (const scenario of ["exited leader", "different child", "leader exits during snapshot", "missing leader", "wrong leader token", "reused descendant", "new unverified descendant", "missing start identity"]) {
    await t.test(scenario, async () => {
      const child = { pid: scenario === "different child" ? 4200 : record.pid, exitCode: scenario === "exited leader" ? 0 : null, signalCode: null };
      const signals = [];
      let terminated = false;
      const runner = async (_command, args) => {
        if (args[0] === "-axo") {
          const leader = scenario === "missing leader" || terminated ? "" : `4100 4100 S ${startedAt}\n`;
          const childStart = terminated && scenario === "reused descendant" ? "Sun Oct 18 07:41:00 2026" : startedAt;
          const descendant = `4101 4100 S${scenario === "missing start identity" ? "" : ` ${childStart}`}\n`;
          const newcomer = terminated && scenario === "new unverified descendant" ? `4102 4100 S ${startedAt}\n` : "";
          return { code: 0, stdout: leader + descendant + newcomer, stderr: "" };
        }
        const pid = Number(args[args.indexOf("-p") + 1]);
        if (pid === record.pid) {
          if (scenario === "leader exits during snapshot") child.signalCode = "SIGTERM";
          return { code: 0, stdout: scenario === "wrong leader token" ? "node unrelated" : `node SPACE_DEV_PROCESS_TOKEN=${owner.token}`, stderr: "" };
        }
        return { code: 0, stdout: "node sanitized-child", stderr: "" };
      };
      await assert.rejects(() => terminateOwnedProcessGroups(config, owner, {
        records: [record], liveChildren: [child], runner, timeoutMs: 0,
        signaler: (pid, signal) => { signals.push([pid, signal]); terminated = true; child.signalCode = signal; }
      }), /does not carry this dev-stack ownership token|Could not establish start identity/);
      const expected = ["reused descendant", "new unverified descendant"].includes(scenario) ? [[-record.pgid, "SIGTERM"]] : [];
      assert.deepEqual(signals, expected);
    });
  }
});

test("process-group cleanup does not depend on Darwin sess values", async (t) => {
  for (const sess of ["0", "ffffffff8100abcd"]) {
    await t.test(`sess=${sess}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "spaceapp-darwin-group-"));
      const config = { rootHash: "abcdef0123", processFile: join(root, "process-groups.json") };
      const owner = ownership(config.rootHash);
      const record = { name: "darwin-probe", pid: 4100, pgid: 4100, sid: 4100 };
      const signals = [];
      let stopped = false;
      try {
        await writeProcessRecords(config, owner, [record]);
        const runner = async (_command, args) => {
          if (args[0] !== "-axo") return { code: 0, stdout: `node SPACE_DEV_PROCESS_TOKEN=${owner.token}`, stderr: "" };
          const fields = args[1].split(",").map((field) => field.replace(/=$/, ""));
          const rows = stopped ? [] : [4100, 4101].map((pid) => ({ pid, pgid: 4100, sess, stat: "S", lstart: "Sun Oct 18 07:40:00 2026" }));
          return { code: 0, stdout: rows.map((row) => fields.map((field) => row[field]).join(" ")).join("\n"), stderr: "" };
        };
        await terminateOwnedProcessGroups(config, owner, {
          runner, timeoutMs: 0,
          signaler: (pid, signal) => { signals.push([pid, signal]); stopped = true; }
        });
        assert.deepEqual(signals, process.platform === "win32" ? [[4100, "SIGTERM"], [4101, "SIGTERM"]] : [[-4100, "SIGTERM"]]);
        assert.equal(existsSync(config.processFile), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("malformed process inventory preserves recovery records without signalling", async (t) => {
  for (const stdout of ["unparseable process", "4100 4100 0 S Sun Oct 18 07:40:00 2026", "4100 4100 broken-sess S Sun Oct 18 07:40:00 2026", "4100 4100 S"]) {
    await t.test(stdout, async () => {
      const root = await mkdtemp(join(tmpdir(), "spaceapp-malformed-group-"));
      const config = { rootHash: "abcdef0123", processFile: join(root, "process-groups.json") };
      const owner = ownership(config.rootHash);
      const record = { name: "malformed-probe", pid: 4100, pgid: 4100, sid: 4100 };
      const signals = [];
      try {
        await writeProcessRecords(config, owner, [record]);
        await assert.rejects(() => terminateOwnedProcessGroups(config, owner, {
          runner: async () => ({ code: 0, stdout, stderr: "" }),
          signaler: (...args) => signals.push(args)
        }), /Could not parse local process inventory|Could not establish start identity/);
        assert.deepEqual(signals, []);
        assert.equal(existsSync(config.processFile), true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("macOS source stack repairs node-pty spawn-helper execute permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-pty-helper-"));
  const helper = join(root, "node_modules", "node-pty", "prebuilds", "darwin-x64", "spawn-helper");
  try {
    await mkdir(join(root, "node_modules", "node-pty", "prebuilds", "darwin-x64"), { recursive: true });
    await writeFile(helper, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    await chmod(helper, 0o644);

    const repaired = await ensureDarwinNodePtySpawnHelpers(root, "darwin");
    assert.deepEqual(repaired, [helper]);
    assert.equal((await stat(helper)).mode & 0o111, 0o111);
    assert.deepEqual(await ensureDarwinNodePtySpawnHelpers(root, "darwin"), []);

    await chmod(helper, 0o644);
    assert.deepEqual(await ensureDarwinNodePtySpawnHelpers(root, "linux"), []);
    assert.equal((await stat(helper)).mode & 0o111, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
