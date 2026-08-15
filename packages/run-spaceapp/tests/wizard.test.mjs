import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { run, readSecret } from "../src/cli.mjs";
import {
  applyConfigRepairs,
  initializeInstallation,
  loadConfig,
  planConfigRepairs,
  SPACEAPP_UPGRADE_POLICY,
  upgradePath
} from "../src/index.mjs";

const launcherManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8")
);
const CURRENT_VERSION = launcherManifest.version;
const RUNTIME_VERSION = launcherManifest.spaceappRuntimeVersion;

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

function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) {
            return { done: true };
          }
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
}

const eightGigabyteClassLinuxGuest = Object.freeze({
  cpuCount: 4,
  totalMemoryBytes: 8_325_902_336,
  freeDiskBytes: 15 * 1024 ** 3
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function real015Schema3Config(root, overrides = {}) {
  await writeFile(join(root, "config.json"), `${JSON.stringify({
    schemaVersion: 3,
    version: "0.1.15",
    previousVersion: "0.1.14",
    bindHost: "127.0.0.1",
    port: 4911,
    telemetry: false,
    profile: "light",
    accessMode: "isolated",
    workspaces: [],
    ...overrides
  }, null, 2)}\n`);
}

test("schema 3 configs from real 0.1.15 installs migrate to schema 4 with companionsEnabled defaulting to false", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-migration-schema3-"));
  await real015Schema3Config(root);

  const config = await loadConfig(root);
  assert.equal(config.schemaVersion, 4);
  assert.equal(config.companionsEnabled, false);
  assert.equal(config.version, "0.1.15");
  assert.equal(config.accessMode, "isolated");
  assert.equal(config.profile, "light");
  assert.deepEqual(config.workspaces, []);
});

test("planConfigRepairs reports the exact repair for schema 3 companionsEnabled states", async () => {
  const missing = { schemaVersion: 3, version: "0.1.15", previousVersion: null, bindHost: "127.0.0.1", port: 4911, telemetry: false, profile: "light", accessMode: "isolated", workspaces: [] };
  assert.deepEqual(
    planConfigRepairs(missing).actions.map((action) => action.type),
    ["default-companions"]
  );

  const stringTrue = { ...missing, companionsEnabled: "true" };
  const convert = planConfigRepairs(stringTrue);
  assert.equal(convert.actions[0].type, "convert-companions-string");
  assert.equal(convert.actions[0].value, "true");
  const repaired = applyConfigRepairs(stringTrue);
  assert.equal(repaired.companionsEnabled, true);
  assert.equal(repaired.schemaVersion, 4);

  const stringFalse = { ...missing, companionsEnabled: "false" };
  assert.equal(applyConfigRepairs(stringFalse).companionsEnabled, false);

  const corrupt = { ...missing, companionsEnabled: 42 };
  assert.equal(planConfigRepairs(corrupt).actions[0].type, "reject-companions");
  assert.throws(() => applyConfigRepairs(corrupt), /cannot be repaired automatically/i);
});

test("schema 3 string companionsEnabled fails closed on plain load and is repaired only through the approved path", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-migration-string-"));
  await real015Schema3Config(root, { companionsEnabled: "true" });

  await assert.rejects(() => loadConfig(root), /companionsEnabled must be boolean/);
  const raw = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  const repaired = applyConfigRepairs(raw);
  assert.equal(repaired.companionsEnabled, true);
});

test("upgradePath classifies fresh, same, update, downgrade, unsupported, and unknown versions", () => {
  assert.equal(upgradePath(null, "0.1.25"), "fresh");
  assert.equal(upgradePath("0.1.25", "0.1.25"), "same");
  assert.equal(upgradePath("0.1.15", "0.1.25"), "update");
  assert.equal(upgradePath("0.1.25", "0.1.6"), "downgrade");
  assert.equal(upgradePath("0.1.9", "0.1.25"), "unsupported");
  assert.equal(upgradePath("not-a-version", "0.1.25"), "unknown");
  assert.equal(
    SPACEAPP_UPGRADE_POLICY.minSupportedSourceVersion,
    "0.1.10"
  );
});

test("fresh install cancelled at final confirmation creates no installation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-wizard-cancel-"));
  const stdout = capture();
  const stderr = capture();
  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("", "", "", "", "", "n"),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    execute: async () => 0
  }), 0);
  assert.match(stdout.value(), /Cancelled\. No changes were made/);
  await assert.rejects(() => readFile(join(root, "config.json"), "utf8"));
});

test("install and update refuse changes without a TTY unless an approved Windows continuation exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-wizard-no-tty-"));
  const stderr = capture();
  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    execute: async () => 0
  }), 1);
  assert.match(stderr.value(), /interactive terminal \(TTY\)/i);
  await assert.rejects(() => readFile(join(root, "config.json"), "utf8"));

  await initializeInstallation(root, { version: "0.1.14", profile: "light" });
  const updateStderr = capture();
  assert.equal(await run(["update"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: updateStderr.stream,
    stdin: Readable.from([]),
    prepareDockerPath: async () => null,
    execute: async () => 0
  }), 1);
  assert.match(updateStderr.value(), /interactive terminal \(TTY\)/i);
});

test("an approved Windows RunOnce continuation runs the install unattended and is consumed once", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-wizard-runonce-"));
  const username = process.env.USER || userInfo().username;
  const createdAt = Date.now();
  await mkdir(join(root, "var"), { recursive: true });
  await writeFile(join(root, "var", "runonce-continuation.json"), `${JSON.stringify({
    user: username,
    installRoot: root,
    targetVersion: RUNTIME_VERSION,
    nonce: "n".repeat(40),
    createdAt,
    expiresAt: createdAt + 24 * 60 * 60 * 1_000,
    actions: { profile: "auto", accessMode: "isolated", companionsEnabled: false, telemetry: false, noOpen: true }
  }, null, 2)}\n`, { mode: 0o600 });

  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "win32",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    request: async (url) => url.endsWith("/readyz")
      ? jsonResponse({ ok: true })
      : jsonResponse({ setupRequired: false, expiresAt: null }),
    sleep: async () => {},
    execute: async () => 0
  }), 0);

  assert.equal(
    (JSON.parse(await readFile(join(root, "config.json"), "utf8"))).version,
    RUNTIME_VERSION
  );
  await assert.rejects(() => readFile(join(root, "var", "runonce-continuation.json"), "utf8"));
});

test("an expired or foreign RunOnce continuation is discarded and the TTY gate applies", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-wizard-runonce-expired-"));
  const username = process.env.USER || userInfo().username;
  const createdAt = Date.now() - 48 * 60 * 60 * 1_000;
  await mkdir(join(root, "var"), { recursive: true });
  await writeFile(join(root, "var", "runonce-continuation.json"), `${JSON.stringify({
    user: username,
    installRoot: root,
    targetVersion: RUNTIME_VERSION,
    nonce: "n".repeat(40),
    createdAt,
    expiresAt: createdAt + 24 * 60 * 60 * 1_000,
    actions: [{ profile: "auto" }]
  }, null, 2)}\n`, { mode: 0o600 });

  const stderr = capture();
  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "win32",
    stdout: capture().stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    execute: async () => 0
  }), 1);
  assert.match(stderr.value(), /interactive terminal \(TTY\)/i);
  await assert.rejects(() => readFile(join(root, "var", "runonce-continuation.json"), "utf8"));
});

test("same-version install offers doctor, repair, and cancel without changing state on cancel", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-wizard-same-"));
  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "light" });
  const before = await readFile(join(root, "config.json"), "utf8");
  const stdout = capture();
  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: ttyStdin("3"),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    prepareDockerPath: async () => null,
    execute: async () => 0
  }), 0);
  assert.match(stdout.value(), /already installed/i);
  assert.match(stdout.value(), /Cancelled\. No changes were made/);
  assert.equal(await readFile(join(root, "config.json"), "utf8"), before);
});

test("a downgrade update requires the typed DOWNGRADE confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-wizard-downgrade-"));
  await initializeInstallation(root, { version: RUNTIME_VERSION, profile: "light" });
  const before = await readFile(join(root, "config.json"), "utf8");
  const stdout = capture();
  const stderr = capture();
  assert.equal(await run(["update", "0.1.6"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("CANCEL"),
    prepareDockerPath: async () => null,
    execute: async () => 0
  }), 0);
  assert.match(stderr.value(), /OLDER than the installed/i);
  assert.match(stdout.value(), /Cancelled\. No changes were made/);
  assert.equal(await readFile(join(root, "config.json"), "utf8"), before);
});

test("update creates a verified checkpoint before cutover and restores it when the runtime start fails", async () => {
  const failingRoot = await mkdtemp(join(tmpdir(), "spaceapp-checkpoint-failure-"));
  await initializeInstallation(failingRoot, { version: "0.1.14", profile: "light" });
  const before = await readFile(join(failingRoot, "config.json"), "utf8");
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  assert.equal(await run(["update"], {
    env: { SPACEAPP_HOME: failingRoot },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("y"),
    prepareDockerPath: async () => null,
    execute: async (spec) => {
      calls.push(spec.args.at(-1));
      if (spec.args.includes("--remove-orphans")) return 42;
      return 0;
    }
  }), 1);
  assert.match(stderr.value(), /Runtime start failed with Docker exit 42/);
  assert.match(stdout.value(), /Restoring checkpoint/i);
  assert.equal(await readFile(join(failingRoot, "config.json"), "utf8"), before);
  const checkpoints = (await readdir(join(failingRoot, "checkpoints"))).filter((name) => name.includes("spaceapp-checkpoint-"));
  assert.equal(checkpoints.length, 1);
  await assert.rejects(() => readFile(join(failingRoot, "checkpoints", checkpoints[0], "verified.json"), "utf8"));
});

test("readSecret does not destroy a real TTY stream between sequential wizard prompts", async () => {
  // Regression for the VM acceptance finding: the old for-await early return
  // called the Readable async iterator's return(), which destroyed the stream
  // and aborted every wizard after the second prompt ("The operation was
  // aborted"). The stream must stay intact for the next prompt.
  const stdout = capture();
  const stream = new Readable({
    read() {
      const answer = queue.shift();
      if (answer === undefined) {
        stream.push(null);
      } else {
        stream.push(`${answer}\n`);
      }
    }
  });
  const queue = ["yes", "no", ""];
  stream.isTTY = true;
  stream.setRawMode = () => {};

  const first = await readSecret(stream, stdout.stream, "Q1? ", { mask: false });
  assert.equal(first, "yes");
  assert.equal(stream.destroyed, false);

  const second = await readSecret(stream, stdout.stream, "Q2? ", { mask: false });
  assert.equal(second, "no");
  assert.equal(stream.destroyed, false);

  const third = await readSecret(stream, stdout.stream, "Q3? ", { mask: false });
  assert.equal(third, "");
  assert.equal(stream.destroyed, false);
});

test("a successful update marks the checkpoint verified and prunes older checkpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-checkpoint-success-"));
  await initializeInstallation(root, { version: "0.1.14", profile: "light" });
  assert.equal(await run(["update"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: ttyStdin("y"),
    prepareDockerPath: async () => null,
    execute: async () => 0
  }), 0);
  assert.equal(
    (JSON.parse(await readFile(join(root, "config.json"), "utf8"))).version,
    RUNTIME_VERSION
  );
  const checkpoints = (await readdir(join(root, "checkpoints"))).filter((name) => name.includes("spaceapp-checkpoint-"));
  assert.equal(checkpoints.length, 1);
  const verified = JSON.parse(await readFile(join(root, "checkpoints", checkpoints[0], "verified.json"), "utf8"));
  assert.match(verified.verifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  const manifest = JSON.parse(await readFile(join(root, "checkpoints", checkpoints[0], "manifest.json"), "utf8"));
  assert.ok(manifest.files.some((file) => file.path === "postgres.dump"));
  assert.ok(manifest.files.some((file) => file.path === "config.json"));
  assert.ok(manifest.files.some((file) => file.path.startsWith("secrets/")));
});

test("readSecret on non-TTY stdin stops at the first newline and keeps the stream alive", async () => {
  // Regression for the Windows acceptance finding: on Windows the launcher
  // often sees a non-TTY stdin (npx.cmd pipes it). The old non-TTY branch
  // drained the stream to EOF, so an interactive "y" + Enter looked frozen
  // and a second keystroke produced "y\ny" -> "Please answer y or n." loops.
  const stdout = capture();
  const queue = ["yes\r\n", "no\n", ""];
  const stream = new Readable({
    read() {
      const answer = queue.shift();
      if (answer === undefined) {
        stream.push(null);
      } else {
        stream.push(answer);
      }
    }
  });
  // Non-TTY stream: no isTTY flag.

  const first = await readSecret(stream, stdout.stream, "Q1? ", { mask: false });
  assert.equal(first, "yes");
  assert.equal(stream.destroyed, false);

  const second = await readSecret(stream, stdout.stream, "Q2? ", { mask: false });
  assert.equal(second, "no");
  assert.equal(stream.destroyed, false);

  const third = await readSecret(stream, stdout.stream, "Q3? ", { mask: false });
  assert.equal(third, "");
});

test("readSecret on non-TTY stdin returns piped input without a trailing newline", async () => {
  // Fully piped input without a newline (e.g. PowerShell: "y" | npx ...).
  const stdout = capture();
  const stream = new Readable({
    read() {
      stream.push("y");
      stream.push(null);
    }
  });
  const answer = await readSecret(stream, stdout.stream, "Q? ", { mask: false });
  assert.equal(answer, "y");
});
