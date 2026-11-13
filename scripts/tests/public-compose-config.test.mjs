import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createDefaultConfig, initializeInstallation, renderRuntimeEnv } from "../../packages/run-spaceapp/src/index.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

test("generated profiles and access modes have the expected merged Docker Compose model", async (context) => {
  try {
    await execFileAsync("docker", ["compose", "version"], { timeout: 10_000 });
  } catch {
    context.skip("Docker Compose is unavailable");
    return;
  }

  for (const [profile, accessMode] of [
    ["light", "isolated"],
    ["light", "host-root"],
    ["standard", "isolated"],
    ["standard", "host-root"],
    ["small", "isolated"]
  ]) {
    const installation = await mkdtemp(
      join(tmpdir(), `spaceapp-compose-${profile}-${accessMode}-`)
    );
    try {
      await initializeInstallation(installation, {
        version: "0.1.0",
        profile,
        accessMode,
        templateDir: join(root, "packages", "run-spaceapp", "templates")
      });
      const commonArgs = [
        "compose",
        "--project-directory", installation,
        "--env-file", join(installation, "runtime.env"),
        "-f", join(installation, "compose.yml"),
        "-f", join(installation, "compose.workspaces.yml"),
        "-f", join(installation, "compose.host-access.yml"),
        ...(profile !== "small" ? ["--profile", "standard"] : [])
      ];
      const { stdout, stderr } = await execFileAsync("docker", [
        ...commonArgs,
        "config",
        "--format",
        "json"
      ], {
        timeout: 30_000,
        maxBuffer: 64 * 1024
      });
      const services = await execFileAsync("docker", [...commonArgs, "config", "--services"], {
        timeout: 30_000,
        maxBuffer: 16 * 1024
      });

      assert.equal(stderr, "");
      const model = JSON.parse(stdout);
      const core = model.services["spaceapp-core"];
      const cli = model.services["spaceapp-cli"];
      assert.equal(core.entrypoint ?? null, null, "startup must inherit the image entrypoint without rewriting compiled code");
      assert.equal(core.environment.SPACE_PUBLIC_DISTRIBUTION, "true");
      assert.equal(core.environment.SPACE_AGENT_TOOLS_WRITER, "disabled");
      // Nous's turns run in spaceapp-cli and call their tools back on the compose network.
      assert.equal(core.environment.SPACE_CLI_API_BASE_URL, "http://spaceapp-core:4911");
      assert.equal(
        [core, cli].filter((service) =>
          service.volumes.some((volume) => volume.target === "/workspaces")
        ).length,
        2,
        "core and CLI must share the persistent workspace volume"
      );
      assert.equal(
        services.stdout.split(/\r?\n/).includes("spaceapp-browser"),
        profile !== "small" // light keeps one browser (light browser step 6)
      );
      assert.equal(
        core.environment.SPACE_BROWSER_SESSIONS_ENABLED,
        profile !== "small" ? "true" : "false"
      );
      // INT5-C-F3: the browser never mounts the data volume; core waits for the one-shot copy of earlier browser data.
      assert.equal(model.services["spaceapp-browser"]?.volumes.some((volume) => volume.source === "spaceapp-data") ?? false, false);
      assert.equal(core.depends_on["browser-data-init"].condition, "service_completed_successfully");
      assert.equal(typeof core.mem_limit, "string");
      assert.equal(typeof core.cpus, "number");

      const coreHost = core.volumes.find((volume) => volume.target === "/host");
      const cliHost = cli.volumes.find((volume) => volume.target === "/host");
      if (accessMode === "host-root") {
        assert.deepEqual(
          {
            type: coreHost.type,
            source: coreHost.source,
            target: coreHost.target,
            read_only: coreHost.read_only,
            propagation: coreHost.bind?.propagation
          },
          {
            type: "bind",
            source: "/",
            target: "/host",
            read_only: true,
            propagation: "rslave"
          }
        );
        assert.equal(cliHost.type, "bind");
        assert.equal(cliHost.source, "/");
        assert.equal(cliHost.target, "/host");
        assert.notEqual(cliHost.read_only, true);
        assert.equal(cliHost.bind?.propagation, "rslave");
        assert.equal(core.environment.SPACE_CLI_WORKSPACE_ROOT, "/host");
        assert.equal(cli.environment.SPACEAPP_CLI_HOST_ROOT_ACCESS, "true");
      } else {
        assert.equal(coreHost, undefined);
        assert.equal(cliHost, undefined);
        assert.equal(core.environment.SPACE_CLI_WORKSPACE_ROOT, "/workspaces");
        assert.equal(cli.environment.SPACEAPP_CLI_HOST_ROOT_ACCESS, undefined);
      }
    } finally {
      await rm(installation, { recursive: true, force: true });
    }
  }
});

test("SpaceApp images resolve to the version tag, plus the pinned digest when the package carries a lock", async (context) => {
  try {
    await execFileAsync("docker", ["compose", "version"], { timeout: 10_000 });
  } catch {
    context.skip("Docker Compose is unavailable");
    return;
  }
  const installation = await mkdtemp(join(tmpdir(), "spaceapp-compose-digest-"));
  try {
    await initializeInstallation(installation, { version: "0.1.0", profile: "standard", accessMode: "isolated", templateDir: join(root, "packages", "run-spaceapp", "templates") });
    const images = async () => {
      const { stdout } = await execFileAsync("docker", ["compose", "--project-directory", installation, "--env-file", join(installation, "runtime.env"),
        "-f", join(installation, "compose.yml"), "--profile", "standard", "config", "--format", "json"], { timeout: 30_000, maxBuffer: 64 * 1024 });
      const services = JSON.parse(stdout).services;
      return ["core", "cli", "browser"].map((target) => services[`spaceapp-${target}`].image);
    };
    assert.deepEqual(await images(), ["core", "cli", "browser"].map((target) => `ghcr.io/oll4com/spaceapp-${target}:0.1.0`));
    const digests = { core: `sha256:${"a".repeat(64)}`, cli: `sha256:${"b".repeat(64)}`, browser: `sha256:${"c".repeat(64)}` };
    await writeFile(join(installation, "runtime.env"), renderRuntimeEnv(createDefaultConfig({ version: "0.1.0", profile: "standard" }),
      { schemaVersion: 1, runtimeVersion: "0.1.0", images: digests }));
    assert.deepEqual(await images(), ["core", "cli", "browser"].map((target) => `ghcr.io/oll4com/spaceapp-${target}:0.1.0@${digests[target]}`));
  } finally {
    await rm(installation, { recursive: true, force: true });
  }
});
