import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BIND_HOST, CLI_WRAPPER_RUNTIMES, DEFAULT_PORTS, DROPPED_CORE_KEYS, DevStackError, INSTALLED_PORTS, PORT_ENV,
  buildCliHostEnvironment, buildCoreEnvironment, cliHostSocketPath, composeProjectName, interpolate, mapContainerPath,
  containerPathMap, packageBuildOrder, packageForPath, parsePort, readOpenCodePin, readPinnedImage, readPinnedImages,
  readServiceEnvironment, rebuildPlan, redact, renderCliWrapper, renderComposeFile, resolvePorts, stripAnsi
} from "../dev-stack-lib.mjs";

// npm run dev:stack (issue #65) takes its images, its core environment and its OpenCode version from the files the
// installed app is built from. These tests keep it in step with them and keep its guarantees: digests only,
// 127.0.0.1 only, never the installed app's ports, nothing written under /opt/spaceapp, no secret in the CLI host.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeText = readFileSync(join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml"), "utf8");
const dockerfileText = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const stateDir = "/home/dev/spaceapp/.dev-stack";
const secrets = { databaseUrl: "postgres://spaceapp:pw-0123456789@127.0.0.1:15432/spaceapp", sessionSecret: "session-0123456789abcdef" };

function coreEnvironment(overrides = {}) {
  return buildCoreEnvironment({
    composeText, repoRoot, stateDir, ports: DEFAULT_PORTS, secrets, socketPath: join(stateDir, "run", "cli-host.sock"),
    appVersion: "1.2.3", optionalModules: "all", ...overrides
  });
}

test("the root package.json runs the dev stack with npm run dev:stack, and .dev-stack/ is git-ignored", () => {
  assert.equal(rootPackage.scripts["dev:stack"], "node scripts/dev-stack.mjs");
  assert.match(readFileSync(join(repoRoot, ".gitignore"), "utf8"), /^\.dev-stack\/$/m);
});

test("the dev stack runs exactly the PostgreSQL and Temporal images of the installed app, pinned by digest", () => {
  const images = readPinnedImages(composeText);
  assert.deepEqual(Object.keys(images), ["postgres", "temporal"]);
  for (const image of Object.values(images)) {
    assert.match(image.image, /^[a-z0-9./-]+:[\w.-]+@sha256:[a-f0-9]{64}$/);
    assert.equal(image.image, `${image.name}:${image.tag}@${image.digest}`);
  }
  assert.match(images.postgres.name, /pgvector/);
  assert.match(images.temporal.name, /temporal/);
});

test("an image without a digest, or a missing service, is refused (fail closed)", () => {
  const template = (image) => `services:\n  postgres:\n    image: ${image}\n    restart: always\n`;
  assert.throws(() => readPinnedImage(template("pgvector/pgvector:0.8.3-pg17"), "postgres"), DevStackError);
  assert.throws(() => readPinnedImage(template("pgvector/pgvector@sha256:" + "a".repeat(64)), "postgres"), /not pinned by digest/);
  assert.throws(() => readPinnedImage(template("pgvector/pgvector:latest@sha256:" + "a".repeat(63)), "postgres"), /not pinned by digest/);
  assert.throws(() => readPinnedImage(template("x:1@sha256:" + "a".repeat(64)), "temporal"), /no "temporal" service/);
  assert.throws(() => readPinnedImage("version: 3\n", "postgres"), /no top-level services/);
  const ok = readPinnedImage(template(`"pgvector/pgvector:0.8.3-pg17@sha256:${"b".repeat(64)}"`), "postgres");
  assert.equal(ok.digest, `sha256:${"b".repeat(64)}`);
});

test("OpenCode is installed at the exact version the CLI image pins (OpenCode 2 is @opencode/cli)", () => {
  const pin = readOpenCodePin(dockerfileText);
  assert.match(pin.version, /^\d+\.\d+\.\d+/);
  assert.ok(dockerfileText.includes(pin.spec), `${pin.spec} is what the Dockerfile installs`);
  assert.deepEqual(readOpenCodePin("RUN npm install --global --no-audit \\\n    opencode-ai@1.1.6 \\\n    && true"),
    { packageName: "opencode-ai", version: "1.1.6", spec: "opencode-ai@1.1.6" });
  assert.equal(readOpenCodePin("RUN npm install --global @opencode/cli@2.0.32").spec, "@opencode/cli@2.0.32");
  assert.throws(() => readOpenCodePin("RUN npm install --global @opencode/cli@latest"), /pins no OpenCode version/);
  assert.throws(() => readOpenCodePin("RUN npm install --global @opencode/cli"), DevStackError);
});

test("ports: defaults never collide with the installed app, and bad or clashing values are refused", () => {
  assert.deepEqual(resolvePorts({}), { ...DEFAULT_PORTS });
  for (const port of Object.values(DEFAULT_PORTS)) assert.ok(!INSTALLED_PORTS.includes(port));
  assert.equal(new Set(Object.values(DEFAULT_PORTS)).size, Object.keys(DEFAULT_PORTS).length);
  assert.equal(resolvePorts({ [PORT_ENV.api]: "24910" }).api, 24910);
  assert.throws(() => resolvePorts({ [PORT_ENV.api]: "4910" }), /installed SpaceApp/);
  assert.throws(() => resolvePorts({ [PORT_ENV.web]: "4911" }), /installed SpaceApp/);
  assert.throws(() => resolvePorts({ [PORT_ENV.web]: String(DEFAULT_PORTS.api) }), /both use port/);
  assert.throws(() => parsePort("X", "80", 1), /between 1024 and 65535/);
  assert.throws(() => parsePort("X", "70000", 1), /between 1024 and 65535/);
  assert.throws(() => parsePort("X", "12a", 1), /port number/);
  assert.equal(parsePort("X", "", 15000), 15000);
});

test("the compose project is per state directory, and an override cannot take the installed app's name", () => {
  const a = composeProjectName("/a/.dev-stack");
  assert.match(a, /^spaceapp-dev-[a-f0-9]{8}$/);
  assert.equal(composeProjectName("/a/.dev-stack"), a);
  assert.notEqual(composeProjectName("/b/.dev-stack"), a);
  assert.equal(composeProjectName("/a/.dev-stack", "my-stack"), "my-stack");
  assert.throws(() => composeProjectName("/a", "spaceapp"), /installed app/);
  assert.throws(() => composeProjectName("/a", "Bad Name"), /lowercase/);
});

test("the CLI host socket stays inside the state directory unless the path is too long for a Unix socket", () => {
  assert.deepEqual(cliHostSocketPath("/home/dev/.dev-stack"), { path: "/home/dev/.dev-stack/run/cli-host.sock", external: false });
  const deep = `/Users/dev/${"very-long-folder-name/".repeat(5)}.dev-stack`;
  const socket = cliHostSocketPath(deep, "/tmp");
  assert.equal(socket.external, true);
  assert.match(socket.path, /^\/tmp\/spaceapp-dev-[a-f0-9]{12}\/cli-host\.sock$/);
  assert.ok(Buffer.byteLength(socket.path) <= 100);
});

test("the core environment comes from the installed core container, every container path moved into the checkout", () => {
  const { env, origin } = coreEnvironment();
  const templateKeys = readServiceEnvironment(composeText, "spaceapp-core").map(([key]) => key);
  for (const key of templateKeys) {
    if (Object.hasOwn(DROPPED_CORE_KEYS, key)) assert.ok(!(key in env), `${key} is dropped`);
    else assert.ok(key in env, `${key} from the compose template reaches the API and worker`);
  }
  for (const [key, value] of Object.entries(env)) {
    assert.ok(origin[key], `${key} has a known origin`);
    if (typeof value !== "string" || !value.startsWith("/")) continue;
    assert.ok(value.startsWith(stateDir) || value.startsWith(repoRoot), `${key}=${value} is in the checkout or state directory`);
  }
  for (const value of Object.values(env)) assert.ok(!String(value).includes("/opt/spaceapp"), "nothing points at /opt/spaceapp");
  assert.equal(env.SPACE_API_HOST, BIND_HOST);
  assert.equal(env.SPACE_API_PORT, String(DEFAULT_PORTS.api));
  assert.equal(env.SPACE_TEMPORAL_ADDRESS, `${BIND_HOST}:${DEFAULT_PORTS.temporal}`);
  assert.equal(env.SPACE_DATABASE_URL, secrets.databaseUrl);
  assert.equal(env.SPACE_SETUP_TOKEN_FILE, join(stateDir, "secrets", "setup-token"));
  assert.notEqual(env.SPACE_DEV_LOGIN_ENABLED, "true", "the dev-login shortcut stays off; the owner signs in for real");
});

test("a new container path in the compose template fails loudly instead of reaching a contributor's machine", () => {
  const at = composeText.indexOf("    environment:\n", composeText.indexOf("  spaceapp-core:"));
  assert.ok(at > 0);
  const injected = `${composeText.slice(0, at)}    environment:\n      SPACE_NEW_ROOT: /srv/spaceapp-new\n${composeText.slice(at + "    environment:\n".length)}`;
  assert.throws(() => coreEnvironment({ composeText: injected }), /SPACE_NEW_ROOT=\/srv\/spaceapp-new .* does not map/);
  assert.throws(() => interpolate("${SPACEAPP_UNKNOWN}", {}, "KEY"), /does not define/);
  assert.equal(interpolate("${SPACEAPP_UNKNOWN:-fallback}", {}, "KEY"), "fallback");
  const map = containerPathMap({ repoRoot: "/r", stateDir: "/s" });
  assert.equal(mapContainerPath("/var/lib/spaceapp-cli/x", map), "/s/cli/x", "the longest prefix wins");
  assert.equal(mapContainerPath("/var/lib/spaceapp/db", map), "/s/data/db");
  assert.equal(mapContainerPath("/etc/passwd", map), null);
});

test("the CLI host gets no database URL and no session secret, as the CLI container", () => {
  const { env } = coreEnvironment();
  const cli = buildCliHostEnvironment({ coreEnv: env, stateDir, baseEnv: { PATH: "/usr/bin", SPACE_DATABASE_URL: "x", HOME: "/home/dev" } });
  assert.equal(cli.PATH, "/usr/bin");
  assert.equal(cli.HOME, join(stateDir, "cli"));
  assert.equal(cli.SPACE_CLI_HOST_SOCKET, env.SPACE_CLI_HOST_SOCKET);
  for (const value of Object.values(cli)) {
    assert.ok(!String(value).includes(secrets.sessionSecret));
    assert.ok(!String(value).includes(secrets.databaseUrl));
  }
  assert.ok(!Object.keys(cli).some((key) => /DATABASE|SESSION_SECRET/.test(key)));
});

test("the generated compose file publishes on 127.0.0.1 only, runs the digests and keeps the password out of the file", () => {
  const images = readPinnedImages(composeText);
  const text = renderComposeFile({ images, ports: DEFAULT_PORTS, project: "spaceapp-dev-12345678" });
  assert.match(text, /^name: spaceapp-dev-12345678$/m);
  assert.ok(text.includes(JSON.stringify(images.postgres.image)));
  assert.ok(text.includes(JSON.stringify(images.temporal.image)));
  const published = [...text.matchAll(/^ {6}- "([^"]+:\d+:\d+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(published, [`127.0.0.1:${DEFAULT_PORTS.postgres}:5432`, `127.0.0.1:${DEFAULT_PORTS.temporal}:7233`]);
  assert.match(text, /postgres-password:\n {4}environment: SPACEAPP_DEV_POSTGRES_PASSWORD/);
  assert.doesNotMatch(text, /POSTGRES_PASSWORD:/);
  assert.doesNotMatch(text, /file: /, "no file-backed secret: it would be a bind mount and need a world-readable file");
  assert.equal((text.match(/dev\.spaceapp\.dev-stack: "true"/g) ?? []).length, 4, "containers, network and volume are labelled");
});

test("the CLI wrapper runs OpenCode from the state directory and refuses the other runtimes clearly", () => {
  assert.ok(CLI_WRAPPER_RUNTIMES.includes("opencode"));
  const text = renderCliWrapper({ stateDir: "/s/it's here", repoRoot: "/r", nodePath: "/usr/bin/node", opencodePort: 14912 });
  assert.match(text, /^#!\/usr\/bin\/env bash\nset -euo pipefail|^#!\/usr\/bin\/env bash\n#[^\n]*\nset -euo pipefail/);
  assert.ok(text.includes("state_dir='/s/it'\\''s here'"), "paths are shell-quoted");
  assert.ok(text.includes('opencode_bin="$state_dir/opencode/node_modules/.bin/opencode"'));
  assert.ok(text.includes("'/usr/bin/node' '/r/scripts/dev-stack.mjs' opencode-server --port '14912'"));
  assert.ok(text.includes('exec "$opencode_bin" --server "$server_url" "$@" "$PWD"'), "a pane attaches to the shared server");
  assert.ok(text.includes('exec "$opencode_bin" "$@" --standalone'));
  assert.match(text, /is not installed in the dev stack; it runs OpenCode only/);
  assert.match(text, /exit 69/);
  assert.doesNotMatch(text, /npm install|--global/, "the wrapper never installs anything globally");
});

test("packages rebuild in the root build order, with everything that depends on the changed one", () => {
  const order = packageBuildOrder(rootPackage);
  assert.ok(order.length >= 5);
  assert.ok(order.every((name) => name.startsWith("@space/")));
  assert.ok(!order.includes("@space/api") && !order.includes("@space/web") && !order.includes("@space/worker"));
  assert.ok(order.indexOf("@space/contracts") < order.indexOf("@space/db"));
  const dependencies = { b: ["a"], c: ["b"], d: [] };
  assert.deepEqual(rebuildPlan("a", ["a", "b", "c", "d"], dependencies), ["a", "b", "c"]);
  assert.deepEqual(rebuildPlan("d", ["a", "b", "c", "d"], dependencies), ["d"]);
  assert.throws(() => packageBuildOrder({ scripts: {} }), /no build script/);
  const dirs = { "@space/db": "packages/db", "@space/cli-host": "packages/cli-host" };
  assert.equal(packageForPath("packages/db/src/index.ts", dirs), "@space/db");
  assert.equal(packageForPath("packages\\cli-host\\src\\main.ts", dirs), "@space/cli-host");
  assert.equal(packageForPath("packages/db/dist/index.js", dirs), null);
});

test("output is redacted and ANSI-free where it is searched", () => {
  assert.equal(redact("url postgres://u:supersecret@h and supersecret", ["supersecret"]), "url postgres://u:[redacted]@h and [redacted]");
  assert.equal(redact("short abc", ["abc"]), "short abc", "very short strings are not treated as secrets");
  assert.equal(stripAnsi("\u001b[32mready\u001b[0m \u001b]0;title\u0007ok"), "ready ok");
});
