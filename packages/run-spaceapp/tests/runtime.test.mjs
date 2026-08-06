import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  composeCommand,
  renderRuntimeEnv,
  renderWorkspaceCompose
} from "../src/index.mjs";

const home = resolve(tmpdir(), "spaceapp-home");
const config = {
  schemaVersion: 3,
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
    }
  ]
};

test("compose actions map to fixed commands and never invoke a shell", () => {
  const command = composeCommand("up", home);
  assert.equal(command.command, "docker");
  assert.deepEqual(command.args.slice(0, 5), [
    "compose",
    "--project-name", command.args[2],
    "--project-directory", home
  ]);
  assert.match(command.args[2], /^spaceapp-[a-f0-9]{12}$/);
  assert.deepEqual(command.args.slice(-3), ["up", "-d", "--remove-orphans"]);
  assert.notEqual(
    command.args[2],
    composeCommand("up", resolve(tmpdir(), "another-spaceapp-home")).args[2],
    "different installation roots must use different Compose projects"
  );
  assert.deepEqual(composeCommand("syncCredentials", home).args.slice(-5), [
    "up", "-d", "--no-deps", "--force-recreate", "spaceapp-cli"
  ]);
  assert.equal(
    composeCommand("pull", home).env,
    undefined,
    "pull must retain Docker Desktop's graphical logon session config"
  );
  assert.deepEqual(composeCommand("rotateOwnerSetupToken", home).args.slice(-8), [
    "exec", "-T", "--user", "10001:10001", "spaceapp-core",
    "node", "scripts/rotate-owner-setup-token.mjs", "--stdin"
  ]);
  const removeBrowser = composeCommand("removeBrowser", home, { profile: "standard" });
  assert.deepEqual(
    removeBrowser.args.slice(-6),
    ["--profile", "standard", "rm", "--stop", "--force", "spaceapp-browser"]
  );
  assert.equal(removeBrowser.args.includes("--volumes"), false);
  assert.throws(() => composeCommand("arbitrary", home), /unsupported/i);
});

test("compose project identity is stable for the same installation root", () => {
  assert.deepEqual(composeCommand("up", home), {
    command: "docker",
    args: [
      "compose",
      "--project-name", composeCommand("up", home).args[2],
      "--project-directory", home,
      "--env-file", join(home, "runtime.env"),
      "-f", join(home, "compose.yml"),
      "-f", join(home, "compose.workspaces.yml"),
      "-f", join(home, "compose.host-access.yml"),
      "--profile", "standard",
      "up", "-d", "--remove-orphans"
    ]
  });
});

test("compose can use staged state without changing the installation project identity", () => {
  const stagedStateRoot = resolve(tmpdir(), "spaceapp-staged-state");
  const command = composeCommand("pull", home, {
    profile: "light",
    stateRoot: stagedStateRoot
  });

  assert.equal(command.args[command.args.indexOf("--project-name") + 1], composeCommand("pull", home).args[2]);
  assert.equal(command.args[command.args.indexOf("--project-directory") + 1], home);
  assert.equal(command.args[command.args.indexOf("--env-file") + 1], join(stagedStateRoot, "runtime.env"));
  assert.equal(command.args.includes(join(home, "runtime.env")), false);
  assert.equal(command.args.includes(join(stagedStateRoot, "compose.host-access.yml")), true);
});

test("compose activates the optional browser only for the standard profile", () => {
  const standard = composeCommand("up", home, { profile: "standard" });
  const light = composeCommand("up", home, { profile: "light" });

  assert.deepEqual(standard.args.slice(-5), ["--profile", "standard", "up", "-d", "--remove-orphans"]);
  assert.equal(standard.args.includes("--profile"), true);
  assert.equal(light.args.includes("--profile"), false);
  assert.throws(() => composeCommand("up", home, { profile: "full" }), /light or standard/i);
});

test("runtime env applies bounded light and standard resource settings without secrets", () => {
  const standard = renderRuntimeEnv(config);
  const light = renderRuntimeEnv({ ...config, profile: "light" });

  assert.match(standard, /^SPACEAPP_IMAGE_TAG=0\.1\.0$/m);
  assert.match(standard, /^SPACEAPP_BIND_HOST=127\.0\.0\.1$/m);
  assert.match(standard, /^SPACEAPP_TELEMETRY=false$/m);
  assert.match(standard, /^SPACEAPP_BROWSER_ENABLED=true$/m);
  assert.match(standard, /^SPACEAPP_CORE_MEMORY_LIMIT=4g$/m);
  assert.match(light, /^SPACEAPP_BROWSER_ENABLED=false$/m);
  assert.match(light, /^SPACEAPP_CORE_MEMORY_LIMIT=2g$/m);
  assert.match(light, /^SPACEAPP_CLI_MEMORY_LIMIT=1536m$/m);
  assert.match(light, /^SPACEAPP_POSTGRES_MEMORY_LIMIT=768m$/m);
  assert.match(light, /^SPACEAPP_TEMPORAL_MEMORY_LIMIT=768m$/m);
  assert.doesNotMatch(`${standard}\n${light}`, /password|secret|token|api.?key/i);
});

test("compose activates the companions profile only when companions are enabled", () => {
  const withCompanions = composeCommand("up", home, {
    profile: "light",
    companionsEnabled: true
  });
  const withoutCompanions = composeCommand("up", home, {
    profile: "light",
    companionsEnabled: false
  });

  assert.equal(withCompanions.args.includes("--profile"), true);
  assert.deepEqual(
    withCompanions.args.slice(-5),
    ["--profile", "companions", "up", "-d", "--remove-orphans"]
  );
  assert.equal(withoutCompanions.args.includes("--profile"), false);
});

test("runtime env exposes the companions toggle without leaking credentials", () => {
  const enabled = renderRuntimeEnv({ ...config, companionsEnabled: true });
  const disabled = renderRuntimeEnv({ ...config, companionsEnabled: false });

  assert.match(enabled, /^SPACEAPP_COMPANIONS_ENABLED=true$/m);
  assert.match(disabled, /^SPACEAPP_COMPANIONS_ENABLED=false$/m);
  assert.doesNotMatch(`${enabled}\n${disabled}`, /password|secret|token|api.?key/i);
});

test("workspace override renders explicit bind mounts without Docker socket access", () => {
  const compose = renderWorkspaceCompose(config);
  assert.match(compose, /type: bind/);
  assert.match(compose, /source: "\/home\/alice\/project"/);
  assert.match(compose, /target: "\/workspaces\/project"/);
  assert.doesNotMatch(compose, /docker\.sock/);
});
