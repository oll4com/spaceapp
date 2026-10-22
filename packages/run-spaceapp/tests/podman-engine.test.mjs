import test from "node:test";
import assert from "node:assert/strict";
import { composeCommand, createDefaultConfig, prepareInstallation, validateConfig } from "../src/index.mjs";
import { executeCommand } from "../src/cli.mjs";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("composeCommand generates podman compose commands when engine is podman", () => {
  const root = "/tmp/spaceapp-test";
  const cmd = composeCommand("up", root, { engine: "podman", profile: "small" });
  assert.equal(cmd.command, "podman");
  assert.equal(cmd.args[0], "compose");
  assert.ok(cmd.args.includes("up"));
  assert.ok(cmd.args.includes("-d"));
});

test("composeCommand defaults to docker when engine is unspecified", () => {
  const root = "/tmp/spaceapp-test";
  const cmd = composeCommand("status", root, { profile: "small" });
  assert.equal(cmd.command, "docker");
  assert.equal(cmd.args[0], "compose");
  assert.ok(cmd.args.includes("ps"));
});

test("validateConfig accepts engine: podman and engine: docker", () => {
  const cfg = createDefaultConfig({ version: "1.1.7", engine: "podman" });
  assert.equal(cfg.engine, "podman");
  assert.doesNotThrow(() => validateConfig(cfg));

  const invalid = { ...cfg, engine: "containerd" };
  assert.throws(() => validateConfig(invalid), /engine must be docker or podman/);
});

test("prepareInstallation refuses switching engines on existing installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  const { config } = await prepareInstallation(root, { version: "1.1.7", engine: "docker" });
  const { saveConfig } = await import("../src/index.mjs");
  await saveConfig(root, config);

  await assert.rejects(
    () => prepareInstallation(root, { version: "1.1.7", engine: "podman" }),
    /Switching container engines on an existing installation from docker to podman is refused/
  );
});

test("executeCommand allowlists podman executable", () => {
  const promise = executeCommand({ command: "podman", args: ["--version"] });
  assert.ok(promise instanceof Promise);
});
