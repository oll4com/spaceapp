import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { addUser, createDefaultConfig, loadConfig, renderCliHosts, renderWorkspaceCompose, userSlug, validateConfig } from "../src/index.mjs";

// Multi-user (plan clipboard:evAaFYqrgDfd step 5): each user's CLIs run in their own container with their own keys,
// logins, memory and workspaces; the core reads the user -> pane host socket map from SPACE_CLI_HOST_SOCKETS_FILE.

function capture() {
  let value = "";
  return { stream: new Writable({ write(chunk, _e, done) { value += chunk.toString(); done(); } }), value: () => value };
}
function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {},
    [Symbol.asyncIterator]() { return { async next() { return index >= answers.length ? { done: true } : { done: false, value: `${answers[index++]}\r` }; } }; }
  };
}
async function installation(execute, platform = "linux") {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-multi-user-"));
  const stdout = capture();
  const stderr = capture();
  const options = {
    env: { SPACEAPP_HOME: root }, platform, stdin: ttyStdin("y"), stdout: stdout.stream, stderr: stderr.stream,
    inspectResources: async () => ({ cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 15 * 1024 ** 3 }),
    prepareDockerPath: async () => null, request: async () => ({ ok: true, json: async () => ({ ok: true }) }), sleep: async () => {},
    execute
  };
  await run(["init"], options);
  return { root, stdout, stderr, options };
}

test("user enable, add and remove give each user a CLI container and the core its host map", async () => {
  const calls = [];
  const { root, stdout, options } = await installation(async (spec) => { calls.push(spec.args); return 0; });
  await assert.rejects(run(["user", "add", "user:Bob12345"], options), /accounts are off/);
  assert.equal(await run(["user", "enable"], options), 0);
  let compose = await readFile(join(root, "compose.workspaces.yml"), "utf8");
  assert.match(compose, /SPACE_MULTI_USER_ENABLED: "true"/);
  assert.match(compose, /SPACE_CLI_HOST_SOCKETS_FILE: \/etc\/spaceapp\/cli-hosts\.json/);
  assert.equal(await readFile(join(root, "cli-hosts.json"), "utf8"), "{}\n");

  assert.equal(await run(["user", "add", "user:Bob12345", "--memory", "1536m"], options), 0);
  const slug = userSlug("user:Bob12345");
  // "user add" brings the services up, then waits until the user's own CLI host answers on its socket.
  assert.deepEqual(calls.at(-2).slice(-3), ["up", "-d", "--remove-orphans"]);
  assert.ok(calls.at(-1).includes(`spaceapp-cli-${slug}`) && calls.at(-1).some((arg) => String(arg).includes("/run/spaceapp-cli/host.sock")));
  assert.match(stdout.value(), /The CLI container of user:Bob12345 is ready/);
  compose = await readFile(join(root, "compose.workspaces.yml"), "utf8");
  assert.match(compose, new RegExp(`spaceapp-cli-${slug}:`));
  // A user's CLI container runs the same pinned image as the owner's (1.1.7 review: a moved tag cannot change it).
  assert.match(compose, new RegExp(`  spaceapp-cli-${slug}:\\n    image: ghcr\\.io/oll4com/spaceapp-cli:\\$\\{SPACEAPP_IMAGE_TAG\\}\\$\\{SPACEAPP_CLI_IMAGE_DIGEST:-\\}\\n`));
  assert.match(compose, /mem_limit: "1536m"/);
  for (const volume of ["cli-state", "memory", "cli-socket", "workspaces"]) assert.match(compose, new RegExp(`spaceapp-${volume}-${slug}:`));
  assert.match(compose, new RegExp(`\\./secrets/users/${slug}/providers:/run/spaceapp-secrets/providers:ro`));
  // The user's container never mounts the owner's keys, CLI state, memory or workspaces.
  const service = compose.slice(compose.indexOf(`spaceapp-cli-${slug}:`), compose.indexOf("\nvolumes:"));
  assert.doesNotMatch(service, /- spaceapp-cli-state:|- spaceapp-memory:|- spaceapp-workspaces:|\.\/secrets\/providers:/);
  // Nor joins the internal network of the owner's services (security review 2026-10-17).
  assert.doesNotMatch(service, /^      - spaceapp$/m);
  assert.match(service, new RegExp(`networks:\\n      - spaceapp-user-${slug}`));
  // The user-namespace profile follows the host (F17); its rendering is checked in compose-images.test.mjs.
  assert.match(renderWorkspaceCompose(await loadConfig(root), { cliSandbox: true }), new RegExp(`  spaceapp-cli-${slug}:[^]*?no-new-privileges:true\\n      - seccomp=\\./seccomp-cli\\.json\\n      - apparmor=unconfined`));
  assert.match(compose, new RegExp(`\\nnetworks:\\n  spaceapp-user-${slug}: \\{\\}`));
  assert.deepEqual(JSON.parse(await readFile(join(root, "cli-hosts.json"), "utf8")), { "user:Bob12345": `/run/spaceapp-cli-users/${slug}/host.sock` });
  // Windows has no POSIX modes (it reports 0o666).
  if (process.platform !== "win32") assert.equal((await stat(join(root, "secrets", "users", slug, "providers"))).mode & 0o777, 0o700);
  assert.match(stdout.value(), /credentials set <provider> --user user:Bob12345/);

  assert.equal(await run(["user", "remove", "user:Bob12345"], options), 0);
  assert.doesNotMatch(await readFile(join(root, "compose.workspaces.yml"), "utf8"), new RegExp(`spaceapp-cli-${slug}`));
  assert.equal(await readFile(join(root, "cli-hosts.json"), "utf8"), "{}\n");
});

test("credentials and workspaces with --user reach only that user's container", async () => {
  const calls = [];
  const { root, options } = await installation(async (spec) => { calls.push(spec.args); return 0; });
  await assert.rejects(run(["credentials", "set", "claude", "--user", "user:Bob12345"], { ...options, stdin: Readable.from(["sk-test\n"]) }), /no CLI container/);
  await run(["user", "enable"], options);
  await run(["user", "add", "user:Bob12345"], options);
  const slug = userSlug("user:Bob12345");
  assert.equal(await run(["credentials", "set", "claude", "--user", "user:Bob12345"], { ...options, stdin: Readable.from(["sk-bob\n"]) }), 0);
  assert.equal(await readFile(join(root, "secrets", "users", slug, "providers", "claude.key"), "utf8"), "sk-bob");
  await assert.rejects(readFile(join(root, "secrets", "providers", "claude.key")));
  assert.deepEqual(calls.at(-1).slice(-5), ["up", "-d", "--no-deps", "--force-recreate", `spaceapp-cli-${slug}`]);

  const folder = await mkdtemp(join(tmpdir(), "spaceapp-multi-user-repo-"));
  assert.equal(await run(["workspace", "add", folder, "--read-only", "--user", "user:Bob12345"], options), 0);
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.deepEqual(config.workspaces, []);
  assert.equal(config.users[0].workspaces[0].hostPath, folder);
  const compose = await readFile(join(root, "compose.workspaces.yml"), "utf8");
  const userService = compose.slice(compose.indexOf(`spaceapp-cli-${slug}:`));
  assert.ok(userService.includes(JSON.stringify(folder)));
  assert.ok(!compose.slice(0, compose.indexOf(`spaceapp-cli-${slug}:`)).includes(JSON.stringify(folder)));
  assert.equal(await run(["workspace", "remove", folder, "--user", "user:Bob12345"], options), 0);
});

test("users need isolated access, and user ids are validated", () => {
  const config = { ...createDefaultConfig({ version: "1.1.7", profile: "small" }), users: [] };
  assert.throws(() => addUser({ ...config, accessMode: "host-root" }, "user:Bob12345"), /isolated access/);
  assert.throws(() => validateConfig({ ...addUser(config, "user:Bob12345"), accessMode: "host-root" }), /isolated access/);
  for (const bad of ["bob", "user:", "user:../x", "user:a b"]) assert.throws(() => addUser(config, bad), /Invalid/);
  assert.notEqual(userSlug("user:Bob12345"), userSlug("user:bob12345"));
  const off = createDefaultConfig({ version: "1.1.7", profile: "small" });
  assert.doesNotMatch(renderWorkspaceCompose(off), /SPACE_MULTI_USER_ENABLED|cli-hosts/);
  assert.equal(renderCliHosts(off), "{}\n");
});

test("a restore names the users and their workspaces to add again", async () => {
  let root;
  const execute = async (spec) => {
    if (spec.args?.includes("scripts/portable-backup.mjs")) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(root, "backups", "spaceapp-backup-20261017T070000000Z"), { recursive: true });
      await writeFile(join(root, "backups", "spaceapp-backup-20261017T070000000Z", "manifest.json"), "{}");
    }
    return 0;
  };
  const fixture = await installation(execute);
  root = fixture.root;
  await run(["user", "enable"], fixture.options);
  await run(["user", "add", "user:Bob12345", "--memory", "2g"], fixture.options);
  const folder = await mkdtemp(join(tmpdir(), "spaceapp-multi-user-repo-"));
  await run(["workspace", "add", folder, "--user", "user:Bob12345"], fixture.options);
  assert.equal(await run(["backup"], fixture.options), 0);
  // A fresh installation without accounts restores this backup.
  const { writeFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  delete config.users;
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  assert.equal(await run(["restore"], { ...fixture.options, stdin: Readable.from(["RESTORE\n"]) }), 0);
  const out = fixture.stdout.value();
  assert.match(out, /SpaceApp accounts were on: .* user enable/);
  assert.match(out, /User of the backup to add again: .* user add user:Bob12345 --memory 2g/);
  assert.ok(out.includes(`workspace add "${folder}" --user user:Bob12345`));
});

test("a backup keeps each user's CLI settings and Space Memory, never their keys, and puts them back (MU-004)", async () => {
  let root;
  const imported = [];
  const execute = async (spec, io = {}) => {
    const service = spec.args?.[spec.args.indexOf("10001:10001") + 1];
    if (spec.args?.includes("scripts/portable-backup.mjs")) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(root, "backups", "spaceapp-backup-20261017T080000000Z"), { recursive: true });
      await writeFile(join(root, "backups", "spaceapp-backup-20261017T080000000Z", "manifest.json"), "{}");
    }
    // Exports write an archive named after the container and what it holds; imports record what they got.
    if (spec.args?.includes("-czf") || spec.args?.some((arg) => String(arg).includes("tar -czf"))) {
      io.stdout.write(`${service}:${spec.args.includes("/var/lib/spaceapp/memory") ? "memory" : "settings"}`);
    }
    if (spec.args?.includes("-xzf")) imported.push(`${service} <- ${io.input}`);
    return 0;
  };
  const fixture = await installation(execute);
  root = fixture.root;
  await run(["user", "enable"], fixture.options);
  await run(["user", "add", "user:Bob12345"], fixture.options);
  const slug = userSlug("user:Bob12345");
  assert.equal(await run(["backup"], fixture.options), 0);
  const directory = join(root, "backups", "spaceapp-backup-20261017T080000000Z");
  assert.equal(await readFile(join(directory, "users", `${slug}-cli-config.tar.gz`), "utf8"), `spaceapp-cli-${slug}:settings`);
  assert.equal(await readFile(join(directory, "users", `${slug}-memory.tar.gz`), "utf8"), `spaceapp-cli-${slug}:memory`);
  if (process.platform !== "win32") assert.equal((await stat(join(directory, "users", `${slug}-memory.tar.gz`))).mode & 0o777, 0o600);
  assert.match(fixture.stdout.value(), /CLI settings and Space Memory of 1 of 1 user\(s\)/);
  // The user is still there: a restore puts their state straight back into their own container.
  assert.equal(await run(["restore"], { ...fixture.options, stdin: Readable.from(["RESTORE\n"]) }), 0);
  assert.deepEqual(imported.filter((line) => line.startsWith(`spaceapp-cli-${slug}`)),
    [`spaceapp-cli-${slug} <- spaceapp-cli-${slug}:settings`, `spaceapp-cli-${slug} <- spaceapp-cli-${slug}:memory`]);
  // On a fresh install the user is added again first, then "user restore" brings their state back.
  imported.length = 0;
  await run(["user", "remove", "user:Bob12345"], fixture.options);
  assert.equal(await run(["restore"], { ...fixture.options, stdin: Readable.from(["RESTORE\n"]) }), 0);
  assert.match(fixture.stdout.value(), /Then their CLI settings and Space Memory: .* user restore user:Bob12345/);
  assert.deepEqual(imported.filter((line) => line.startsWith(`spaceapp-cli-${slug}`)), []);
  await run(["user", "add", "user:Bob12345"], fixture.options);
  // A restore first saves a backup of the install it replaces: "user restore" skips that newer backup without the user.
  const { mkdir: mkdirp, writeFile: write } = await import("node:fs/promises");
  await mkdirp(join(root, "backups", "spaceapp-backup-20261017T090000000Z"), { recursive: true });
  await write(join(root, "backups", "spaceapp-backup-20261017T090000000Z", "manifest.json"), "{}");
  assert.equal(await run(["user", "restore", "user:Bob12345"], fixture.options), 0);
  assert.equal(imported.filter((line) => line.startsWith(`spaceapp-cli-${slug}`)).length, 2);
  await assert.rejects(run(["user", "restore", "user:Nobody99"], fixture.options));
});

test("user add reports a user's CLI container that never answers, and provider install --user targets that container", async () => {
  const calls = [];
  const { stdout, stderr, options } = await installation(async (spec) => {
    calls.push(spec.args);
    return spec.args?.some((arg) => String(arg).includes("host.sock")) ? 1 : 0;
  });
  await run(["user", "enable"], options);
  assert.equal(await run(["user", "add", "user:Bob12345"], options), 1);
  const slug = userSlug("user:Bob12345");
  assert.equal(calls.filter((args) => args.some((arg) => String(arg).includes("host.sock"))).length, 30);
  assert.match(stderr.value(), new RegExp(`does not answer yet[^]*spaceapp-cli-${slug}`));

  calls.length = 0;
  assert.equal(await run(["provider", "install", "claude", "--user", "user:Bob12345"], options), 0);
  assert.ok(calls[0].includes(`spaceapp-cli-${slug}`) && calls[0].includes("@anthropic-ai/claude-code@2.1.301"));
  assert.equal(calls[0].includes("spaceapp-cli"), false);
  assert.equal(await run(["provider", "install", "gemini", "--user", "user:Bob12345"], options), 0);
  assert.ok(calls[1].includes(`spaceapp-cli-${slug}`) && calls[1].includes("gemini"));
  assert.match(stdout.value(), /private provider volume of user:Bob12345/);
  await assert.rejects(run(["provider", "install", "claude", "--user", "user:Nobody99"], options));
});
