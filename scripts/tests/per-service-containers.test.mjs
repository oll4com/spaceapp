import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareContainerTarget } from "../prepare-container-target.mjs";

test("prepareContainerTarget rejects missing arguments", async () => {
  await assert.rejects(
    () => prepareContainerTarget([]),
    /Usage: prepare-container-target\.mjs/
  );
  await assert.rejects(
    () => prepareContainerTarget(["--target", "core"]),
    /Usage: prepare-container-target\.mjs/
  );
});

test("prepareContainerTarget prepares pruned cli target closure", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "spaceapp-test-cli-"));
  try {
    await prepareContainerTarget(["--target", "cli", "--arch", "amd64", "--dest", tempDir]);

    assert.ok(existsSync(join(tempDir, "package.json")), "root package.json must exist");
    assert.ok(existsSync(join(tempDir, "packages", "cli-host", "package.json")), "cli-host package.json must exist");
    assert.ok(existsSync(join(tempDir, "node_modules", "@space", "cli-host")), "@space/cli-host symlink must exist");
    assert.ok(!existsSync(join(tempDir, "apps")), "apps directory must NOT be present in cli image");
    assert.ok(!existsSync(join(tempDir, "packages", "db")), "packages/db must NOT be present in cli image");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("prepareContainerTarget prepares pruned browser target closure", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "spaceapp-test-browser-"));
  try {
    await prepareContainerTarget(["--target", "browser", "--arch", "amd64", "--dest", tempDir]);

    assert.ok(existsSync(join(tempDir, "apps", "api", "package.json")), "apps/api package.json must exist");
    assert.ok(existsSync(join(tempDir, "packages", "browser-host")), "packages/browser-host must exist");
    assert.ok(existsSync(join(tempDir, "packages", "contracts")), "packages/contracts must exist");
    assert.ok(existsSync(join(tempDir, "packages", "db")), "packages/db must exist");
    assert.ok(existsSync(join(tempDir, "packages", "runtime")), "packages/runtime must exist");
    assert.ok(existsSync(join(tempDir, "packages", "memory-graph")), "packages/memory-graph must exist");

    assert.ok(!existsSync(join(tempDir, "apps", "web")), "apps/web must NOT be present in browser image");
    assert.ok(!existsSync(join(tempDir, "apps", "worker")), "apps/worker must NOT be present in browser image");
    assert.ok(!existsSync(join(tempDir, "packages", "cli-host")), "packages/cli-host must NOT be present in browser image");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("prepareContainerTarget prepares core target closure and excludes cli-host", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "spaceapp-test-core-"));
  try {
    await prepareContainerTarget(["--target", "core", "--arch", "amd64", "--dest", tempDir]);

    assert.ok(existsSync(join(tempDir, "apps", "api")), "apps/api must exist in core");
    assert.ok(existsSync(join(tempDir, "apps", "worker")), "apps/worker must exist in core");
    assert.ok(existsSync(join(tempDir, "apps", "web")), "apps/web must exist in core");
    assert.ok(existsSync(join(tempDir, "packages", "db")), "packages/db must exist in core");

    assert.ok(!existsSync(join(tempDir, "node_modules", "node-pty")), "node-pty must NOT be present in core image");
    assert.ok(existsSync(join(tempDir, "packages", "cli-host")), "packages/cli-host client runtime must exist in core for apps/api");
    assert.ok(!existsSync(join(tempDir, "packages", "run-spaceapp")), "packages/run-spaceapp must NOT be present in core image");
    assert.ok(existsSync(join(tempDir, "scripts", "rotate-owner-setup-token.mjs")), "rotate-owner-setup-token.mjs must exist in core");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
