import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  DEFAULT_ENGINE,
  ENGINE_IDS,
  MIN_PODMAN_VERSION,
  describeEngine,
  detectEngine,
  engineCli,
  engineFactsSummary,
  engineInstallHelp,
  resolveEngine
} from "../src/engine.mjs";
import {
  composeCommand,
  renderWorkspaceCompose
} from "../src/index.mjs";

const home = resolve(tmpdir(), "spaceapp-engine-home");

function makeExecute(handlers) {
  return async (spec, io) => {
    const key = `${spec.command} ${(spec.args ?? []).join(" ")}`;
    const handler = handlers[key];
    if (!handler) {
      return 127;
    }
    if (handler.stdout !== undefined) {
      io?.stdout?.write(handler.stdout);
    }
    if (handler.stderr !== undefined) {
      io?.stderr?.write(handler.stderr);
    }
    return handler.code ?? 0;
  };
}

test("resolveEngine defaults to docker and rejects unknown engines", () => {
  assert.equal(DEFAULT_ENGINE, "docker");
  assert.deepEqual(ENGINE_IDS, ["docker", "podman"]);
  assert.equal(resolveEngine(undefined), "docker");
  assert.equal(resolveEngine(null), "docker");
  assert.equal(resolveEngine({}), "docker");
  assert.equal(resolveEngine({ engine: "docker" }), "docker");
  assert.equal(resolveEngine({ engine: "podman" }), "podman");
  assert.throws(() => resolveEngine({ engine: "rancher" }), /Unsupported container engine "rancher"/);
});

test("engineCli and describeEngine map ids to binaries and display names", () => {
  assert.equal(engineCli("docker"), "docker");
  assert.equal(engineCli("podman"), "podman");
  assert.equal(describeEngine("docker"), "Docker");
  assert.equal(describeEngine("podman"), "Podman");
});

test("detectEngine reports a healthy docker install with full facts", async () => {
  const execute = makeExecute({
    "docker --version": { stdout: "Docker version 24.0.7, build afdd53b\n" },
    "docker compose version": { stdout: "Docker Compose version v2.24.0\n" },
    "docker info --format {{json .}}": {
      stdout: JSON.stringify({
        ServerVersion: "24.0.7",
        NCPU: 8,
        MemTotal: 16777216000,
        Architecture: "x86_64",
        DockerRootDir: "/var/lib/docker",
        CgroupVersion: "2"
      })
    }
  });

  const facts = await detectEngine("docker", { execute });

  assert.equal(facts.engine, "docker");
  assert.deepEqual(facts.cli, { ok: true, version: "24.0.7" });
  assert.deepEqual(facts.compose, { ok: true, version: "2.24.0", provider: "plugin" });
  assert.deepEqual(facts.daemon, { ok: true });
  assert.equal(facts.rootless, null);
  assert.equal(facts.cgroupVersion, "v2");
  assert.equal(facts.cpuCount, 8);
  assert.equal(facts.memoryBytes, 16777216000);
  assert.equal(facts.arch, "x86_64");
  assert.equal(facts.storageRoot, "/var/lib/docker");
  assert.equal(facts.versionOk, true);
});

test("detectEngine reports a missing docker CLI (exit 127)", async () => {
  const execute = makeExecute({});
  const facts = await detectEngine("docker", { execute });

  assert.equal(facts.cli.ok, false);
  assert.equal(facts.cli.version, null);
  assert.equal(facts.compose.ok, false);
  assert.equal(facts.compose.provider, null);
  assert.equal(facts.daemon.ok, false);
  assert.equal(facts.versionOk, false);
});

test("detectEngine reports docker compose missing while daemon is fine", async () => {
  const execute = makeExecute({
    "docker --version": { stdout: "Docker version 24.0.7, build afdd53b\n" },
    "docker compose version": { code: 127 },
    "docker info --format {{json .}}": {
      stdout: JSON.stringify({ NCPU: 4, MemTotal: 8000000000, Architecture: "aarch64", DockerRootDir: "/var/lib/docker" })
    }
  });
  const facts = await detectEngine("docker", { execute });

  assert.equal(facts.cli.ok, true);
  assert.equal(facts.compose.ok, false);
  assert.equal(facts.compose.provider, null);
  assert.equal(facts.daemon.ok, true);
  assert.equal(facts.cgroupVersion, null);
  assert.equal(facts.arch, "aarch64");
});

test("detectEngine reports a docker daemon that is down", async () => {
  const execute = makeExecute({
    "docker --version": { stdout: "Docker version 24.0.7, build afdd53b\n" },
    "docker compose version": { stdout: "Docker Compose version v2.24.0\n" },
    "docker info --format {{json .}}": { code: 1, stderr: "Cannot connect to the Docker daemon\n" }
  });
  const facts = await detectEngine("docker", { execute });

  assert.equal(facts.cli.ok, true);
  assert.equal(facts.compose.ok, true);
  assert.equal(facts.daemon.ok, false);
  assert.equal(facts.cpuCount, null);
  assert.equal(facts.memoryBytes, null);
  assert.equal(facts.storageRoot, null);
});

test("detectEngine parses rootless podman facts and meets the minimum version", async () => {
  const execute = makeExecute({
    "podman --version": { stdout: "podman version 5.2.1\n" },
    "podman compose version": { stdout: "Docker Compose version v2.27.1\n" },
    "podman info --format json": {
      stdout: JSON.stringify({
        version: { Version: "5.2.1" },
        host: {
          security: { rootless: true },
          cgroupVersion: "v2",
          cpus: 4,
          memTotal: 8000000000,
          arch: "amd64"
        },
        store: { graphRoot: "/home/alice/.local/share/containers/storage" }
      })
    }
  });
  const facts = await detectEngine("podman", { execute });

  assert.equal(facts.engine, "podman");
  assert.deepEqual(facts.cli, { ok: true, version: "5.2.1" });
  assert.deepEqual(facts.compose, { ok: true, version: "2.27.1", provider: "plugin" });
  assert.deepEqual(facts.daemon, { ok: true });
  assert.equal(facts.rootless, true);
  assert.equal(facts.cgroupVersion, "v2");
  assert.equal(facts.cpuCount, 4);
  assert.equal(facts.memoryBytes, 8000000000);
  assert.equal(facts.arch, "amd64");
  assert.equal(facts.storageRoot, "/home/alice/.local/share/containers/storage");
  assert.equal(facts.versionOk, true);
});

test("detectEngine records a rootful podman with cgroup v1", async () => {
  const execute = makeExecute({
    "podman --version": { stdout: "podman version 5.0.0\n" },
    "podman compose version": { stdout: "podman-compose version: 1.0.6\n" },
    "podman info --format json": {
      stdout: JSON.stringify({
        version: { Version: "5.0.0" },
        host: {
          security: { rootless: false },
          cgroupVersion: "v1",
          cpus: 2,
          memTotal: 4000000000,
          arch: "arm64"
        },
        store: { graphRoot: "/var/lib/containers/storage" }
      })
    }
  });
  const facts = await detectEngine("podman", { execute });

  assert.equal(facts.rootless, false);
  assert.equal(facts.cgroupVersion, "v1");
  assert.equal(facts.cpuCount, 2);
  assert.equal(facts.arch, "arm64");
  assert.equal(facts.versionOk, true);
  assert.deepEqual(
    engineFactsSummary(facts),
    [
      "engine: podman",
      "version: 5.0.0",
      "rootless: no (rootful)",
      "cgroup: v1",
      "limits: CPU/memory limits cannot be enforced (cgroup v1)"
    ]
  );
});

test("detectEngine falls back to podman-compose when podman compose is missing", async () => {
  const execute = makeExecute({
    "podman --version": { stdout: "podman version 5.2.1\n" },
    "podman compose version": { code: 1, stderr: "compose provider not found\n" },
    "podman-compose --version": { stdout: "podman-compose version 1.0.6\n" },
    "podman info --format json": {
      stdout: JSON.stringify({
        version: { Version: "5.2.1" },
        host: { security: { rootless: true }, cgroupVersion: "v2", cpus: 4, memTotal: 8000000000, arch: "amd64" },
        store: { graphRoot: "/home/alice/.local/share/containers/storage" }
      })
    }
  });
  const facts = await detectEngine("podman", { execute });

  assert.deepEqual(facts.compose, { ok: true, version: "1.0.6", provider: "podman-compose" });
  assert.equal(facts.versionOk, true);
});

test("detectEngine rejects a podman below the minimum version", async () => {
  const execute = makeExecute({
    "podman --version": { stdout: "podman version 4.9.3\n" },
    "podman compose version": { stdout: "Docker Compose version v2.24.0\n" },
    "podman info --format json": {
      stdout: JSON.stringify({
        version: { Version: "4.9.3" },
        host: { security: { rootless: true }, cgroupVersion: "v2", cpus: 4, memTotal: 8000000000, arch: "amd64" },
        store: { graphRoot: "/home/alice/.local/share/containers/storage" }
      })
    }
  });
  const facts = await detectEngine("podman", { execute });

  assert.equal(facts.cli.ok, true);
  assert.equal(facts.cli.version, "4.9.3");
  assert.equal(facts.versionOk, false);
});

test("detectEngine reports a missing podman CLI", async () => {
  const execute = makeExecute({});
  const facts = await detectEngine("podman", { execute });

  assert.equal(facts.cli.ok, false);
  assert.equal(facts.compose.ok, false);
  assert.equal(facts.compose.provider, null);
  assert.equal(facts.daemon.ok, false);
  assert.equal(facts.rootless, null);
  assert.equal(facts.versionOk, false);
});

test("composeCommand builds podman compose or docker compose from the engine", () => {
  const docker = composeCommand("up", home);
  assert.equal(docker.command, "docker");
  assert.equal(docker.args[0], "compose");
  assert.deepEqual(docker.args.slice(-3), ["up", "-d", "--remove-orphans"]);

  const podman = composeCommand("up", home, { engine: "podman" });
  assert.equal(podman.command, "podman");
  assert.equal(podman.args[0], "compose");
  assert.deepEqual(podman.args, ["compose", ...docker.args.slice(1)]);

  const podmanViaConfig = composeCommand("up", home, { config: { engine: "podman" } });
  assert.equal(podmanViaConfig.command, "podman");
  assert.equal(podmanViaConfig.args[0], "compose");

  assert.throws(() => composeCommand("up", home, { engine: "rancher" }), /Unsupported container engine/);
});

const baseConfig = {
  schemaVersion: 4,
  version: "0.1.0",
  previousVersion: null,
  bindHost: "127.0.0.1",
  port: 4911,
  telemetry: false,
  profile: "standard",
  accessMode: "isolated",
  companionsEnabled: false,
  workspaces: [
    {
      id: "project-a1b2c3d4",
      name: "project",
      hostPath: "/home/alice/project",
      containerPath: "/workspaces/project",
      readOnly: false
    },
    {
      id: "notes-a1b2c3d4",
      name: "notes",
      hostPath: "/home/alice/notes",
      containerPath: "/workspaces/notes",
      readOnly: true
    }
  ]
};

test("renderWorkspaceCompose keeps long bind syntax for docker", () => {
  const compose = renderWorkspaceCompose(baseConfig);
  assert.match(compose, /type: bind/);
  assert.match(compose, /source: "\/home\/alice\/project"/);
  assert.match(compose, /target: "\/workspaces\/project"/);
  assert.match(compose, /read_only: false/);
  assert.match(compose, /read_only: true/);
  assert.doesNotMatch(compose, /:\/workspaces\/project:z/);
});

test("renderWorkspaceCompose emits SELinux :z mounts for podman", () => {
  const compose = renderWorkspaceCompose({ ...baseConfig, engine: "podman" });
  assert.doesNotMatch(compose, /type: bind/);
  assert.match(compose, /- "\/home\/alice\/project:\/workspaces\/project:z"/);
  assert.match(compose, /- "\/home\/alice\/notes:\/workspaces\/notes:ro,z"/);
});

test("renderWorkspaceCompose emits SELinux :z mounts for podman user workspaces", () => {
  const compose = renderWorkspaceCompose({
    ...baseConfig,
    engine: "podman",
    users: [{ id: "user:Bob12345", workspaces: baseConfig.workspaces }]
  });
  const userService = compose.slice(compose.indexOf("spaceapp-cli-"));
  assert.match(userService, /- "\/home\/alice\/project:\/workspaces\/project:z"/);
  assert.match(userService, /- "\/home\/alice\/notes:\/workspaces\/notes:ro,z"/);
  assert.doesNotMatch(userService, /type: bind/);
});

test("engineInstallHelp is per-platform and never auto-installs podman", () => {
  assert.match(engineInstallHelp("docker", "linux"), /Docker Engine and Compose automatically/);
  assert.match(engineInstallHelp("podman", "darwin"), /brew install podman/);
  assert.match(engineInstallHelp("podman", "linux", { ID: "fedora" }), /dnf install -y podman podman-compose/);
  assert.match(engineInstallHelp("podman", "linux", { ID: "ubuntu" }), /apt install -y podman/);
  assert.match(engineInstallHelp("podman", "linux", { ID: "opensuse-leap" }), /zypper install -y podman/);
  assert.match(engineInstallHelp("podman", "linux"), /Podman 5 or newer/);
  assert.doesNotMatch(engineInstallHelp("podman", "darwin"), /install -y/);
});

test("engine constants are exported and match the spec", () => {
  assert.equal(MIN_PODMAN_VERSION, "5.0.0");
});
