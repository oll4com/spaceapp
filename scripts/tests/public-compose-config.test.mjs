import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { initializeInstallation } from "../../packages/run-spaceapp/src/index.mjs";

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
    ["standard", "host-root"]
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
        ...(profile === "standard" ? ["--profile", "standard"] : [])
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
      assert.equal(
        [core, cli].filter((service) =>
          service.volumes.some((volume) => volume.target === "/workspaces")
        ).length,
        2,
        "core and CLI must share the persistent workspace volume"
      );
      assert.equal(
        services.stdout.split(/\r?\n/).includes("spaceapp-browser"),
        profile === "standard"
      );
      assert.equal(
        core.environment.SPACE_BROWSER_SESSIONS_ENABLED,
        profile === "standard" ? "true" : "false"
      );
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
