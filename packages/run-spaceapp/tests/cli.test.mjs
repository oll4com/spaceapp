import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { executeCommand, run } from "../src/cli.mjs";
import { ensureDockerAvailable } from "../src/prerequisites.mjs";
import {
  addWorkspace,
  composeProjectName,
  initializeInstallation,
  saveConfig,
  writeCredential
} from "../src/index.mjs";

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

const cachyOsEightGigabyteClassLaptop = Object.freeze({
  cpuCount: 8,
  totalMemoryBytes: 7_950_000_000,
  freeDiskBytes: 218 * 1024 ** 3
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
  assert.match(
    stdout.value(),
    /If it expires, run: npx --yes run-spaceapp@latest owner rotate-setup-token/
  );
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

test("install explains recovery when the database accepts a token that cannot be saved locally", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-token-write-failed-"));
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
    execute: async () => 0,
    persistSetupToken: async () => {
      throw new Error("read-only filesystem");
    }
  }), 1);

  assert.equal(
    (await readFile(join(root, "secrets", "setup-token"), "utf8")).trim(),
    initialToken
  );
  assert.doesNotMatch(stdout.value(), /One-time setup token:/);
  assert.match(stderr.value(), /accepted a new setup token.*could not be saved locally/is);
  assert.match(
    stderr.value(),
    /npx --yes run-spaceapp@latest owner rotate-setup-token/i
  );
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
  const composeActions = [];
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
    execute: async (spec, io) => {
      if (spec.args.at(-1) === "ps") {
        composeActions.push("status");
        io.stdout?.write("spaceapp-core running\n");
      }
      if (spec.args.includes("logs")) {
        composeActions.push("logs");
        io.stderr?.write("spaceapp-core | startup failed visibly\n");
      }
      if (spec.args.at(-1) === "down") {
        composeActions.push("down");
      }
      return 0;
    }
  }), 1);

  assert.equal(readinessChecks, 301);
  assert.equal(sleepCalls, 300);
  assert.match(stdout.value(), /Still waiting for SpaceApp services \(30 seconds elapsed; up to 10 minutes\)/i);
  assert.match(stdout.value(), /Showing recent startup logs after 120 seconds/i);
  assert.match(stdout.value(), /spaceapp-core running/i);
  assert.match(stderr.value(), /did not become ready within 10 minutes/i);
  assert.match(stderr.value(), /Collecting SpaceApp service status and recent logs before rollback/i);
  assert.match(stderr.value(), /spaceapp-core \| startup failed visibly/i);
  assert.ok(composeActions.indexOf("status") < composeActions.indexOf("logs"));
  assert.ok(composeActions.indexOf("logs") < composeActions.indexOf("down"));
  assert.doesNotMatch(stdout.value(), /SpaceApp is ready/);
});

test("readiness progress diagnostics cannot abort an otherwise successful install", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-readiness-diagnostics-"));
  const stdout = capture();
  const stderr = capture();
  let readinessChecks = 0;
  let statusCalls = 0;
  let logCalls = 0;

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
      if (!url.endsWith("/readyz")) {
        return jsonResponse({ setupRequired: false, expiresAt: null });
      }
      readinessChecks += 1;
      return readinessChecks >= 61
        ? jsonResponse({ ok: true })
        : jsonResponse({ ok: false }, 503);
    },
    sleep: async () => {},
    execute: async (spec) => {
      if (spec.args.at(-1) === "ps") {
        statusCalls += 1;
        if (statusCalls === 1) throw new Error("status transport closed");
      }
      if (spec.args.includes("logs")) {
        logCalls += 1;
        if (logCalls === 1) throw new Error("logs transport closed");
      }
      return 0;
    }
  }), 0);

  assert.equal(readinessChecks, 61);
  assert.equal(statusCalls, 4);
  assert.equal(logCalls, 1);
  assert.match(stderr.value(), /could not collect status diagnostics.*status transport closed/i);
  assert.match(stderr.value(), /could not collect logs diagnostics.*logs transport closed/i);
  assert.match(stdout.value(), /SpaceApp is ready/i);
});

test("install accepts 7.4 GiB usable memory on an 8 GB-class CachyOS laptop and reaches Docker startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-cachyos-memory-"));
  const stdout = capture();
  const stderr = capture();
  let dockerStartupReached = false;

  assert.equal(await run(["install", "--profile", "light", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => cachyOsEightGigabyteClassLaptop,
    ensureDocker: async () => {
      dockerStartupReached = true;
      return { code: 0, reexecuted: false };
    },
    prepareDockerPath: async () => null,
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async () => 0
  }), 0);

  assert.match(stdout.value(), /Selected profile: light \(7\.4 GiB system memory detected\)/i);
  assert.match(stdout.value(), /PASS Memory: 7\.4 GiB available; 7 GiB usable \(8 GB-class system\) required/i);
  assert.equal(dockerStartupReached, true);
  assert.equal(stderr.value(), "");
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
  assert.match(stdout.value(), /Selected profile: light.*7\.7 GiB/i);
  assert.match(stdout.value(), /SpaceApp is ready at http:\/\/127\.0\.0\.1:4911/);
  assert.deepEqual(calls.map((call) => [
    call.command,
    ...call.args.slice(-2).map((argument) =>
      argument.endsWith("compose.host-access.yml") ? "compose.host-access.yml" : argument
    )
  ]), [
    ["docker", "docker", "--version"].slice(1),
    ["docker", "compose", "version"],
    ["docker", "info"],
    ["docker", "compose.host-access.yml", "pull"],
    ["docker", "-d", "--remove-orphans"],
    ["docker", "scripts/rotate-owner-setup-token.mjs", "--stdin"],
    ["docker", "--force", "spaceapp-browser"]
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

test("host-root install is rejected on non-Linux hosts before Docker or installation state", async () => {
  for (const platform of ["darwin", "win32"]) {
    const root = await mkdtemp(join(tmpdir(), `spaceapp-cli-host-root-${platform}-`));
    const calls = {
      prepareDockerPath: 0,
      inspectResources: 0,
      ensureDocker: 0,
      execute: 0
    };

    await assert.rejects(
      () => run(["install", "--access", "host-root", "--no-open"], {
        env: { SPACEAPP_HOME: root },
        platform,
        stdout: capture().stream,
        stderr: capture().stream,
        stdin: Readable.from([]),
        prepareDockerPath: async () => {
          calls.prepareDockerPath += 1;
        },
        inspectResources: async () => {
          calls.inspectResources += 1;
          return eightGigabyteClassLinuxGuest;
        },
        ensureDocker: async () => {
          calls.ensureDocker += 1;
          return { code: 0, reexecuted: false };
        },
        execute: async () => {
          calls.execute += 1;
          return 0;
        }
      }),
      /host-root access is supported only on Linux/i
    );

    assert.deepEqual(calls, {
      prepareDockerPath: 0,
      inspectResources: 0,
      ensureDocker: 0,
      execute: 0
    });
    await assert.rejects(() => readFile(join(root, "config.json"), "utf8"));
  }
});

test("an existing host-root installation is rejected on non-Linux hosts before Docker preparation", async () => {
  for (const platform of ["darwin", "win32"]) {
    const root = await mkdtemp(join(tmpdir(), `spaceapp-cli-existing-host-root-${platform}-`));
    await initializeInstallation(root, {
      version: "0.1.17",
      profile: "light",
      accessMode: "host-root"
    });
    const configBefore = await readFile(join(root, "config.json"), "utf8");
    const calls = {
      prepareDockerPath: 0,
      inspectResources: 0,
      ensureDocker: 0,
      execute: 0
    };

    await assert.rejects(
      () => run(["install", "--no-open"], {
        env: { SPACEAPP_HOME: root },
        platform,
        stdout: capture().stream,
        stderr: capture().stream,
        stdin: Readable.from([]),
        prepareDockerPath: async () => {
          calls.prepareDockerPath += 1;
        },
        inspectResources: async () => {
          calls.inspectResources += 1;
          return eightGigabyteClassLinuxGuest;
        },
        ensureDocker: async () => {
          calls.ensureDocker += 1;
          return { code: 0, reexecuted: false };
        },
        execute: async () => {
          calls.execute += 1;
          return 0;
        }
      }),
      /host-root access is supported only on Linux/i
    );

    assert.deepEqual(calls, {
      prepareDockerPath: 0,
      inspectResources: 0,
      ensureDocker: 0,
      execute: 0
    });
    assert.equal(await readFile(join(root, "config.json"), "utf8"), configBefore);
  }
});

test("the matching x64 candidate enables Linux host-root through the normal install path", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-matching-host-root-"));
  const calls = {
    prepareDockerPath: 0,
    inspectResources: 0,
    ensureDocker: 0,
    execute: 0
  };

  assert.equal(await run(["install", "--access", "host-root", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    prepareDockerPath: async () => {
      calls.prepareDockerPath += 1;
    },
    inspectResources: async () => {
      calls.inspectResources += 1;
      return eightGigabyteClassLinuxGuest;
    },
    ensureDocker: async () => {
      calls.ensureDocker += 1;
      return { code: 0, reexecuted: false };
    },
    request: async (url) => url.endsWith("/readyz")
      ? jsonResponse({ ok: true })
      : jsonResponse({ setupRequired: false, expiresAt: null }),
    sleep: async () => {},
    execute: async () => {
      calls.execute += 1;
      return 0;
    }
  }), 0);

  assert.deepEqual(calls, {
    prepareDockerPath: 1,
    inspectResources: 1,
    ensureDocker: 1,
    execute: 3
  });
  assert.equal(
    JSON.parse(await readFile(join(root, "config.json"), "utf8")).accessMode,
    "host-root"
  );
});

test("install enables, preserves, and removes Linux host-root access without deleting secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-host-root-transition-"));
  await initializeInstallation(root, {
    version: "0.1.14",
    profile: "light"
  });
  const secretBefore = await readFile(join(root, "secrets", "session-secret"), "utf8");
  const installArgs = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    hostRootRuntimeCompatible: true,
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async (input) => {
      installArgs.push(input.installArgs);
      return { code: 0, reexecuted: false };
    },
    prepareDockerPath: async () => null,
    request: async (url) => url.endsWith("/readyz")
      ? jsonResponse({ ok: true })
      : jsonResponse({ setupRequired: false, expiresAt: null }),
    sleep: async () => {},
    execute: async () => 0
  };

  const enableOutput = capture();
  const enableWarning = capture();
  assert.equal(await run(["install", "--access", "host-root", "--no-open"], {
    ...options,
    stdout: enableOutput.stream,
    stderr: enableWarning.stream
  }), 0);
  assert.equal(
    (JSON.parse(await readFile(join(root, "config.json"), "utf8"))).accessMode,
    "host-root"
  );
  assert.match(await readFile(join(root, "compose.host-access.yml"), "utf8"), /target: "\/host"/);
  assert.match(enableOutput.value(), /Access: isolated -> host-root/);
  assert.match(enableWarning.value(), /WARNING.*host-root.*entire Linux host/i);
  assert.equal(installArgs[0].requestedAccessMode, "host-root");

  const refreshOutput = capture();
  const refreshWarning = capture();
  assert.equal(await run(["install", "--no-open"], {
    ...options,
    stdout: refreshOutput.stream,
    stderr: refreshWarning.stream
  }), 0);
  assert.equal(
    (JSON.parse(await readFile(join(root, "config.json"), "utf8"))).accessMode,
    "host-root"
  );
  assert.match(refreshOutput.value(), /Access: host-root -> host-root/);
  assert.match(refreshWarning.value(), /WARNING.*host-root/i);
  assert.equal(installArgs[1].requestedAccessMode, undefined);

  const isolateOutput = capture();
  assert.equal(await run(["install", "--access=isolated", "--no-open"], {
    ...options,
    stdout: isolateOutput.stream
  }), 0);
  assert.equal(
    (JSON.parse(await readFile(join(root, "config.json"), "utf8"))).accessMode,
    "isolated"
  );
  assert.equal(await readFile(join(root, "compose.host-access.yml"), "utf8"), "services: {}\n");
  assert.match(isolateOutput.value(), /Access: host-root -> isolated/);
  assert.equal(installArgs[2].requestedAccessMode, "isolated");
  assert.equal(await readFile(join(root, "secrets", "session-secret"), "utf8"), secretBefore);
});

test("Windows launcher .2 upgrades a 0.1.10 standard install to runtime .2 light without changing persistent state", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-stale-upgrade-"));
  const workspace = await mkdtemp(join(tmpdir(), "spaceapp-cli-stale-workspace-"));
  const initialized = await initializeInstallation(root, {
    version: "0.1.10",
    profile: "standard"
  });
  const staleConfig = await addWorkspace(initialized.config, workspace);
  await saveConfig(root, staleConfig);
  await writeCredential(root, "gemini", "fixture-provider-credential");

  const preservedPaths = [
    "secrets/postgres-password",
    "secrets/database-url",
    "secrets/session-secret",
    "secrets/setup-token",
    "secrets/providers/gemini.key"
  ];
  const preservedFiles = new Map(await Promise.all(
    preservedPaths.map(async (path) => [path, await readFile(join(root, path), "utf8")])
  ));
  const composeBefore = await readFile(join(root, "compose.yml"), "utf8");
  const projectBefore = composeProjectName(root);
  const calls = [];
  const stagedStateRoots = new Set();
  const stdout = capture();
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "win32",
    stdout: stdout.stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    inspectResources: async () => ({
      ...eightGigabyteClassLinuxGuest,
      totalMemoryBytes: 64 * 1024 ** 3
    }),
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    request: async (url) => url.endsWith("/readyz")
      ? jsonResponse({ ok: true })
      : jsonResponse({ setupRequired: false, expiresAt: null }),
    sleep: async () => {},
    execute: async (spec) => {
      calls.push(spec);
      const envFileIndex = spec.args.indexOf("--env-file");
      if (envFileIndex !== -1) {
        const stagedStateRoot = dirname(spec.args[envFileIndex + 1]);
        stagedStateRoots.add(stagedStateRoot);
        assert.notEqual(stagedStateRoot, root);
        assert.equal(
          spec.args[spec.args.indexOf("--project-directory") + 1],
          root
        );
        assert.match(
          await readFile(join(stagedStateRoot, "runtime.env"), "utf8"),
          /^SPACEAPP_IMAGE_TAG=0\.1\.17$/m
        );
      }
      return 0;
    }
  };

  assert.equal(await run(["install", "--no-open"], options), 0);

  const upgradedConfig = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(upgradedConfig.version, "0.1.17");
  assert.equal(upgradedConfig.previousVersion, "0.1.10");
  assert.equal(upgradedConfig.profile, "light");
  assert.deepEqual(upgradedConfig.workspaces, staleConfig.workspaces);
  for (const [path, content] of preservedFiles) {
    assert.equal(await readFile(join(root, path), "utf8"), content);
  }
  assert.equal(await readFile(join(root, "compose.yml"), "utf8"), composeBefore);
  assert.equal(composeProjectName(root), projectBefore);
  assert.equal(calls.some((spec) => spec.args.includes("down")), false);
  assert.equal(calls.some((spec) => spec.args.includes("--volumes")), false);
  const browserCleanup = calls.find((spec) =>
    spec.args.slice(-4).join(" ") === "rm --stop --force spaceapp-browser"
  );
  assert.ok(browserCleanup, "light upgrades must remove a browser container left by the standard profile");
  assert.deepEqual(
    browserCleanup.args.slice(browserCleanup.args.indexOf("--profile"), -4),
    ["--profile", "standard"],
    "browser cleanup must activate the service's standard Compose profile"
  );
  for (const spec of calls) {
    assert.equal(spec.args[spec.args.indexOf("--project-name") + 1], projectBefore);
  }
  assert.match(stdout.value(), /Launcher version: 0\.1\.17/);
  assert.match(stdout.value(), /Runtime image version: 0\.1\.10 -> 0\.1\.17/);
  assert.match(stdout.value(), /Profile: standard -> light/);
  assert.match(stdout.value(), /data.*workspaces.*credentials.*secrets.*persistent Docker volumes/i);

  const refreshOutput = capture();
  const refreshCallStart = calls.length;
  assert.equal(await run(["install", "--no-open"], {
    ...options,
    stdout: refreshOutput.stream
  }), 0);
  const refreshedConfig = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(refreshedConfig.version, "0.1.17");
  assert.equal(refreshedConfig.previousVersion, "0.1.10");
  assert.equal(refreshedConfig.profile, "light");
  assert.deepEqual(refreshedConfig.workspaces, staleConfig.workspaces);
  for (const [path, content] of preservedFiles) {
    assert.equal(await readFile(join(root, path), "utf8"), content);
  }
  assert.equal(await readFile(join(root, "compose.yml"), "utf8"), composeBefore);
  assert.equal(composeProjectName(root), projectBefore);
  const refreshCalls = calls.slice(refreshCallStart);
  assert.equal(refreshCalls.some((spec) => spec.args.includes("down")), false);
  assert.equal(refreshCalls.some((spec) => spec.args.includes("--volumes")), false);
  assert.equal(
    refreshCalls.some((spec) =>
      spec.args.slice(-4).join(" ") === "rm --stop --force spaceapp-browser"
    ),
    true,
    "idempotent light refreshes must also clean up a browser container left by an earlier launcher"
  );
  assert.equal(stagedStateRoots.size, 2);
  for (const stagedStateRoot of stagedStateRoots) {
    await assert.rejects(() => readFile(join(stagedStateRoot, "runtime.env"), "utf8"));
  }
  assert.match(
    refreshOutput.value(),
    /Runtime image version: 0\.1\.17 -> 0\.1\.17/
  );
  assert.match(refreshOutput.value(), /Profile: light -> light/);
});

test("a failed upgrade preserves the committed installation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-failed-upgrade-"));
  await initializeInstallation(root, {
    version: "0.1.10",
    profile: "standard"
  });
  const statePaths = [
    "config.json",
    "runtime.env",
    "compose.yml",
    "compose.workspaces.yml",
    "compose.host-access.yml"
  ];
  const committedState = new Map(await Promise.all(
    statePaths.map(async (path) => [path, await readFile(join(root, path), "utf8")])
  ));

  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    inspectResources: async () => ({
      ...eightGigabyteClassLinuxGuest,
      cpuCount: 1
    }),
    prepareDockerPath: async () => null,
    execute: async () => 0
  }), 1);

  for (const [path, content] of committedState) {
    assert.equal(await readFile(join(root, path), "utf8"), content);
  }
});

test("Docker, readiness, and browser-cleanup failures preserve the committed installation state", async () => {
  for (const failure of ["pull", "up", "readiness", "browser-cleanup"]) {
    const root = await mkdtemp(join(tmpdir(), `spaceapp-cli-${failure}-failure-`));
    await initializeInstallation(root, {
      version: "0.1.10",
      profile: "standard"
    });
    const statePaths = [
      "config.json",
      "runtime.env",
      "compose.yml",
      "compose.workspaces.yml",
      "compose.host-access.yml",
      "secrets/setup-token"
    ];
    const committedState = new Map(await Promise.all(
      statePaths.map(async (path) => [path, await readFile(join(root, path), "utf8")])
    ));
    const stagedStateRoots = new Set();

    const code = await run(["install", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: Readable.from([]),
      inspectResources: async () => eightGigabyteClassLinuxGuest,
      ensureDocker: async () => ({ code: 0, reexecuted: false }),
      prepareDockerPath: async () => null,
      request: async (url) => url.endsWith("/readyz")
        ? jsonResponse({ ok: failure !== "readiness" }, failure === "readiness" ? 503 : 200)
        : jsonResponse({
          setupRequired: failure === "browser-cleanup",
          expiresAt: failure === "browser-cleanup" ? "2099-07-23T12:15:00.000Z" : null
        }),
      sleep: async () => {},
      execute: async (spec) => {
        const envFileIndex = spec.args.indexOf("--env-file");
        if (envFileIndex !== -1) {
          stagedStateRoots.add(dirname(spec.args[envFileIndex + 1]));
        }
        if (failure === "pull" && spec.args.at(-1) === "pull") return 41;
        if (failure === "up" && spec.args.includes("--remove-orphans")) return 42;
        if (
          failure === "browser-cleanup" &&
          spec.args.slice(-4).join(" ") === "rm --stop --force spaceapp-browser"
        ) return 43;
        return 0;
      }
    });

    assert.equal(
      code,
      failure === "pull" ? 41 : failure === "up" ? 42 : failure === "browser-cleanup" ? 43 : 1
    );
    for (const [path, content] of committedState) {
      assert.equal(await readFile(join(root, path), "utf8"), content);
    }
    assert.equal(stagedStateRoots.has(root), failure !== "pull");
    const temporaryStateRoots = [...stagedStateRoots].filter(
      (stateRoot) => stateRoot !== root
    );
    assert.equal(temporaryStateRoots.length, 1);
    for (const stagedStateRoot of temporaryStateRoots) {
      await assert.rejects(() => readFile(join(stagedStateRoot, "runtime.env"), "utf8"));
    }
  }
});

test("a failed host-root activation restores the previous isolated runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-host-root-rollback-"));
  await initializeInstallation(root, {
    version: "0.1.14",
    profile: "light",
    accessMode: "isolated"
  });
  const stderr = capture();
  const upAccessModes = [];
  const upStateRoots = [];

  const code = await run(["install", "--access", "host-root", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    hostRootRuntimeCompatible: true,
    stdout: capture().stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    sleep: async () => {},
    execute: async (spec) => {
      if (spec.args.includes("--remove-orphans")) {
        const envFileIndex = spec.args.indexOf("--env-file");
        const stateRoot = dirname(spec.args[envFileIndex + 1]);
        upStateRoots.push(stateRoot);
        const hostAccess = await readFile(join(stateRoot, "compose.host-access.yml"), "utf8");
        upAccessModes.push(hostAccess.includes('target: "/host"') ? "host-root" : "isolated");
        return upAccessModes.length === 1 ? 42 : 0;
      }
      return 0;
    }
  });

  assert.equal(code, 42);
  assert.deepEqual(upAccessModes, ["host-root", "isolated"]);
  assert.notEqual(upStateRoots[0], root);
  assert.equal(upStateRoots[1], root);
  assert.equal(
    (JSON.parse(await readFile(join(root, "config.json"), "utf8"))).accessMode,
    "isolated"
  );
  assert.match(stderr.value(), /previous SpaceApp runtime and access mode were restored/i);
});

test("a failed clean host-root install stops the partially started runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-host-root-clean-failure-"));
  const composeActions = [];

  const code = await run(["install", "--access", "host-root", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    hostRootRuntimeCompatible: true,
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    request: async (url) => url.endsWith("/readyz")
      ? jsonResponse({ ok: false }, 503)
      : jsonResponse({ setupRequired: false, expiresAt: null }),
    sleep: async () => {},
    execute: async (spec) => {
      if (spec.args.includes("--remove-orphans")) composeActions.push("up");
      if (spec.args.at(-1) === "down") composeActions.push("down");
      return 0;
    }
  });

  assert.equal(code, 1);
  assert.deepEqual(composeActions, ["up", "down"]);
  await assert.rejects(() => readFile(join(root, "config.json"), "utf8"));
});

test("install --with-companions activates the companions compose profile and runtime toggle", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-with-companions-"));
  const composeArgs = [];
  let runtimeEnvText = null;

  const code = await run(["install", "--with-companions", "--access", "host-root", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    hostRootRuntimeCompatible: true,
    stdout: capture().stream,
    stderr: capture().stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    request: async () => jsonResponse({ ok: false }, 503),
    sleep: async () => {},
    execute: async (spec) => {
      if (spec.args.includes("--remove-orphans")) {
        composeArgs.push(spec.args);
        runtimeEnvText = await readFile(
          join(dirname(spec.args[spec.args.indexOf("--env-file") + 1]), "runtime.env"),
          "utf8"
        );
      }
      return 0;
    }
  });

  assert.equal(code, 1);
  assert.equal(composeArgs.length, 1);
  assert.deepEqual(
    composeArgs[0].slice(composeArgs[0].indexOf("--profile"), composeArgs[0].indexOf("up")),
    ["--profile", "companions"]
  );
  assert.match(runtimeEnvText, /^SPACEAPP_COMPANIONS_ENABLED=true$/m);
});

test("diagnostic command errors never prevent failed-install rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-diagnostic-rollback-"));
  const stderr = capture();
  const composeActions = [];
  let statusCalls = 0;
  let logCalls = 0;

  assert.equal(await run(["install", "--access", "host-root", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    hostRootRuntimeCompatible: true,
    stdout: capture().stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => ({ code: 0, reexecuted: false }),
    prepareDockerPath: async () => null,
    request: async () => jsonResponse({ ok: false }, 503),
    sleep: async () => {},
    execute: async (spec) => {
      if (spec.args.includes("--remove-orphans")) {
        composeActions.push("up");
      }
      if (spec.args.at(-1) === "ps") {
        statusCalls += 1;
        if (statusCalls >= 21) throw new Error("diagnostic status transport closed");
      }
      if (spec.args.includes("logs")) {
        logCalls += 1;
        if (logCalls >= 5) throw new Error("diagnostic logs transport closed");
      }
      if (spec.args.at(-1) === "down") {
        composeActions.push("down");
      }
      return 0;
    }
  }), 1);

  assert.deepEqual(composeActions, ["up", "down"]);
  assert.match(stderr.value(), /could not collect status diagnostics.*transport closed/i);
  assert.match(stderr.value(), /could not collect logs diagnostics.*transport closed/i);
});

test("install honors an explicit standard profile and uses the native browser opener", async () => {
  for (const [platform, opener] of [
    ["linux", ["xdg-open", "http://127.0.0.1:4911"]],
    ["darwin", ["open", "http://127.0.0.1:4911"]],
    ["win32", ["powershell.exe", "open-spaceapp-browser", "http://127.0.0.1:4911"]]
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
        calls.push(spec.operation
          ? [spec.command, spec.operation, spec.env?.SPACEAPP_OPEN_URL]
          : [spec.command, ...spec.args]);
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

test("macOS authorization failure stops the install before SpaceApp image pulls", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-macos-authorization-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];

  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root, USER: "space-user", PATH: "/usr/bin:/bin" },
    platform: "darwin",
    arch: "x64",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: Readable.from(["yes\n"]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    prepareDockerPath: async () => null,
    ensureDocker: async (options) => ensureDockerAvailable({
      ...options,
      download: async () => {},
      launch: async () => {
        throw new Error("Docker Desktop must not launch after authorization failure.");
      },
      pathExists: async () => false,
      sleep: async () => {}
    }),
    execute: async (spec, io) => {
      calls.push({ spec, io });
      if (spec.command === "docker") return 127;
      if (spec.command === "sudo") return 1;
      return 0;
    }
  }), 1);

  assert.ok(calls.some(({ spec }) => spec.command === "sudo"));
  assert.equal(
    calls.some(({ spec }) =>
      spec.command === "docker" &&
      (spec.args.includes("pull") || spec.args.includes("up"))
    ),
    false
  );
  assert.match(stdout.value(), /password for your Mac administrator account/i);
  assert.match(stderr.value(), /macOS authorization failed/i);
  assert.match(stderr.value(), /No SpaceApp images were downloaded/i);
  assert.match(stderr.value(), /stopped before downloading images/i);
});

test("install does not misreport a failed Docker group re-entry as a pre-download failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-cli-install-reentry-failure-"));
  const stderr = capture();

  assert.equal(await run(["install", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: stderr.stream,
    stdin: Readable.from([]),
    inspectResources: async () => eightGigabyteClassLinuxGuest,
    ensureDocker: async () => {
      stderr.stream.write("The re-entered installer displayed the real runtime failure.\n");
      return { code: 1, reexecuted: true };
    },
    prepareDockerPath: async () => null,
    execute: async () => 0
  }), 1);

  assert.match(stderr.value(), /real runtime failure/i);
  assert.doesNotMatch(stderr.value(), /stopped before downloading images/i);
});

test("install stops before image pulls when usable memory is below 7 GiB", async () => {
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
      totalMemoryBytes: 6.9 * 1024 ** 3,
      freeDiskBytes: 20 * 1024 ** 3
    }),
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  }), 1);

  assert.match(
    stderr.value(),
    /FAIL Memory: 6\.9 GiB available; 7 GiB usable \(8 GB-class system\) required/i
  );
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
  assert.match(stderr.value(), /npx --yes run-spaceapp@latest install/);
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
    stdin: Readable.from(["abc123\n"])
  });

  assert.deepEqual(
    calls[0].spec.args.slice(-8),
    ["exec", "-T", "--user", "10001:10001", "spaceapp-core", "node", "scripts/reset-owner-password.mjs", "--stdin"]
  );
  assert.equal(calls[0].io.input, "abc123\n");
  assert.doesNotMatch(JSON.stringify(calls[0].spec), /abc123/);
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
