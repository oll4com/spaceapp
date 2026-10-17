import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { devCompose, devEnvironment, devStackConfig, pinnedDevImages, pinnedOpenCode } from "../dev-stack-config.mjs";
import { devProcessIdentity, devSupervisorIsAlive } from "../dev-stack-process.mjs";

const config = devStackConfig("/tmp/spaceapp-contributor");
test("dev-stack ports are distinct, loopback-only and separate from installed ports", () => {
  const compose = devCompose(config, { postgres: "fixture-pg", temporal: "fixture-temporal" });
  assert.deepEqual(Object.keys(compose.services), ["postgres", "temporal"]);
  assert.deepEqual(compose.services.postgres.ports, ["127.0.0.1:55432:5432"]);
  assert.deepEqual(compose.services.temporal.ports, ["127.0.0.1:57233:7233"]);
  assert.equal(compose.services.postgres.environment.POSTGRES_PASSWORD_FILE, "/run/secrets/postgres-password");
  assert.deepEqual(compose.services.temporal.env_file, [config.state + "/secrets/temporal.env"]);
  assert.equal(compose.services.temporal.secrets, undefined);
  assert.equal(compose.services.temporal.entrypoint, undefined);
  assert.ok(!JSON.stringify(compose).includes("POSTGRES_PASSWORD\""));
  for (const value of ["4910", "4911", "80", "65536", "0.0.0.0:5000", "1e4", "5000; echo wrong"]) {
    assert.throws(() => devStackConfig(config.root, { SPACE_DEV_API_PORT: value }));
  }
  assert.throws(() => devStackConfig(config.root, { SPACE_DEV_API_PORT: "54911" }), /distinct/);
});

test("state identity is stable per checkout and refuses destructive path choices", () => {
  assert.deepEqual(devStackConfig(config.root), config);
  assert.notEqual(devStackConfig("/tmp/another-checkout").project, config.project);
  assert.notEqual(devStackConfig(config.root, { SPACE_DEV_STACK_DIR: ".dev-stack-second" }).project, config.project);
  for (const state of ["/", "/tmp", ".", "..", "node_modules", "apps", "../.dev-stack"]) {
    assert.throws(() => devStackConfig(config.root, { SPACE_DEV_STACK_DIR: state }));
  }
  assert.throws(() => devStackConfig("/tmp/" + "a".repeat(120)), /Unix sockets/);
});

test("image and provider versions come from the distribution's current sources", async () => {
  const template = await readFile(new URL("../../packages/run-spaceapp/templates/compose.yml", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  const images = pinnedDevImages(template);
  assert.match(images.postgres, /^pgvector\/pgvector:.+@sha256:[0-9a-f]{64}$/);
  assert.match(images.temporal, /^temporalio\/auto-setup:.+@sha256:[0-9a-f]{64}$/);
  assert.match(pinnedOpenCode(dockerfile), /^\d+\.\d+\.\d+$/);
  assert.throws(() => pinnedDevImages(template.replace(/@sha256:[0-9a-f]{64}/g, "")), /pin/);
  assert.throws(() => pinnedOpenCode("opencode-ai@latest"));
  assert.throws(() => pinnedOpenCode("opencode-ai@1.2.3 opencode-ai@1.2.4"));
});

test("child processes cannot inherit installed services or provider credentials", () => {
  const inherited = { PATH: "/usr/bin:/bin", USER: "developer", HOME: "/private/user", OPENAI_API_KEY: "do-not-inherit", NODE_OPTIONS: "--require private-preload", SPACE_DATABASE_URL: "postgres://installed", SPACE_TEMPORAL_ADDRESS: "installed:7233", SPACE_INSTANCE_ENABLED_JOBS: "telegram-bridge", SPACE_DEV_LOGIN: "true" };
  const env = devEnvironment(config, { database: "synthetic-password", session: "synthetic-session" }, inherited);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.SPACE_DEV_LOGIN, "false");
  assert.equal(env.SPACE_INSTANCE, "dev");
  assert.equal(env.SPACE_DEV_SESSION_COOKIE_NAMESPACE, config.id);
  assert.notEqual(devEnvironment(devStackConfig("/tmp/second-checkout"), { database: "fixture", session: "fixture" }).SPACE_DEV_SESSION_COOKIE_NAMESPACE, env.SPACE_DEV_SESSION_COOKIE_NAMESPACE);
  assert.equal(env.SPACE_INSTANCE_ENABLED_JOBS, "");
  assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
  assert.equal(env.SPACE_API_HOST, "127.0.0.1");
  assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
  assert.ok(env.HOME.startsWith(config.state + "/"));
  assert.ok(!Object.values(env).some(value => value.includes("installed") || value.includes("do-not-inherit")));
});

test("stale supervisor records do not confuse a reused live PID with the owned process", async () => {
  const identity = await devProcessIdentity(process.pid);
  assert.ok(identity);
  assert.equal(await devSupervisorIsAlive({ pid: process.pid, identity }), true);
  assert.equal(await devSupervisorIsAlive({ pid: process.pid, identity: "a previous process start" }), false);
  assert.equal(await devSupervisorIsAlive({ pid: -1, identity }), false);
  assert.equal(await devSupervisorIsAlive({ pid: process.pid }), true);
  await assert.rejects(devSupervisorIsAlive({ pid: process.pid, identity }, async () => { throw new Error("process identity unavailable"); }), /unavailable/);
});

for (const existingRecord of [false, true]) test(`failed startup ${existingRecord ? "preserves an existing" : "removes its own"} supervisor record`, { skip: process.platform === "win32" }, async () => {
  const root = await realpath(await mkdtemp("/tmp/spaceapp-dev-startup-"));
  const fixture = devStackConfig(root);
  const run = promisify(execFile);
  try {
    for (const path of ["scripts/dev-stack.mjs", "scripts/dev-stack-config.mjs", "scripts/dev-stack-process.mjs", "Dockerfile", "packages/run-spaceapp/templates/compose.yml"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await copyFile(new URL(`../../${path}`, import.meta.url), join(root, path));
    }
    await mkdir(join(fixture.state, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(join(fixture.state, "config.json"), JSON.stringify(fixture), { mode: 0o600 });
    for (const name of ["postgres-password", "session-secret", "setup-token", "control-token"]) {
      await writeFile(join(fixture.state, "secrets", name), randomBytes(32).toString("hex"), { mode: 0o600 });
    }
    // A directory at the socket path fails before Docker or any service starts.
    // It must not be recursively removed as part of startup cleanup.
    const socketPath = join(fixture.state, "control.sock"), runningFile = join(fixture.state, "running.json");
    await mkdir(socketPath);
    const previous = JSON.stringify({ pid: process.pid, identity: await devProcessIdentity(process.pid), project: fixture.project });
    if (existingRecord) await writeFile(runningFile, previous, { mode: 0o600 });
    await assert.rejects(run(process.execPath, [join(root, "scripts/dev-stack.mjs"), "up"], {
      env: { PATH: process.env.PATH }, timeout: 10_000, maxBuffer: 16_384
    }), error => error.code === 1 && (existingRecord ? /has a supervisor record/.test(error.stderr) : /directory|EISDIR/.test(error.stderr)));
    if (existingRecord) assert.equal(await readFile(runningFile, "utf8"), previous);
    else await assert.rejects(lstat(runningFile), { code: "ENOENT" });
    assert.ok((await lstat(socketPath)).isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); }
});
