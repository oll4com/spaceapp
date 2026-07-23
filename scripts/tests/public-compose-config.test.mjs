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

test("generated light and standard profiles pass Docker Compose validation", async (context) => {
  try {
    await execFileAsync("docker", ["compose", "version"], { timeout: 10_000 });
  } catch {
    context.skip("Docker Compose is unavailable");
    return;
  }

  for (const profile of ["light", "standard"]) {
    const installation = await mkdtemp(join(tmpdir(), `spaceapp-compose-${profile}-`));
    try {
      await initializeInstallation(installation, {
        version: "0.1.0",
        profile,
        templateDir: join(root, "packages", "run-spaceapp", "templates")
      });
      const commonArgs = [
        "compose",
        "--project-directory", installation,
        "--env-file", join(installation, "runtime.env"),
        "-f", join(installation, "compose.yml"),
        "-f", join(installation, "compose.workspaces.yml"),
        ...(profile === "standard" ? ["--profile", "standard"] : [])
      ];
      const { stdout, stderr } = await execFileAsync("docker", [...commonArgs, "config"], {
        timeout: 30_000,
        maxBuffer: 64 * 1024
      });
      const services = await execFileAsync("docker", [...commonArgs, "config", "--services"], {
        timeout: 30_000,
        maxBuffer: 16 * 1024
      });

      assert.equal(stderr, "");
      assert.equal(
        stdout.match(/target: \/workspaces$/gm)?.length,
        2,
        "core and CLI must share the persistent workspace volume"
      );
      assert.equal(
        services.stdout.split(/\r?\n/).includes("spaceapp-browser"),
        profile === "standard"
      );
      assert.match(
        stdout,
        new RegExp(`SPACE_BROWSER_SESSIONS_ENABLED: "?${profile === "standard" ? "true" : "false"}"?`)
      );
      assert.match(stdout, /mem_limit: "?\d+"?/);
      assert.match(stdout, /cpus: \d/);
    } finally {
      await rm(installation, { recursive: true, force: true });
    }
  }
});
