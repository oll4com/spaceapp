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

test("generated launcher files pass Docker Compose interpolation and validation", async (context) => {
  try {
    await execFileAsync("docker", ["compose", "version"], { timeout: 10_000 });
  } catch {
    context.skip("Docker Compose is unavailable");
    return;
  }

  const installation = await mkdtemp(join(tmpdir(), "spaceapp-compose-"));
  try {
    await initializeInstallation(installation, {
      version: "0.1.0-alpha.1",
      templateDir: join(root, "packages", "run-spaceapp", "templates")
    });
    const { stdout, stderr } = await execFileAsync("docker", [
      "compose",
      "--project-directory", installation,
      "--env-file", join(installation, "runtime.env"),
      "-f", join(installation, "compose.yml"),
      "-f", join(installation, "compose.workspaces.yml"),
      "config"
    ], {
      timeout: 30_000,
      maxBuffer: 64 * 1024
    });
    assert.equal(stderr, "");
    assert.equal(
      stdout.match(/target: \/workspaces$/gm)?.length,
      2,
      "core and CLI must share the persistent workspace volume"
    );
  } finally {
    await rm(installation, { recursive: true, force: true });
  }
});
