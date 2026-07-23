import assert from "node:assert/strict";
import test from "node:test";
import {
  composeCommand,
  renderRuntimeEnv,
  renderWorkspaceCompose
} from "../src/index.mjs";

const home = "/tmp/spaceapp-home";
const config = {
  schemaVersion: 1,
  version: "0.1.0-alpha.1",
  previousVersion: null,
  bindHost: "127.0.0.1",
  port: 4911,
  telemetry: false,
  profile: "full",
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
    composeCommand("up", "/tmp/another-spaceapp-home").args[2],
    "different installation roots must use different Compose projects"
  );
  assert.deepEqual(composeCommand("syncCredentials", home).args.slice(-5), [
    "up", "-d", "--no-deps", "--force-recreate", "spaceapp-cli"
  ]);
  assert.deepEqual(composeCommand("rotateOwnerSetupToken", home).args.slice(-8), [
    "exec", "-T", "--user", "10001:10001", "spaceapp-core",
    "node", "scripts/rotate-owner-setup-token.mjs", "--stdin"
  ]);
  assert.throws(() => composeCommand("arbitrary", home), /unsupported/i);
});

test("compose project identity is stable for the same installation root", () => {
  assert.deepEqual(composeCommand("up", home), {
    command: "docker",
    args: [
      "compose",
      "--project-name", composeCommand("up", home).args[2],
      "--project-directory", home,
      "--env-file", `${home}/runtime.env`,
      "-f", `${home}/compose.yml`,
      "-f", `${home}/compose.workspaces.yml`,
      "up", "-d", "--remove-orphans"
    ]
  });
});

test("runtime env contains only non-secret runtime settings", () => {
  const env = renderRuntimeEnv(config);
  assert.match(env, /^SPACEAPP_IMAGE_TAG=0\.1\.0-alpha\.1$/m);
  assert.match(env, /^SPACEAPP_BIND_HOST=127\.0\.0\.1$/m);
  assert.match(env, /^SPACEAPP_TELEMETRY=false$/m);
  assert.doesNotMatch(env, /password|secret|token|api.?key/i);
});

test("workspace override renders explicit bind mounts without Docker socket access", () => {
  const compose = renderWorkspaceCompose(config);
  assert.match(compose, /type: bind/);
  assert.match(compose, /source: "\/home\/alice\/project"/);
  assert.match(compose, /target: "\/workspaces\/project"/);
  assert.doesNotMatch(compose, /docker\.sock/);
});
