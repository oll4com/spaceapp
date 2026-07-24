import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { executeCommand, run } from "../src/cli.mjs";

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

const eightGigabyteClassLinuxGuest = Object.freeze({
  cpuCount: 4,
  totalMemoryBytes: 8_325_902_336,
  freeDiskBytes: 15 * 1024 ** 3
});

test("the process launcher rejects executables outside the fixed command allowlist", async () => {
  await assert.rejects(
    executeCommand({
      command: "/tmp/untrusted-spaceapp-executable",
      args: []
    }),
    /SpaceApp refused to execute an untrusted command/
  );
  await assert.rejects(
    executeCommand({
      command: "docker",
      args: ["info", 123]
    }),
    /SpaceApp command arguments must be strings/
  );
  await assert.rejects(
    executeCommand({
      command: "docker",
      args: ["info"],
      env: { PATH: "/tmp/untrusted" }
    }),
    /SpaceApp refused untrusted command environment values/
  );
  await assert.rejects(
    executeCommand({
      command: "powershell.exe",
      operation: "run-arbitrary-script"
    }),
    /SpaceApp refused an untrusted PowerShell operation/
  );
});

test("the process launcher dispatches only hard-coded executable literals", async () => {
  const source = await readFile(new URL("../src/cli.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /spawn\(\s*spec\.command/u);
  assert.doesNotMatch(source, /spawn\("powershell\.exe", args/u);
  assert.doesNotMatch(source, /command: "cmd"/u);
  assert.match(
    source,
    /spawn\("powershell\.exe", windowsPowerShellArgs\(spec\.operation\), options\)/u
  );
  for (const command of [
    "codesign",
    "docker",
    "explorer.exe",
    "hdiutil",
    "open",
    "sg",
    "spctl",
    "sudo",
    "wsl.exe",
    "xdg-open"
  ]) {
    assert.match(source, new RegExp(`spawn\\("${command.replace(".", "\\.")}", args, options\\)`));
  }
});

test("init emits a one-time setup token without placing it in config", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-init-"));
  const stdout = capture();
  const stderr = capture();

  assert.equal(await run(["init"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    execute: async () => 0
  }), 0);

  assert.match(stdout.value(), /One-time setup token: [A-Za-z0-9_-]{40,}/);
  assert.equal(stderr.value(), "");
  assert.doesNotMatch(
    await readFile(join(root, "config.json"), "utf8"),
    /password|secret|token|api.?key/i
  );

  const second = capture();
  await run(["init"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: second.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    execute: async () => 0
  });
  assert.doesNotMatch(second.value(), /One-time setup token:/);
});

test("install accepts the usable memory reported by an 8 GB-class Linux guest", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-light-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  };

  assert.equal(await run(["install", "--profile", "auto", "--no-open"], options), 0);
  assert.equal((JSON.parse(await readFile(join(root, "config.json"), "utf8"))).profile, "light");
  assert.match(stdout.value(), /Selected profile: light.*7\.7 GB/i);
  assert.match(stdout.value(), /SpaceApp is running at http:\/\/127\.0\.0\.1:4911/);
  assert.deepEqual(calls.map((call) => [call.command, ...call.args.slice(-2)]), [
    ["docker", "docker", "--version"].slice(1),
    ["docker", "compose", "version"],
    ["docker", "info"],
    ["docker", join(root, "compose.workspaces.yml"), "pull"],
    ["docker", "-d", "--remove-orphans"]
  ]);
  assert.doesNotMatch(calls.map((call) => `${call.command} ${call.args.join(" ")}`).join("\n"), /xdg-open/);
  assert.equal(calls.find((call) => call.args.includes("pull")).args.includes("--profile"), false);

  const second = capture();
  assert.equal(await run(["install", "--profile", "auto", "--no-open"], {
    ...options,
    stdout: second.stream
  }), 0);
  assert.doesNotMatch(second.value(), /One-time setup token:/);
  assert.equal((JSON.parse(await readFile(join(root, "config.json"), "utf8"))).profile, "light");
});

test("install honors an explicit standard profile and uses the native browser opener", async () => {
  for (const [platform, opener] of [
    ["linux", ["xdg-open", "http://127.0.0.1:4911"]],
    ["darwin", ["open", "http://127.0.0.1:4911"]],
    ["win32", ["explorer.exe", "http://127.0.0.1:4911"]]
  ]) {
    const root = await mkdtemp(join(tmpdir(), `spaceapp-cli-install-${platform}-`));
    const calls = [];
    const options = {
      env: { SPACEAPP_HOME: root },
      platform,
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: Readable.from([]),
      inspectResources: async () => eightGigabyteClassLinuxGuest,
      execute: async (spec) => {
        calls.push([spec.command, ...spec.args]);
        return 0;
      }
    };

    assert.equal(await run(["install", "--profile", "standard"], options), 0);
    assert.equal((JSON.parse(await readFile(join(root, "config.json"), "utf8"))).profile, "standard");
    const pullCall = calls.find((call) => call.includes("pull"));
    const profileIndex = pullCall.indexOf("--profile");
    assert.equal(pullCall[profileIndex + 1], "standard");
    assert.deepEqual(calls.at(-1), opener);
  }
});

test("install succeeds when the native browser opener is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-headless-"));
  const stdout = capture();
  const stderr = capture();

  assert.equal(await run(["install"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    execute: async (spec) => spec.command === "xdg-open" ? 127 : 0
  }), 0);

  assert.match(stdout.value(), /SpaceApp is running at http:\/\/127\.0\.0\.1:4911/);
  assert.match(
    stderr.value(),
    /Could not open SpaceApp automatically\. Open http:\/\/127\.0\.0\.1:4911 manually\./
  );
});

test("install bootstraps missing Docker before running doctor and pulling images", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-bootstrap-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  let ensureCalls = 0;

  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "win32",
    arch: "x64",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => {
      ensureCalls += 1;
      return { code: 0, reexecuted: false };
    },
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  }), 0);

  assert.equal(ensureCalls, 1);
  assert.ok(calls.some((spec) => spec.command === "docker" && spec.args.includes("pull")));
  assert.match(stdout.value(), /SpaceApp is running at http:\/\/127\.0\.0\.1:4911/);
  assert.equal(stderr.value(), "");
});

test("install stops before image pulls when the host is below the 8 GB minimum", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-small-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];

  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => ({
      cpuCount: 4,
      totalMemoryBytes: 7 * 1024 ** 3,
      freeDiskBytes: 20 * 1024 ** 3
    }),
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  }), 1);

  assert.match(stderr.value(), /FAIL Memory: 7 GB available; 8 GB required/i);
  assert.equal(calls.some((call) => call.args.includes("pull")), false);
  assert.equal(calls.some((call) => call.args.includes("up")), false);
});

test("credentials reject argv values and accept only stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-credential-"));
  const stdout = capture();
  const stderr = capture();
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async () => 0
  };
  await run(["init"], { ...options, stdin: Readable.from([]) });

  await assert.rejects(
    () => run(["credentials", "set", "gemini", "must-not-be-an-argument"], {
      ...options,
      stdin: Readable.from([])
    }),
    /read from stdin/i
  );
  assert.equal(await run(["credentials", "set", "gemini"], {
    ...options,
    stdin: Readable.from(["provider-value\n"])
  }), 0);
  assert.equal(
    await readFile(join(root, "secrets", "providers", "gemini.key"), "utf8"),
    "provider-value"
  );
});

test("credential changes recreate only the isolated CLI service", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-credential-sync-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec.args);
      return 0;
    }
  };
  await run(["init"], { ...options, stdin: Readable.from([]) });

  assert.equal(await run(["credentials", "set", "gemini"], {
    ...options,
    stdin: Readable.from(["provider-value\n"])
  }), 0);
  assert.equal(await run(["credentials", "remove", "gemini"], {
    ...options,
    stdin: Readable.from([])
  }), 0);

  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.deepEqual(args.slice(-5), [
      "up", "-d", "--no-deps", "--force-recreate", "spaceapp-cli"
    ]);
  }
});

test("Claude installation is explicit, owner-initiated, and fixed to the reviewed package", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-provider-install-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    execute: async (spec) => {
      calls.push(spec.args);
      return 0;
    }
  };
  await run(["init"], options);

  assert.equal(await run(["provider", "install", "claude"], options), 0);
  assert.deepEqual(calls[0].slice(-14), [
    "run", "--rm", "--no-deps", "--user", "10001:10001",
    "--entrypoint", "npm", "spaceapp-cli", "install",
    "--prefix", "/var/lib/spaceapp-cli/vendor/claude",
    "--no-audit", "--no-fund", "@anthropic-ai/claude-code@2.1.206"
  ]);
  assert.match(stdout.value(), /Installing Claude Code from Anthropic/);
  await assert.rejects(() => run(["provider", "install", "gemini"], options), /provider install claude/i);
});

test("runtime management delegates only fixed Docker argument arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-runtime-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  };
  await run(["init"], options);
  await run(["up"], options);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "docker");
  assert.deepEqual(calls[0].args.slice(-3), ["up", "-d", "--remove-orphans"]);
});

test("owner password reset passes the password only over container stdin", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-owner-reset-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec, io) => {
      calls.push({ spec, io });
      return 0;
    }
  };
  await run(["init"], { ...options, stdin: Readable.from([]) });
  await run(["owner", "reset-password"], {
    ...options,
    stdin: Readable.from(["correct horse battery staple\n"])
  });

  assert.deepEqual(
    calls[0].spec.args.slice(-8),
    ["exec", "-T", "--user", "10001:10001", "spaceapp-core", "node", "scripts/reset-owner-password.mjs", "--stdin"]
  );
  assert.equal(calls[0].io.input, "correct horse battery staple\n");
  assert.doesNotMatch(JSON.stringify(calls[0].spec), /correct horse battery staple/);
});

test("owner setup token rotation updates the host secret only after the database accepts it", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-owner-setup-rotate-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    execute: async (spec, io) => {
      calls.push({ spec, io });
      return 0;
    }
  };
  await run(["init"], options);

  assert.equal(await run(["owner", "rotate-setup-token"], options), 0);
  const rotatedToken = (await readFile(join(root, "secrets", "setup-token"), "utf8")).trim();
  assert.match(rotatedToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].io.input, `${rotatedToken}\n`);
  assert.doesNotMatch(JSON.stringify(calls[0].spec), new RegExp(rotatedToken));
  assert.match(stdout.value(), new RegExp(`New one-time setup token: ${rotatedToken}`));
});

test("restore creates a safety backup, stops app writers, restores offline, and restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-restore-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec.args);
      return 0;
    }
  };
  await run(["init"], { ...options, stdin: Readable.from([]) });
  await mkdir(join(root, "backups", "spaceapp-backup-20260723T120000000Z"));
  await mkdir(join(root, "backups", "spaceapp-backup-20260723T130000000Z"));
  assert.equal(await run(["restore"], {
    ...options,
    stdin: Readable.from(["RESTORE\n"])
  }), 0);

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].slice(-7), [
    "exec", "-T", "--user", "0:0", "spaceapp-core", "node", "scripts/portable-backup.mjs"
  ]);
  assert.deepEqual(calls[1].slice(-4), [
    "stop", "spaceapp-core", "spaceapp-cli", "spaceapp-browser"
  ]);
  assert.deepEqual(calls[2].slice(-17), [
    "run", "--rm", "--no-deps", "--user", "0:0",
    "--env", "SPACE_DATABASE_URL_FILE=/run/secrets/database-url",
    "--entrypoint", "node", "spaceapp-core", "scripts/portable-restore.mjs",
    "--input", "/backups",
    "--backup-id", "spaceapp-backup-20260723T130000000Z",
    "--confirm", "RESTORE"
  ]);
  assert.deepEqual(calls[3].slice(-3), ["up", "-d", "--remove-orphans"]);
});

test("restore leaves app writers stopped when the data restore fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-restore-failure-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec) => {
      calls.push(spec.args);
      return calls.length === 3 ? 47 : 0;
    }
  };
  await run(["init"], { ...options, stdin: Readable.from([]) });
  await mkdir(join(root, "backups", "spaceapp-backup-20260723T140000000Z"));

  assert.equal(await run(["restore"], {
    ...options,
    stdin: Readable.from(["RESTORE\n"])
  }), 47);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].slice(-7), [
    "scripts/portable-restore.mjs",
    "--input", "/backups",
    "--backup-id", "spaceapp-backup-20260723T140000000Z",
    "--confirm", "RESTORE"
  ]);
});
