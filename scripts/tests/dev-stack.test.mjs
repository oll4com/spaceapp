import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createState, readState, removeState, portsFromEnv, secretNames } from "../dev-stack/state.mjs";
import { applicationEnv, imagePins, openCodePin } from "../dev-stack/config.mjs";
import { preparePtyHelper } from "../dev-stack/pty.mjs";
import { Processes } from "../dev-stack/processes.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));

test("pins are derived from the current published sources and missing pins fail closed", async () => {
  const template = await readFile(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
  const pins = imagePins(template);
  for (const pin of Object.values(pins)) assert.match(pin, /@sha256:[a-f0-9]{64}$/);
  assert.throws(() => imagePins(template.replaceAll("@sha256:", "@missing:")), /Missing pinned/);
  const docker = await readFile(join(root, "Dockerfile"), "utf8");
  assert.match(openCodePin(docker), /^(@opencode\/cli|opencode-ai)@\d+\.\d+\.\d+$/);
  assert.throws(() => openCodePin("opencode-ai@1.0.0 opencode-ai@2.0.0"), /one pinned/);
});
test("configuration refuses collisions and installed-instance ports", () => {
  assert.equal(portsFromEnv({}).api, 14910);
  for (const value of ["4910", "4911", "0", "65536", "abc", "1.5"]) assert.throws(() => portsFromEnv({ SPACE_DEV_API_PORT: value }));
  assert.throws(() => portsFromEnv({ SPACE_DEV_API_PORT: "14911" }), /distinct/);
});
test("state persists private unique secrets and ignores operator credentials/config", async () => {
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "stack-test-")));
  let state;
  try {
    state = await createState(checkout, {});
    const again = await createState(checkout, {});
    assert.equal(again.id, state.id);
    assert.equal(new Set(await Promise.all(secretNames.map((name) => readFile(join(state.dir, "secrets", name), "utf8")))).size, 4);
    for (const name of secretNames) assert.equal((await stat(join(state.dir, "secrets", name))).mode & 0o777, 0o600);
    const env = await applicationEnv(state, { PATH: "/usr/bin:/bin", OPENAI_API_KEY: "operator-key", SPACE_DATABASE_URL: "postgres://operator/stable", SPACE_DEV_LOGIN: "true", NODE_OPTIONS: "--require unsafe" });
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.SPACE_DEV_LOGIN, "false"); assert.equal(env.SPACE_API_HOST, "127.0.0.1");
    assert.match(env.SPACE_DATABASE_URL, /\/spaceapp_dev$/); assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
    assert.ok(env.TMPDIR.startsWith(state.sockets)); assert.ok(env.TMPDIR.length < 80);
    assert.ok(env.HOME.startsWith(state.dir)); assert.ok(env.SPACE_CLI_HOST_SOCKET.startsWith(state.sockets));
    await assert.rejects(createState(checkout, { SPACE_DEV_API_PORT: "19000" }), /Port configuration changed/);
    await removeState(state); state = null;
    assert.equal(await readState(checkout), null);
  } finally { if (state) await removeState(state); await rm(checkout, { recursive: true, force: true }); }
});
test("reset refuses foreign ownership and symlinked state without touching target", async () => {
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "stack-owner-")));
  const target = await realpath(await mkdtemp(join(tmpdir(), "stack-foreign-")));
  try {
    await writeFile(join(target, "keep"), "untouched");
    await symlink(target, join(checkout, ".dev-stack"));
    await assert.rejects(createState(checkout, {}), /linked/);
    assert.equal(await readFile(join(target, "keep"), "utf8"), "untouched");
    await rm(join(checkout, ".dev-stack"));
    const state = await createState(checkout, {});
    await writeFile(join(state.sockets, "owner"), "foreign");
    await assert.rejects(removeState(state), /ownership/);
    await writeFile(join(state.sockets, "owner"), state.id); await removeState(state);
  } finally { await rm(checkout, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});
test("unexpected required-process exit reports failure; requested stop does not", async () => {
  const failures = [];
  const children = new Processes(["private-secret"], (error) => failures.push(error.message));
  assert.equal(children.redact("a private-secret b"), "a [redacted] b");
  const failed = children.start("worker", process.execPath, ["-e", "process.exit(7)"], {}, true);
  await assert.rejects(failed.done, /worker exited/);
  assert.equal(failures.length, 1);
  const live = children.start("host", process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, true);
  await children.stop(); assert.equal(failures.length, 1); assert.ok(live.signalCode);
});

test("macOS PTY preparation restores only the owned helper execute bit", async () => {
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "stack-pty-")));
  try {
    const directory = join(checkout, "node_modules/node-pty/prebuilds/darwin-arm64");
    await mkdir(directory, { recursive: true });
    const helper = join(directory, "spawn-helper");
    await writeFile(helper, "fixture", { mode: 0o600 });
    await preparePtyHelper(checkout, "darwin", "arm64");
    assert.equal((await stat(helper)).mode & 0o777, 0o700);
    await rm(helper); await symlink(process.execPath, helper);
    await assert.rejects(preparePtyHelper(checkout, "darwin", "arm64"), /Refusing/);
  } finally { await rm(checkout, { recursive: true, force: true }); }
});
