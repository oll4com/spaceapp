import assert from "node:assert/strict";
import fs from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { composeConfig, readImages, readOpenCodeVersion, resolvePorts, serviceEnv } from "../dev-stack-config.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/u, "");
const fixture = () => ({
  repoRoot, stateDir: join(repoRoot, ".dev-stack"), project: `space-dev-${"a".repeat(24)}`,
  ports: resolvePorts({}),
  secretPaths: Object.fromEntries(Object.entries({
    postgresPassword: "postgres-password", sessionSecret: "session-secret", setupToken: "setup-token",
  }).map(([key, file]) => [key, join(repoRoot, ".dev-stack", "secrets", file)])),
  secrets: { postgresPassword: "b".repeat(64), sessionSecret: "c".repeat(64), setupToken: "d".repeat(64) },
});
const fakeImages = {
  postgres: `example.test/postgres:test@sha256:${"e".repeat(64)}`,
  temporal: `example.test/temporal:test@sha256:${"f".repeat(64)}`,
};

test("default ports and all explicit decimal overrides are deterministic", () => {
  assert.deepEqual(resolvePorts({}), { api: 5910, web: 5911, postgres: 55432, temporal: 57233 });
  assert.deepEqual(resolvePorts({ SPACE_DEV_API_PORT: " 6010 ", SPACE_DEV_WEB_PORT: "6011",
    SPACE_DEV_POSTGRES_PORT: "60432", SPACE_DEV_TEMPORAL_PORT: "60233" }),
  { api: 6010, web: 6011, postgres: 60432, temporal: 60233 });
});

test("port overrides reject malformed, out-of-range, stable and colliding values", () => {
  for (const value of ["", " ", "0", "65536", "NaN", "1.2", "5910garbage", "-1", "0x1716", 5910, null, "4910", "4911", "5911"]) {
    assert.throws(() => resolvePorts({ SPACE_DEV_API_PORT: value }), /DEV_STACK_CONFIG/u);
  }
  assert.throws(() => resolvePorts({ SPACE_DEV_TEMPORAL_PORT: "55432" }), /distinct/u);
});

test("images equal the checked-in release template, without copied digests", () => {
  const source = fs.readFileSync(join(repoRoot, "packages", "run-spaceapp", "templates", "compose.yml"), "utf8");
  const images = readImages(repoRoot);
  for (const key of ["postgres", "temporal"]) {
    assert.match(images[key], /@sha256:[a-f0-9]{64}$/u);
    assert.ok(source.includes(`    image: ${images[key]}`));
  }
});

test("image reader follows changed template values and refuses ambiguous or unpinned inputs", (t) => {
  const imageSource = `services:\n  postgres:\n    image: "${fakeImages.postgres}"\n  temporal:\n    image: '${fakeImages.temporal}'\nvolumes:\n  postgres:\n`;
  const mock = t.mock.method(fs, "readFileSync", () => imageSource);
  assert.deepEqual(readImages(repoRoot), fakeImages);
  for (const source of [imageSource.replace(fakeImages.postgres, "postgres:latest"),
    imageSource.replace("  temporal:", "  unrelated:"),
    imageSource.replace("volumes:", `  temporal:\n    image: ${fakeImages.temporal}\nvolumes:`),
    imageSource.replace("    image:", `    image: ${fakeImages.postgres}\n    image:`)]) {
    mock.mock.mockImplementation(() => source);
    assert.throws(() => readImages(repoRoot), /DEV_STACK_CONFIG/u);
  }
});

test("OpenCode uses the exact Dockerfile pin and refuses missing or ambiguous pins", (t) => {
  const source = fs.readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const version = readOpenCodeVersion(repoRoot);
  assert.ok(source.includes(`opencode-ai@${version}`));
  const mock = t.mock.method(fs, "readFileSync", () => "RUN npm install -g opencode-ai@8.7.6 \\\n");
  assert.equal(readOpenCodeVersion(repoRoot), "8.7.6");
  for (const source of ["RUN npm install -g opencode-ai@latest\n", "# no package\n",
    "RUN npm install -g opencode-ai@8.7.6 opencode-ai@8.7.5\n"]) {
    mock.mock.mockImplementation(() => source);
    assert.throws(() => readOpenCodeVersion(repoRoot), /one pinned/u);
  }
});

test("compose contains only isolated local PG/Temporal with source images and private env references", () => {
  const state = fixture();
  const config = composeConfig(state, fakeImages);
  assert.deepEqual(Object.keys(config.services), ["postgres", "temporal"]);
  assert.equal(config.name, state.project);
  assert.equal(config.services.postgres.image, fakeImages.postgres);
  assert.equal(config.services.temporal.image, fakeImages.temporal);
  assert.deepEqual(config.services.postgres.ports, ["127.0.0.1:55432:5432"]);
  assert.deepEqual(config.services.temporal.ports, ["127.0.0.1:57233:7233"]);
  assert.deepEqual(config.services.postgres.volumes, ["postgres:/var/lib/postgresql/data"]);
  assert.equal(config.volumes.postgres.name, `${state.project}-postgres`);
  assert.equal(config.volumes.postgres.labels["spaceapp.dev-stack.project"], state.project);
  assert.ok(!Object.keys(config.volumes.postgres.labels).some((key) => key.startsWith("com.docker.compose.")));
  assert.equal(config.services.postgres.environment.POSTGRES_PASSWORD, "${DEV_STACK_POSTGRES_PASSWORD}");
  assert.equal(config.services.temporal.environment.POSTGRES_PWD, "${DEV_STACK_POSTGRES_PASSWORD}");
  assert.equal(config.services.postgres.environment.POSTGRES_DB, "spaceapp_dev");
  assert.equal(config.services.temporal.environment.DEFAULT_NAMESPACE, state.project);
  assert.deepEqual(config.services.temporal.entrypoint, ["/etc/temporal/entrypoint.sh"]);
  assert.deepEqual(config.services.temporal.command, ["autosetup"]);
  assert.equal(config.services.postgres.healthcheck.test[1], "pg_isready -U spaceapp -d spaceapp_dev");
  assert.equal(config.services.temporal.healthcheck.test[1],
    "temporal operator cluster health --address temporal:7233 >/dev/null"
    + ` && temporal operator namespace describe --namespace ${state.project} --address temporal:7233 >/dev/null`);
  const serialized = JSON.stringify(config);
  for (const value of Object.values(state.secrets)) assert.ok(!serialized.includes(value));
  assert.ok(!serialized.includes(state.stateDir));
  assert.equal(config.secrets, undefined);
});

test("configuration refuses forged state paths, unsafe namespace, ports and image refs", () => {
  const state = fixture();
  for (const invalid of [{ ...state, project: "default; injected" }, { ...state, stateDir: join(repoRoot, "elsewhere") },
    { ...state, ports: { ...state.ports, api: 4910 } }, { ...state, repoRoot: "relative" }]) {
    assert.throws(() => composeConfig(invalid, fakeImages), /DEV_STACK_CONFIG/u);
    assert.throws(() => serviceEnv(invalid), /DEV_STACK_CONFIG/u);
  }
  assert.throws(() => composeConfig(state, { ...fakeImages, postgres: "postgres:latest" }), /pinned image/u);
});

test("service environment drops ambient keys, stable settings, Node injections and homes", (t) => {
  const state = fixture();
  const names = ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "SLACK_BOT_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS",
    "NODE_PATH", "SPACE_DATABASE_URL", "SPACE_SESSION_SECRET", "SPACE_TEMPORAL_NAMESPACE", "SPACE_API_PORT",
    "SPACE_SETUP_TOKEN_FILE", "OPENCODE_CONFIG", "HOME", "USERPROFILE", "BASH_ENV", "ENV"];
  const saved = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of names) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  for (const key of names) process.env[key] = "SYNTHETIC_AMBIENT_CANARY";
  const env = serviceEnv(state);
  assert.ok(!JSON.stringify(env).includes("SYNTHETIC_AMBIENT_CANARY"));
  for (const key of names.filter((key) => !["HOME", "USERPROFILE", "SPACE_DATABASE_URL", "SPACE_SESSION_SECRET",
    "SPACE_TEMPORAL_NAMESPACE", "SPACE_API_PORT", "SPACE_SETUP_TOKEN_FILE"].includes(key))) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.SPACE_INSTANCE, "dev");
  assert.equal(env.SPACE_TEMPORAL_NAMESPACE, state.project);
  assert.equal(env.SPACE_TEMPORAL_TASK_QUEUE, state.project);
  assert.equal(env.SPACE_SESSION_SECRET, state.secrets.sessionSecret);
  assert.equal(env.SPACE_SETUP_TOKEN_FILE, state.secretPaths.setupToken);
  const url = new URL(env.SPACE_DATABASE_URL);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/spaceapp_dev");
  assert.equal(url.port, "55432");
  assert.equal(env.SPACE_CLI_ROOT_ENABLED, "false");
  assert.equal(env.SPACE_CLI_HOST_SOCKET, join(state.stateDir, "h.sock"));
  assert.equal(env.SPACE_CLI_WORKSPACE_ROOT, join(state.stateDir, "workspaces"));
  assert.equal(env.SPACE_CLI_ENABLED, "true");
  assert.equal(env.SPACE_API_HOST, "127.0.0.1");
  assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
  assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
  assert.equal(env.SPACE_DEV_LOGIN, "false");
  assert.equal(env.SPACE_OPTIONAL_MODULES, "none");
  assert.equal(env.SPACE_DOT_TOOL_GATEWAY, "disabled");
  assert.equal(env.SPACE_T3CODE_ENABLED, "false");
  assert.equal(env.SPACE_CHESS_MOVE_SOCKET, "disabled");
  assert.equal(env.SPACE_BROWSER_SESSIONS_ENABLED, "false");
});

test("all declared mutable paths and homes are children of state, not stable source paths", () => {
  const state = fixture();
  const env = serviceEnv(state);
  const metadataRoots = new Set(["SPACE_INSTALL_ROOT", "SPACE_REPO_ROOT", "SPACE_GIT_ROOT"]);
  const mutablePaths = Object.entries(env).filter(([key, value]) => isAbsolute(value)
    && key !== "PATH" && !metadataRoots.has(key)
    && !["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC"].includes(key));
  assert.ok(mutablePaths.length >= 40);
  for (const [key, value] of mutablePaths) {
    const suffix = relative(state.stateDir, value);
    assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix), key);
  }
  assert.equal(env.HOME, join(state.stateDir, "home"));
  assert.equal(env.SPACE_INSTALL_ROOT, repoRoot);
  assert.ok(env.PATH.startsWith(join(state.stateDir, "bin")));
});

test("credentials must match the state helper shape and are never taken from ambient env", () => {
  const state = fixture();
  assert.throws(() => serviceEnv({ ...state, secrets: { ...state.secrets, sessionSecret: "short" } }), /credential/u);
  assert.throws(() => serviceEnv({ ...state, secretPaths: { ...state.secretPaths, setupToken: join(repoRoot, "setup-token") } }), /inside checkout/u);
  const first = serviceEnv(state);
  first.SPACE_API_HOST = "0.0.0.0";
  assert.equal(serviceEnv(state).SPACE_API_HOST, "127.0.0.1");
});
