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

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function readyUnclaimedRequest(url) {
  return Promise.resolve(url.endsWith("/readyz")
    ? jsonResponse({ ok: true })
    : jsonResponse({ setupRequired: true, expiresAt: "2099-07-23T12:15:00.000Z" }));
}

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
    "winget.exe",
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

test("the launcher prepares the trusted Docker Desktop CLI path before every command", async () => {
  let calls = 0;
  assert.equal(await run(["help"], {
    env: { PATH: "/usr/bin" },
    platform: "darwin",
    stdout: capture().stream,
    stderr: capture().stream,
    prepareDockerPath: async () => {
      calls += 1;
      return "/Applications/Docker.app/Contents/Resources/bin";
    }
  }), 0);
  assert.equal(calls, 1);
});

test("install waits for readiness, rotates an unclaimed token, and prints exact paste instructions last", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-setup-token-"));
  const initialOutput = capture();
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: initialOutput.stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    execute: async () => 0,
    prepareDockerPath: async () => null
  };
  await run(["init"], options);
  const initialToken = (await readFile(join(root, "secrets", "setup-token"), "utf8")).trim();

  const stdout = capture();
  const stderr = capture();
  const events = [];
  let readinessChecks = 0;
  let rotationCall = null;
  assert.equal(await run(["install", "--no-open"], {
    ...options,
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    request: async (url) => {
      events.push(`request:${url}`);
      if (url.endsWith("/readyz")) {
        readinessChecks += 1;
        return jsonResponse({ ok: readinessChecks >= 2 }, readinessChecks >= 2 ? 200 : 503);
      }
      if (url.endsWith("/api/setup/status")) {
        return jsonResponse({ setupRequired: true, expiresAt: "2000-01-01T00:00:00.000Z" });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
    sleep: async () => {},
    execute: async (spec, io) => {
      const action = spec.args.at(-1) === "pull"
        ? "pull"
        : spec.args.includes("--remove-orphans")
          ? "up"
          : spec.args.some((argument) => argument.endsWith("rotate-owner-setup-token.mjs"))
            ? "rotate"
            : "other";
      events.push(`execute:${action}`);
      if (action === "rotate") {
        rotationCall = { spec, io };
        assert.match(io.input, /^[A-Za-z0-9_-]{40,}\n$/);
      }
      return 0;
    }
  }), 0);

  const installedToken = (await readFile(join(root, "secrets", "setup-token"), "utf8")).trim();
  assert.notEqual(installedToken, initialToken);
  assert.equal(rotationCall.io.input, `${installedToken}\n`);
  assert.doesNotMatch(JSON.stringify(rotationCall.spec), new RegExp(installedToken));
  assert.equal(readinessChecks, 2);
  assert.ok(events.indexOf("execute:up") < events.indexOf("request:http://127.0.0.1:4911/readyz"));
  assert.ok(events.indexOf("request:http://127.0.0.1:4911/api/setup/status") < events.indexOf("execute:rotate"));
  assert.match(
    stdout.value(),
    new RegExp(`One-time setup token: ${installedToken}\\nPaste it into the "One-time setup token" field`)
  );
  assert.match(stdout.value(), /If it expires, run: spaceapp owner rotate-setup-token/);
  assert.ok(stdout.value().lastIndexOf(installedToken) > stdout.value().lastIndexOf("SpaceApp is ready"));
  assert.equal(stderr.value(), "");
});

test("install retains the host token and prints no secret when database rotation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-token-rejected-"));
  await run(["init"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    prepareDockerPath: async () => null,
    execute: async () => 0
  });
  const initialToken = (await readFile(join(root, "secrets", "setup-token"), "utf8")).trim();
  const stdout = capture();
  const stderr = capture();

  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec) =>
      spec.args.some((argument) => argument.endsWith("rotate-owner-setup-token.mjs"))
        ? 41
        : 0
  }), 41);

  assert.equal(
    (await readFile(join(root, "secrets", "setup-token"), "utf8")).trim(),
    initialToken
  );
  assert.doesNotMatch(stdout.value(), /One-time setup token:/);
  assert.match(stderr.value(), /fresh owner setup token could not be created/i);
});

test("install does not rotate or print a setup token after the owner is already claimed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-claimed-"));
  const stdout = capture();
  const calls = [];
  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    request: async (url) => url.endsWith("/readyz")
      ? jsonResponse({ ok: true })
      : jsonResponse({ setupRequired: false, expiresAt: null }),
    sleep: async () => {},
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  }), 0);

  assert.equal(calls.some((spec) => spec.args.includes("rotate-owner-setup-token.mjs")), false);
  assert.doesNotMatch(stdout.value(), /One-time setup token:/);
});

test("install fails visibly when application readiness never arrives", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-not-ready-"));
  const stdout = capture();
  const stderr = capture();
  let readinessChecks = 0;
  let sleepCalls = 0;
  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    request: async (url) => {
      assert.match(url, /\/readyz$/);
      readinessChecks += 1;
      return jsonResponse({ ok: false }, 503);
    },
    sleep: async () => {
      sleepCalls += 1;
    },
    execute: async () => 0
  }), 1);

  assert.equal(readinessChecks, 91);
  assert.equal(sleepCalls, 90);
  assert.match(stderr.value(), /did not become ready within 3 minutes/i);
  assert.match(stderr.value(), /spaceapp status/);
  assert.match(stderr.value(), /spaceapp logs/);
  assert.doesNotMatch(stdout.value(), /SpaceApp is ready/);
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
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  };

  assert.equal(await run(["install", "--profile", "auto", "--no-open"], options), 0);
  assert.equal((JSON.parse(await readFile(join(root, "config.json"), "utf8"))).profile, "light");
  assert.match(stdout.value(), /Selected profile: light.*7\.7 GB/i);
  assert.match(stdout.value(), /SpaceApp is ready at http:\/\/127\.0\.0\.1:4911/);
  assert.deepEqual(calls.map((call) => [call.command, ...call.args.slice(-2)]), [
    ["docker", "docker", "--version"].slice(1),
    ["docker", "compose", "version"],
    ["docker", "info"],
    ["docker", join(root, "compose.workspaces.yml"), "pull"],
    ["docker", "-d", "--remove-orphans"],
    ["docker", "scripts/rotate-owner-setup-token.mjs", "--stdin"]
  ]);
  assert.doesNotMatch(calls.map((call) => `${call.command} ${call.args.join(" ")}`).join("\n"), /xdg-open/);
  assert.equal(calls.find((call) => call.args.includes("pull")).args.includes("--profile"), false);

  const second = capture();
  assert.equal(await run(["install", "--profile", "auto", "--no-open"], {
    ...options,
    stdout: second.stream
  }), 0);
  assert.match(second.value(), /One-time setup token:/);
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
      request: readyUnclaimedRequest,
      sleep: async () => {},
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
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec) => spec.command === "xdg-open" ? 127 : 0
  }), 0);

  assert.match(stdout.value(), /SpaceApp is ready at http:\/\/127\.0\.0\.1:4911/);
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
    request: readyUnclaimedRequest,
    sleep: async () => {},
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
  assert.match(stdout.value(), /SpaceApp is ready at http:\/\/127\.0\.0\.1:4911/);
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

test("Docker-backed commands explain exit 127 instead of failing silently", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-runtime-missing-docker-"));
  const stderr = capture();
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "win32",
    stdout: capture().stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    prepareDockerPath: async () => null,
    execute: async () => 0
  };
  await run(["init"], options);

  assert.equal(await run(["status"], {
    ...options,
    execute: async () => 127
  }), 127);
  assert.match(stderr.value(), /could not find the Docker CLI/i);
  assert.match(stderr.value(), /spaceapp install/);
});

test("doctor probes Docker CLI, Compose, and Engine once and distinguishes a stopped engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-doctor-engine-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "win32",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    prepareDockerPath: async () => null,
    execute: async (spec) => {
      calls.push(spec);
      return spec.args[0] === "info" ? 1 : 0;
    }
  };
  await run(["init"], { ...options, execute: async () => 0 });

  assert.equal(await run(["doctor"], options), 1);
  assert.deepEqual(calls.map((spec) => spec.args), [
    ["--version"],
    ["compose", "version"],
    ["info"]
  ]);
  assert.match(stdout.value(), /PASS Docker CLI: available/);
  assert.match(stdout.value(), /PASS Docker Compose: available/);
  assert.match(stderr.value(), /FAIL Docker Engine: installed but not running or inaccessible/);
  assert.doesNotMatch(stderr.value(), /Docker Engine: missing/);
});

test("uninstall reports progress, retained state, global CLI removal, and idempotent success", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-uninstall-"));
  const stdout = capture();
  const stderr = capture();
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    prepareDockerPath: async () => null,
    execute: async () => 0
  };
  await run(["init"], options);

  assert.equal(await run(["uninstall"], options), 0);
  assert.equal(await run(["uninstall"], options), 0);
  assert.match(stdout.value(), /Stopping and removing SpaceApp containers and network/);
  assert.match(stdout.value(), /Data, configuration, secrets, and backups remain/);
  assert.match(stdout.value(), /npm uninstall -g run-spaceapp/);
  assert.equal(stderr.value(), "");
});

test("uninstall reports Docker failures and confirms what was not removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-uninstall-failure-"));
  const stdout = capture();
  const stderr = capture();
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "darwin",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    prepareDockerPath: async () => null,
    execute: async () => 0
  };
  await run(["init"], options);

  assert.equal(await run(["uninstall"], {
    ...options,
    execute: async () => 127
  }), 127);
  assert.match(stderr.value(), /Uninstall could not remove the runtime/);
  assert.match(stderr.value(), /could not find the Docker CLI/);
  assert.match(stdout.value(), /global SpaceApp CLI remains installed/);
});

test("confirmed purge reports removed volumes and retained host files", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-uninstall-purge-"));
  const stdout = capture();
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    prepareDockerPath: async () => null,
    execute: async () => 0
  };
  await run(["init"], options);

  assert.equal(await run(["uninstall", "--purge-data"], {
    ...options,
    stdin: Readable.from(["DELETE\n"])
  }), 0);
  assert.match(stdout.value(), /Docker volumes removed/);
  assert.match(stdout.value(), /Host configuration and backups remain/);
  assert.match(stdout.value(), /npm uninstall -g run-spaceapp/);
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
