import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  composeCommand,
  renderRuntimeEnv,
  renderWorkspaceCompose
} from "../src/index.mjs";
import { inspectSystemResources } from "../src/index.mjs";

const home = resolve(tmpdir(), "spaceapp-home");
test("inspectSystemResources walks up when the install root and its parent do not exist", async () => {
  // Regression for the Linux clean-room finding: on a fresh Linux home the
  // install root's parent (~/.config) does not exist yet, and statfs on a
  // missing path threw ENOENT. The nearest existing ancestor must be used.
  const missingRoot = resolve(tmpdir(), `spaceapp-missing-${process.pid}-${Date.now()}`, ".config", "spaceapp");
  const resources = await inspectSystemResources(missingRoot);
  assert.ok(Number.isFinite(resources.freeDiskBytes));
  assert.ok(resources.freeDiskBytes > 0);
  assert.ok(Number.isFinite(resources.cpuCount));
  assert.ok(Number.isFinite(resources.totalMemoryBytes));
});
const config = {
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
    removeBrowser.args.slice(-8),
    ["--profile", "standard", "--profile", "workflows", "rm", "--stop", "--force", "spaceapp-browser"]
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
      "--profile", "workflows",
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

test("compose activates the browser for the standard and light profiles, never for small", () => {
  const withBrowser = ["--profile", "standard", "--profile", "workflows", "up", "-d", "--remove-orphans"];
  assert.deepEqual(composeCommand("up", home, { profile: "standard" }).args.slice(-7), withBrowser);
  // Light browser step 6: the 2 GB class keeps one managed Chromium.
  assert.deepEqual(composeCommand("up", home, { profile: "light" }).args.slice(-7), withBrowser);
  assert.equal(composeCommand("up", home, { profile: "small" }).args.includes("standard"), false);
  assert.throws(() => composeCommand("up", home, { profile: "full" }), /small, medium, large, light, or standard/i);
});

test("runtime env applies bounded light and standard resource settings without secrets", () => {
  const standard = renderRuntimeEnv(config, undefined, {}, 64 * 1024 ** 3);
  const light = renderRuntimeEnv({ ...config, profile: "light" }, undefined, {}, 64 * 1024 ** 3);

  assert.match(standard, /^SPACEAPP_IMAGE_TAG=0\.1\.0$/m);
  assert.match(standard, /^SPACEAPP_BIND_HOST=127\.0\.0\.1$/m);
  assert.match(standard, /^SPACEAPP_TELEMETRY=false$/m);
  // A config written before 1.1.5 keeps every optional module; new installs start with none.
  assert.match(standard, /^SPACEAPP_OPTIONAL_MODULES=all$/m);
  // Without the env line the compose file falls back to the code's own default, none (1.2.0, operator 5/11).
  const compose = readFileSync(new URL("../templates/compose.yml", import.meta.url), "utf8");
  assert.match(compose, /SPACE_OPTIONAL_MODULES: "\$\{SPACEAPP_OPTIONAL_MODULES:-none\}"/);
  assert.match(renderRuntimeEnv({ ...config, optionalModules: "job-copilot,games" }), /^SPACEAPP_OPTIONAL_MODULES=job-copilot,games$/m);
  assert.throws(() => renderRuntimeEnv({ ...config, optionalModules: "games; rm -rf /" }), /optionalModules/);
  assert.match(standard, /^SPACEAPP_BROWSER_ENABLED=true$/m);
  assert.match(standard, /^SPACEAPP_CORE_MEMORY_LIMIT=4g$/m);
  assert.match(light, /^SPACEAPP_BROWSER_ENABLED=true$/m);
  assert.match(light, /^SPACEAPP_CORE_MEMORY_LIMIT=2g$/m);
  assert.match(light, /^SPACEAPP_CLI_MEMORY_LIMIT=2g$/m);
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
  assert.equal(withoutCompanions.args.includes("companions"), false);
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

test("the CLI settings export skips tar when no settings file exists yet (1.1.8: no 'empty archive' noise in backup)", {
  skip: process.platform === "win32" ? "runs the container's POSIX shell script" : false
}, async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const args = composeCommand("exportCliSettings", home).args;
  const script = args[args.indexOf("-c") + 1];
  const providers = await mkdtemp(join(tmpdir(), "spaceapp-cli-settings-"));
  const local = script.replace("/var/lib/spaceapp-cli/providers", providers);
  const none = spawnSync("sh", ["-c", local], { encoding: "utf8" });
  assert.equal(none.status, 3);
  assert.equal(none.stderr, "");
  await mkdir(join(providers, "codex"));
  await writeFile(join(providers, "codex", "config.toml"), "model = \"x\"\n");
  const listed = execFileSync("sh", ["-c", `${local} | tar -tzf -`], { encoding: "utf8" });
  assert.equal(listed.trim(), "codex/config.toml");
});

test("only the core gets the pane bridge secret; no other container mounts the secrets folder (1.2.0 review secevt:TGmxc9yQu9y_)", () => {
  const compose = readFileSync(new URL("../templates/compose.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n"); // Windows checkouts carry CRLF
  const services = compose.slice(compose.indexOf("services:\n"), compose.search(/^secrets:$/m)).split(/^  (?=[a-z][\w-]*:$)/m).slice(1);
  const holders = services.filter((block) => block.includes("agent-token-secret")).map((block) => block.split(":")[0]);
  assert.deepEqual(holders, ["spaceapp-core"]);
  for (const block of services) assert.doesNotMatch(block, /\.\/secrets(?!\/providers:)/, block.split(":")[0]);
});
