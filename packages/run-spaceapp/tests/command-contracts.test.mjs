import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run } from "../src/cli.mjs";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

async function installation({ platform = "linux", execute = async () => 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-command-contract-"));
  const stdout = capture();
  const stderr = capture();
  const options = {
    env: { SPACEAPP_HOME: root },
    platform,
    stdin: Readable.from([]),
    stdout: stdout.stream,
    stderr: stderr.stream,
    prepareDockerPath: async () => null,
    execute
  };
  await run(["init"], options);
  return { root, stdout, stderr, options };
}

test("help and version aliases expose the complete stable command surface", async () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const stdout = capture();
    assert.equal(await run(args, {
      env: {},
      platform: "linux",
      stdout: stdout.stream,
      stderr: capture().stream,
      prepareDockerPath: async () => null
    }), 0);
    for (const command of [
      "init",
      "install",
      "up | down | status | logs",
      "open",
      "doctor",
      "update [version] | rollback",
      "backup | restore",
      "workspace add",
      "workspace remove",
      "workspace list",
      "credentials set",
      "credentials remove",
      "credentials list",
      "provider install claude",
      "owner reset-password",
      "owner rotate-setup-token",
      "uninstall [--purge-data]"
    ]) {
      assert.match(stdout.value(), new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  }

  for (const alias of ["--version", "-v"]) {
    const stdout = capture();
    assert.equal(await run([alias], {
      env: {},
      platform: "linux",
      stdout: stdout.stream,
      stderr: capture().stream,
      prepareDockerPath: async () => null
    }), 0);
    assert.match(stdout.value(), /^\d+\.\d+\.\d+\n$/);
  }
});

test("up, down, status, logs, backup, and open delegate to their fixed native contracts", async () => {
  const calls = [];
  const { options } = await installation({
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  });

  for (const command of ["up", "down", "status", "logs", "backup"]) {
    assert.equal(await run([command], options), 0);
  }
  assert.deepEqual(calls.map((spec) => spec.args.slice(-3)), [
    ["up", "-d", "--remove-orphans"],
    ["--profile", "standard", "down"],
    ["--profile", "standard", "ps"],
    ["logs", "--tail", "200"],
    ["spaceapp-core", "node", "scripts/portable-backup.mjs"]
  ]);

  for (const [platform, expectedCommand] of [
    ["linux", "xdg-open"],
    ["darwin", "open"],
    ["win32", "explorer.exe"]
  ]) {
    const opened = [];
    const fixture = await installation({
      platform,
      execute: async (spec) => {
        opened.push(spec);
        return 0;
      }
    });
    assert.equal(await run(["open"], fixture.options), 0);
    assert.deepEqual(opened, [{
      command: expectedCommand,
      args: ["http://127.0.0.1:4911"]
    }]);
  }
});

test("open succeeds with an exact manual URL when the native opener is unavailable", async () => {
  const fixture = await installation({
    platform: "linux",
    execute: async (spec) => spec.command === "xdg-open" ? 127 : 0
  });

  assert.equal(await run(["open"], fixture.options), 0);
  assert.match(
    fixture.stderr.value(),
    /Could not open SpaceApp automatically\. Open http:\/\/127\.0\.0\.1:4911 manually\./
  );
});

test("workspace and credential list contracts persist only the requested local state", async () => {
  const { root, options } = await installation();
  const workspace = await mkdtemp(join(tmpdir(), "spaceapp-command-workspace-"));
  const output = capture();

  assert.equal(await run(["workspace", "add", workspace, "--read-only"], {
    ...options,
    stdout: output.stream
  }), 0);
  const added = JSON.parse(await readFile(join(root, "config.json"), "utf8")).workspaces;
  assert.equal(added.length, 1);
  assert.equal(added[0].hostPath, workspace);
  assert.equal(added[0].readOnly, true);

  assert.equal(await run(["workspace", "list"], {
    ...options,
    stdout: output.stream
  }), 0);
  assert.match(output.value(), new RegExp(added[0].id));

  assert.equal(await run(["workspace", "remove", workspace], options), 0);
  assert.deepEqual(JSON.parse(await readFile(join(root, "config.json"), "utf8")).workspaces, []);

  const credentials = capture();
  assert.equal(await run(["credentials", "list"], {
    ...options,
    stdout: credentials.stream
  }), 0);
  for (const provider of ["codex", "gemini", "opencode", "qwen", "kimi", "grok", "claude", "deepseek"]) {
    assert.match(credentials.value(), new RegExp(`"${provider}"`));
  }
});

test("update and rollback persist version state only after both Docker operations succeed", async () => {
  const calls = [];
  const { root, stdout, options } = await installation({
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  });

  assert.equal(await run(["update", "0.1.6"], options), 0);
  assert.deepEqual(
    (({ version, previousVersion }) => ({ version, previousVersion }))(
      JSON.parse(await readFile(join(root, "config.json"), "utf8"))
    ),
    { version: "0.1.6", previousVersion: "0.1.10" }
  );
  assert.equal(await run(["rollback"], options), 0);
  assert.deepEqual(
    (({ version, previousVersion }) => ({ version, previousVersion }))(
      JSON.parse(await readFile(join(root, "config.json"), "utf8"))
    ),
    { version: "0.1.10", previousVersion: "0.1.6" }
  );
  assert.deepEqual(calls.map((spec) => spec.args.at(-1)), [
    "pull",
    "--remove-orphans",
    "pull",
    "--remove-orphans"
  ]);
  assert.match(stdout.value(), /Updated to SpaceApp 0\.1\.6/);
  assert.match(stdout.value(), /Rolled back to SpaceApp 0\.1\.10/);
});

test("doctor is read-only for installation configuration and generated runtime files", async () => {
  const { root, options } = await installation();
  const paths = ["config.json", "runtime.env", "compose.yml", "compose.workspaces.yml"];
  const before = new Map(await Promise.all(paths.map(async (path) => {
    const target = join(root, path);
    return [path, {
      content: await readFile(target, "utf8"),
      inode: (await stat(target)).ino
    }];
  })));

  assert.equal(await run(["doctor"], {
    ...options,
    inspectResources: async () => ({
      cpuCount: 4,
      totalMemoryBytes: 8_325_902_336,
      freeDiskBytes: 15 * 1024 ** 3
    })
  }), 0);

  for (const path of paths) {
    const target = join(root, path);
    assert.equal(await readFile(target, "utf8"), before.get(path).content);
    assert.equal((await stat(target)).ino, before.get(path).inode);
  }
});

test("invalid and cancelled command paths fail closed with actionable usage", async () => {
  const { options } = await installation();
  const invalid = [
    [["unknown"], /Unknown command/],
    [["up", "extra"], /Usage: spaceapp up/],
    [["workspace"], /workspace <add\|remove\|list>/],
    [["workspace", "add"], /workspace add/],
    [["credentials"], /credentials <set\|remove\|list>/],
    [["credentials", "set", "gemini", "argv-secret"], /read from stdin/],
    [["provider", "install", "gemini"], /provider install claude/],
    [["owner", "unknown"], /owner <reset-password\|rotate-setup-token>/],
    [["update", "0.1.6", "extra"], /Usage: spaceapp update/],
    [["uninstall", "--unknown"], /Usage: spaceapp uninstall/]
  ];
  for (const [args, pattern] of invalid) {
    await assert.rejects(() => run(args, options), pattern);
  }

  const rollbackFixture = await installation();
  await assert.rejects(
    () => run(["rollback"], rollbackFixture.options),
    /No previous SpaceApp version/
  );
  await assert.rejects(
    () => run(["restore"], {
      ...options,
      stdin: Readable.from(["CANCEL\n"])
    }),
    /Restore cancelled/
  );
  await assert.rejects(
    () => run(["uninstall", "--purge-data"], {
      ...options,
      stdin: Readable.from(["CANCEL\n"])
    }),
    /Purge cancelled/
  );
});
