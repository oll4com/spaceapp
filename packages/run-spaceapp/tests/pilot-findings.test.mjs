import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";

// Findings of the 2026-10-16 pilot rehearsal: workspace changes reach the running services (F1), Linux shows how
// the CLIs get write access (F3), backups carry the workspace list and CLI settings (F8), purge runs unattended (F9).

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
async function installation(execute) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-pilot-findings-"));
  const stdout = capture();
  const stderr = capture();
  const options = {
    env: { SPACEAPP_HOME: root }, platform: "linux", stdin: ttyStdin("y"), stdout: stdout.stream, stderr: stderr.stream,
    inspectResources: async () => ({ cpuCount: 4, totalMemoryBytes: 8 * 1024 ** 3, freeDiskBytes: 15 * 1024 ** 3 }),
    prepareDockerPath: async () => null, request: async () => ({ ok: true, json: async () => ({ ok: true }) }), sleep: async () => {},
    execute
  };
  await run(["init"], options);
  return { root, stdout, stderr, options };
}

test("workspace add and remove apply the mounts to the running core and CLI services, and Linux names the ACL", async () => {
  const calls = [];
  const { stdout, options } = await installation(async (spec) => { calls.push(spec.args); return 0; });
  const folder = await mkdtemp(join(tmpdir(), "spaceapp-pilot-repo-"));
  await chmod(folder, 0o755);
  assert.equal(await run(["workspace", "add", folder], options), 0);
  assert.deepEqual(calls.at(-1).slice(-4), ["up", "-d", "spaceapp-core", "spaceapp-cli"]);
  assert.match(stdout.value(), /uid 10001 and cannot write/);
  assert.match(stdout.value(), new RegExp(`setfacl -R -m u:10001:rwX .*${folder}`));
  assert.equal(await run(["workspace", "remove", folder], options), 0);
  assert.deepEqual(calls.at(-1).slice(-4), ["up", "-d", "spaceapp-core", "spaceapp-cli"]);

  const before = stdout.value().length;
  await chmod(folder, 0o777);
  assert.equal(await run(["workspace", "add", folder, "--read-only"], options), 0);
  assert.doesNotMatch(stdout.value().slice(before), /setfacl/);
});

test("a workspace change that the services cannot pick up says to run up", async () => {
  const { stderr, options } = await installation(async (spec) => (spec.args?.includes("spaceapp-core") && spec.args.includes("up") ? 1 : 0));
  const folder = await mkdtemp(join(tmpdir(), "spaceapp-pilot-repo-"));
  assert.equal(await run(["workspace", "add", folder], options), 1);
  assert.match(stderr.value(), /run-spaceapp@latest up/);
});

test("a backup carries the workspace list and the CLI settings, and restore brings the settings back", async () => {
  const imported = [];
  let root;
  const execute = async (spec, io) => {
    if (spec.args?.includes("scripts/portable-backup.mjs")) {
      await mkdir(join(root, "backups", "spaceapp-backup-20261016T070000000Z"), { recursive: true });
      await writeFile(join(root, "backups", "spaceapp-backup-20261016T070000000Z", "manifest.json"), "{}");
    }
    if (spec.args?.includes("tar") && spec.args.includes("-xzf")) imported.push(io.input);
    if (spec.args?.some((arg) => String(arg).includes("tar -czf -"))) io.stdout.write("cli-settings-archive");
    return 0;
  };
  const fixture = await installation(execute);
  root = fixture.root;
  const folder = await mkdtemp(join(tmpdir(), "spaceapp-pilot-repo-"));
  await run(["workspace", "add", folder], fixture.options);
  assert.equal(await run(["backup"], fixture.options), 0);
  const directory = join(root, "backups", "spaceapp-backup-20261016T070000000Z");
  assert.equal(await readFile(join(directory, "cli-config.tar.gz"), "utf8"), "cli-settings-archive");
  assert.equal((await stat(join(directory, "cli-config.tar.gz"))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "spaceapp-config.json"), "utf8")).workspaces.map((w) => w.hostPath), [folder]);

  await run(["workspace", "remove", folder], fixture.options);
  assert.equal(await run(["restore"], { ...fixture.options, stdin: Readable.from(["RESTORE\n"]) }), 0);
  assert.equal(String(imported[0]), "cli-settings-archive");
  assert.ok(fixture.stdout.value().includes(`workspace add "${folder}"`));
  assert.match(fixture.stdout.value(), /never in backups/);
});

test("a backup without CLI settings is still a backup", async () => {
  let root;
  const fixture = await installation(async (spec) => {
    if (spec.args?.includes("scripts/portable-backup.mjs")) await mkdir(join(root, "backups", "spaceapp-backup-20261016T080000000Z"), { recursive: true });
    return spec.args?.some((arg) => String(arg).includes("tar -czf -")) ? 2 : 0;
  });
  root = fixture.root;
  assert.equal(await run(["backup"], fixture.options), 0);
  await assert.rejects(stat(join(root, "backups", "spaceapp-backup-20261016T080000000Z", "cli-config.tar.gz")));
  assert.match(fixture.stderr.value(), /no CLI settings/);
});

test("uninstall --purge-data runs unattended with purgeConfirm", async () => {
  const calls = [];
  const { options } = await installation(async (spec) => { calls.push(spec.args); return 0; });
  const answers = JSON.stringify({ purgeConfirm: "DELETE" });
  assert.equal(await run(["uninstall", "--purge-data", "--non-interactive", "--answers", answers], { ...options, stdin: Readable.from([]) }), 0);
  assert.ok(calls.some((args) => args.includes("down") && args.includes("--volumes")));
});
