import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  CONTAINER_ENGINES,
  composeCommand,
  configEngine,
  createDefaultConfig,
  loadConfig,
  renderWorkspaceCompose,
  resolveInstallEngine,
  saveConfig,
  validateConfig
} from "../src/index.mjs";

import {
  collectPodmanFacts,
  detectInstallEngine
} from "../src/prerequisites.mjs";

import { run } from "../src/cli.mjs";

function capture() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
      }
    },
    value: () => value
  };
}

function ttyStdin(...answers) {
  let index = 0;
  let eventMode = false;
  const dataHandlers = [];
  const endHandlers = [];
  const keypressHandlers = [];
  const stream = {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on(event, handler) {
      if (event === "data") {
        dataHandlers.push(handler);
        if (!eventMode) {
          eventMode = true;
          queueMicrotask(() => deliverEvents());
        }
      } else if (event === "end") {
        endHandlers.push(handler);
      } else if (event === "keypress") {
        keypressHandlers.push(handler);
        if (!eventMode) {
          eventMode = true;
          queueMicrotask(() => deliverEvents());
        }
      }
      return stream;
    },
    once(event, handler) {
      if (event === "data" || event === "end" || event === "keypress") {
        stream.on(event, handler);
      }
      return stream;
    },
    removeListener() {
      return stream;
    },
    off() {
      return stream;
    },
    listenerCount(event) {
      if (event === "data") {
        return dataHandlers.length;
      }
      if (event === "end") {
        return endHandlers.length;
      }
      if (event === "keypress") {
        return keypressHandlers.length;
      }
      return 0;
    },
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

  function deliverEvents() {
    if (index < answers.length) {
      const answer = answers[index];
      index += 1;
      for (const handler of [...keypressHandlers]) {
        handler(answer === "y" ? "y" : answer === "DOWNGRADE" ? "D" : "", {
          name: answer === "y" ? "y" : "return",
          sequence: answer === "y" ? "y" : "\r",
          ctrl: false,
          meta: false,
          shift: false
        });
      }
      for (const handler of [...dataHandlers]) {
        handler(Buffer.from(`${answer}\n`));
      }
      queueMicrotask(() => deliverEvents());
    } else {
      for (const handler of [...endHandlers]) {
        handler();
      }
    }
  }

  return stream;
}

const FRESH_APPROVALS = ["", "", "", "", "", "y"];

test("CONTAINER_ENGINES defines supported container engines", () => {
  assert.deepEqual(CONTAINER_ENGINES, ["docker", "podman"]);
});

test("composeCommand returns podman command and compose args when engine is podman", () => {
  const root = join(tmpdir(), "spaceapp-engine-test");
  const cmd = composeCommand("up", root, { engine: "podman", profile: "small" });
  assert.equal(cmd.command, "podman");
  assert.equal(cmd.args[0], "compose");
  assert.ok(cmd.args.includes("up"));
  assert.ok(cmd.args.includes("-d"));
});

test("composeCommand defaults to docker when engine is omitted", () => {
  const root = join(tmpdir(), "spaceapp-engine-test");
  const cmd = composeCommand("up", root, { profile: "small" });
  assert.equal(cmd.command, "docker");
  assert.equal(cmd.args[0], "compose");
});

test("composeCommand throws when given an unsupported engine", () => {
  const root = join(tmpdir(), "spaceapp-engine-test");
  assert.throws(
    () => composeCommand("up", root, { engine: "containerd" }),
    /Unsupported container engine "containerd"/
  );
});

test("renderWorkspaceCompose injects selinux and userns_mode for podman, keeps docker clean", () => {
  const dockerConfig = {
    ...createDefaultConfig({ version: "1.1.5", profile: "small", accessMode: "isolated", engine: "docker" }),
    workspaces: [{ id: "test-12345678", name: "test-ws", hostPath: "/tmp/test-ws", containerPath: "/workspaces/test-ws", readOnly: false }]
  };
  const podmanConfig = {
    ...createDefaultConfig({ version: "1.1.5", profile: "small", accessMode: "isolated", engine: "podman" }),
    workspaces: [{ id: "test-12345678", name: "test-ws", hostPath: "/tmp/test-ws", containerPath: "/workspaces/test-ws", readOnly: false }]
  };

  const dockerYaml = renderWorkspaceCompose(dockerConfig);
  assert.doesNotMatch(dockerYaml, /selinux:\s*z/);
  assert.doesNotMatch(dockerYaml, /userns_mode:\s*"keep-id:uid=10001,gid=10001"/);

  const podmanYaml = renderWorkspaceCompose(podmanConfig);
  assert.match(podmanYaml, /selinux:\s*z/);
  assert.match(podmanYaml, /userns_mode:\s*"keep-id:uid=10001,gid=10001"/);
});

test("validateConfig validates engine field and forbids host-root access with podman", () => {
  const validDocker = createDefaultConfig({ version: "1.1.5", profile: "small", accessMode: "isolated", engine: "docker" });
  assert.equal(configEngine(validateConfig(validDocker)), "docker");

  const validPodman = createDefaultConfig({ version: "1.1.5", profile: "small", accessMode: "isolated", engine: "podman" });
  assert.equal(validateConfig(validPodman).engine, "podman");

  const invalidEngine = { ...validDocker, engine: "rkt" };
  assert.throws(
    () => validateConfig(invalidEngine),
    /engine must be docker or podman/
  );

  const podmanHostRoot = { ...validPodman, accessMode: "host-root" };
  assert.throws(
    () => validateConfig(podmanHostRoot),
    /Host-root access is not supported on Podman/
  );
});

test("resolveInstallEngine prevents engine switching on existing installation", () => {
  assert.equal(resolveInstallEngine(undefined, "podman"), "podman");
  assert.equal(resolveInstallEngine(undefined, "docker"), "docker");
  assert.equal(resolveInstallEngine(undefined, undefined), "docker");
  assert.equal(resolveInstallEngine("podman", undefined), "podman");
  assert.equal(resolveInstallEngine("podman", "podman"), "podman");
  assert.equal(resolveInstallEngine("docker", "docker"), "docker");

  assert.throws(
    () => resolveInstallEngine("podman", "docker"),
    /Switching container engines on an existing installation is not supported/
  );
  assert.throws(
    () => resolveInstallEngine("docker", "podman"),
    /Switching container engines on an existing installation is not supported/
  );
  assert.throws(
    () => resolveInstallEngine("unknown", undefined),
    /must be docker or podman/
  );
});

test("detectInstallEngine picks podman when docker is absent and podman is available", async () => {
  const execute = async (spec) => {
    if (spec.command === "docker") return 127;
    if (spec.command === "podman") return 0;
    return 0;
  };
  const detected = await detectInstallEngine({ execute });
  assert.equal(detected.suggest, "podman");
});

test("detectInstallEngine defaults to docker when docker is available", async () => {
  const execute = async (spec) => {
    if (spec.command === "docker") return 0;
    if (spec.command === "podman") return 0;
    return 0;
  };
  const detected = await detectInstallEngine({ execute });
  assert.equal(detected.suggest, "docker");
});

test("collectPodmanFacts parses version, rootless state, and cgroup v2 delegation", async () => {
  const execute = async (spec, io) => {
    if (spec.command === "podman" && spec.args?.[0] === "--version") {
      io.stdout?.write("podman version 5.2.0\n");
      return 0;
    }
    if (spec.command === "podman" && spec.args?.[0] === "info") {
      io.stdout?.write(JSON.stringify({
        version: { Version: "5.2.0" },
        host: {
          security: { rootless: true },
          cgroupVersion: "v2",
          cgroupControllers: ["memory", "cpu", "pids"]
        }
      }));
      return 0;
    }
    return 0;
  };

  const facts = await collectPodmanFacts(execute);
  assert.equal(facts.version, "5.2.0");
  assert.equal(facts.rootless, true);
  assert.equal(facts.cgroupVersion, "v2");
  assert.equal(facts.limitsDelegated, true);
});

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

function readyUnclaimedRequest(url) {
  return Promise.resolve(url.endsWith("/readyz")
    ? jsonResponse({ ok: true })
    : jsonResponse({ setupRequired: true, expiresAt: "2099-07-23T12:15:00.000Z" }));
}

test("run install with --engine podman configures podman and succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const stdout = capture();
  const stderr = capture();
  const calls = [];

  const mockResources = {
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    freeDiskBytes: 40 * 1024 ** 3
  };

  const code = await run(["install", "--engine", "podman", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    arch: "x64",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin(...FRESH_APPROVALS),
    inspectResources: async () => mockResources,
    request: readyUnclaimedRequest,
    sleep: async () => {},
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.command === "podman" && spec.args?.includes("info")) {
        io.stdout?.write(JSON.stringify({
          version: { Version: "5.2.0" },
          host: { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"] }
        }));
        return 0;
      }
      if (spec.args?.includes("pg_dump")) {
        io.stdout?.write("-- dump\nSELECT 1;\n");
        return 0;
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.match(stdout.value(), /Engine: not configured -> podman/);
  assert.ok(calls.some((c) => c.command === "podman" && c.args?.includes("pull")));
  assert.ok(calls.some((c) => c.command === "podman" && c.args?.includes("up")));

  const config = await loadConfig(root);
  assert.equal(config.engine, "podman");
  await rm(root, { recursive: true, force: true });
});

test("run install with --engine podman and --access host-root fails with clear error", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  const stdout = capture();
  const stderr = capture();

  await assert.rejects(
    async () => {
      await run(["install", "--engine", "podman", "--access", "host-root", "--no-open"], {
        env: { SPACEAPP_HOME: root },
        platform: "linux",
        arch: "x64",
        stdout: stdout.stream,
        stderr: stderr.stream,
        stdin: ttyStdin(...FRESH_APPROVALS),
        inspectResources: async () => ({
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
          freeDiskBytes: 40 * 1024 ** 3
        }),
        execute: async () => 0
      });
    },
    /Host-root access is not supported with the Podman container engine/
  );

  await rm(root, { recursive: true, force: true });
});

test("run doctor on podman installation verifies podman probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  const stdout = capture();
  const stderr = capture();

  const config = createDefaultConfig({ version: "1.1.5", profile: "small", accessMode: "isolated", engine: "podman" });
  await saveConfig(root, config);

  const calls = [];
  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    arch: "x64",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin(),
    inspectResources: async () => ({
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 ** 3,
      freeDiskBytes: 40 * 1024 ** 3
    }),
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.command === "podman" && spec.args?.includes("info")) {
        io.stdout?.write(JSON.stringify({
          version: { Version: "5.2.0" },
          host: { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"] }
        }));
        return 0;
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.match(stdout.value(), /PASS Podman CLI: available/);
  assert.match(stdout.value(), /PASS Podman Compose: available/);
  assert.match(stdout.value(), /PASS Podman Engine: available/);

  await rm(root, { recursive: true, force: true });
});

test("resolveInstallEngine rejects switching engine when existing config omits engine field", () => {
  const legacyDockerConfig = createDefaultConfig({ version: "1.1.5", profile: "small", accessMode: "isolated" });
  assert.equal(legacyDockerConfig.engine, undefined);
  assert.equal(configEngine(legacyDockerConfig), "docker");
  assert.throws(
    () => resolveInstallEngine("podman", configEngine(legacyDockerConfig)),
    /Switching container engines on an existing installation is not supported/
  );
});

test("renderWorkspaceCompose maps browser service userns_mode under podman", () => {
  const podmanConfig = {
    ...createDefaultConfig({ version: "1.1.5", profile: "standard", accessMode: "isolated", engine: "podman" }),
    workspaces: [{ id: "ws-12345678", name: "ws1", hostPath: "/tmp/ws1", containerPath: "/workspaces/ws1", readOnly: false }]
  };
  const yaml = renderWorkspaceCompose(podmanConfig);
  assert.match(yaml, /spaceapp-browser:\n\s*userns_mode:\s*"keep-id:uid=10001,gid=10001"/);
});

test("collectPodmanFacts rejects limits delegation when pids controller is absent", async () => {
  const facts = await collectPodmanFacts(async (spec, io) => {
    if (spec.args?.includes("info")) {
      io.stdout?.write(JSON.stringify({
        version: { Version: "5.2.0" },
        host: { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory"] }
      }));
      return 0;
    }
    return 0;
  });
  assert.equal(facts.limitsDelegated, false);
});
