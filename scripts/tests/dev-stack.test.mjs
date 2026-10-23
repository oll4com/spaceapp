import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDevProcessEnv,
  extractPinnedDevImages,
  extractPinnedOpenCodeSpec,
  prepareDevStackState,
  renderDevStackCompose,
  resolveDevStackConfig,
  superviseProcesses
} from "../dev-stack.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("extracts digest-pinned postgres and temporal images directly from templates/compose.yml and opencode-ai from Dockerfile", async () => {
  const composeYaml = await readFile(join(REPO_ROOT, "packages/run-spaceapp/templates/compose.yml"), "utf8");
  const dockerfile = await readFile(join(REPO_ROOT, "Dockerfile"), "utf8");

  const images = extractPinnedDevImages(composeYaml);
  assert.match(images.postgresImage, /^pgvector\/pgvector:[^@]+@sha256:[a-f0-9]{64}$/);
  assert.match(images.temporalImage, /^temporalio\/auto-setup:[^@]+@sha256:[a-f0-9]{64}$/);

  const opencodeSpec = extractPinnedOpenCodeSpec(dockerfile);
  assert.match(opencodeSpec, /^(?:@opencode\/cli|opencode-ai)@\d+\.\d+\.\d+/);
});

test("resolveDevStackConfig isolates ports from 4910/4911 and binds strictly to 127.0.0.1", () => {
  const cfg = resolveDevStackConfig({}, REPO_ROOT);
  assert.equal(cfg.bindHost, "127.0.0.1");
  assert.notEqual(cfg.apiPort, 4910);
  assert.notEqual(cfg.webPort, 4911);
  assert.equal(cfg.apiPort, 14910);
  assert.equal(cfg.webPort, 14911);
  assert.match(cfg.composeProjectName, /^spaceapp-dev-[a-f0-9]{10}$/);
});

test("prepareDevStackState creates 0600 secrets, loopback-only compose file, and non-dev-login env", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "spaceapp-dev-stack-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const cfg = resolveDevStackConfig({ SPACE_DEV_STACK_DIR: tempRoot }, REPO_ROOT);
  const state = await prepareDevStackState(cfg);

  for (const secretName of ["postgres-password", "database-url", "session-secret", "setup-token"]) {
    const info = await stat(join(tempRoot, "secrets", secretName));
    assert.equal(info.mode & 0o777, 0o600);
  }

  const composeText = await readFile(state.composeFile, "utf8");
  assert.match(composeText, /127\.0\.0\.1:15432:5432/);
  assert.match(composeText, /127\.0\.0\.1:17233:7233/);
  assert.doesNotMatch(composeText, /0\.0\.0\.0/);

  const env = buildDevProcessEnv(cfg, state, { PATH: "/usr/bin" });
  assert.equal(env.SPACE_DEV_LOGIN, "false");
  assert.equal(env.SPACE_API_HOST, "127.0.0.1");
  assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
  assert.equal(env.SPACE_API_ORIGIN, "http://127.0.0.1:14910");
  assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
});

test("superviseProcesses reports clear failure and terminates remaining processes when one exits unexpectedly", async () => {
  let errOutput = "";
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      errOutput += chunk.toString();
      cb();
    }
  });
  const killed = [];
  const children = [];

  const spawnFn = (command, args) => {
    const emitter = new EventEmitter();
    emitter.kill = (sig) => {
      killed.push(sig);
      setImmediate(() => emitter.emit("exit", 0, sig));
    };
    children.push(emitter);
    return emitter;
  };

  const promise = superviseProcesses(
    [
      { name: "api", command: "node", args: ["api.js"] },
      { name: "worker", command: "node", args: ["worker.js"] }
    ],
    { spawnFn, stderr }
  );

  // Simulate worker crashing with code 1
  setImmediate(() => children[1].emit("exit", 1, null));
  const exitCode = await promise;

  assert.equal(exitCode, 1);
  assert.match(errOutput, /process "worker" exited unexpectedly/);
  assert.ok(killed.length >= 1);
});
