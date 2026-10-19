import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  composeTemplatePath, defaultPorts, ensureSecrets, opencodeVersion, packageForChange, readOpencodeVersion,
  readServiceImages, renderCliCommand, renderCompose, resolvePorts, resolveProjectName, resolveStateDir,
  sameProcess, serviceEnvironment, serviceImage, statePaths, verifyProcessIdentity
} from "../dev-stack/config.mjs";

const template = readFileSync(composeTemplatePath, "utf8");

test("service images come from the installer compose template, pinned by digest", () => {
  const images = readServiceImages();
  assert.match(images.postgres, /^pgvector\/pgvector:.+@sha256:[0-9a-f]{64}$/);
  assert.match(images.temporal, /^temporalio\/auto-setup:.+@sha256:[0-9a-f]{64}$/);
  assert.ok(template.includes(`image: ${images.postgres}\n`));
  assert.ok(template.includes(`image: ${images.temporal}\n`));
  const compose = renderCompose({ images, ports: defaultPorts });
  assert.ok(compose.includes(`image: ${images.postgres}\n`));
  assert.ok(compose.includes(`image: ${images.temporal}\n`));
});

test("an image without a digest or a missing service is refused", () => {
  assert.throws(() => serviceImage("services:\n  postgres:\n    image: postgres:17\n", "postgres"), /not pinned by digest/);
  assert.throws(() => serviceImage(template, "redis"), /missing/);
});

test("every published port binds to loopback and no secret is written into the compose file", () => {
  const ports = { web: 5001, api: 5000, postgres: 5002, temporal: 5003 };
  const compose = renderCompose({ images: readServiceImages(), ports });
  const published = [...compose.matchAll(/^\s+- "([^"]+)"$/gm)].map((match) => match[1]);
  assert.deepEqual(published, ["127.0.0.1:5002:5432", "127.0.0.1:5003:7233"]);
  assert.match(compose, /POSTGRES_PASSWORD: \$\{SPACE_DEV_POSTGRES_PASSWORD:\?\}/);
  assert.doesNotMatch(compose, /secrets:/);
});

test("ports default away from an installed SpaceApp and can be changed", () => {
  const ports = resolvePorts({});
  for (const port of Object.values(ports)) assert.ok(port !== 4910 && port !== 4911);
  assert.deepEqual(resolvePorts({ SPACE_DEV_WEB_PORT: "6001", SPACE_DEV_API_PORT: "6000" }).web, 6001);
  assert.throws(() => resolvePorts({ SPACE_DEV_WEB_PORT: "4911" }), /installed SpaceApp/);
  assert.throws(() => resolvePorts({ SPACE_DEV_API_PORT: "80" }), /between 1024/);
  assert.throws(() => resolvePorts({ SPACE_DEV_API_PORT: String(defaultPorts.web) }), /different/);
});

test("the compose project and state directory are the dev stack's own", () => {
  assert.equal(resolveProjectName({}), "spaceapp-devstack");
  assert.throws(() => resolveProjectName({ SPACE_DEV_COMPOSE_PROJECT: "spaceapp" }), /other than spaceapp/);
  assert.equal(resolveStateDir({}, "/repo"), "/repo/.dev-stack");
  assert.equal(resolveStateDir({ SPACE_DEV_STATE_DIR: "/tmp/x" }, "/repo"), "/tmp/x");
  assert.match(readFileSync(new URL("../../.gitignore", import.meta.url), "utf8"), /^\.dev-stack\/$/m);
});

test("secrets are generated once per state directory with mode 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-stack-"));
  try {
    const paths = statePaths(root);
    const first = await ensureSecrets(paths);
    for (const key of ["postgresPassword", "sessionSecret", "setupToken"]) {
      assert.ok(first[key].length >= 32, key);
      assert.equal((await stat(paths[key])).mode & 0o777, 0o600, key);
    }
    assert.equal((await stat(paths.secrets)).mode & 0o777, 0o700);
    assert.deepEqual(await ensureSecrets(paths), first);
    await writeFile(paths.setupToken, "", { mode: 0o644 });
    const second = await ensureSecrets(paths);
    assert.notEqual(second.setupToken, first.setupToken);
    assert.equal((await stat(paths.setupToken)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("services get the public-distribution environment with state-directory paths and no dev login", () => {
  const paths = statePaths("/state");
  const env = serviceEnvironment({
    paths, ports: defaultPorts, secrets: { postgresPassword: "p@ss/word", sessionSecret: "s", setupToken: "t" }, env: {}
  });
  assert.equal(env.SPACE_DEV_LOGIN, "false");
  assert.equal(env.SPACE_PUBLIC_DISTRIBUTION, "true");
  assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
  assert.equal(env.SPACE_DATABASE_URL, `postgresql://spaceapp:p%40ss%2Fword@127.0.0.1:${defaultPorts.postgres}/spaceapp`);
  assert.equal(env.SPACE_TEMPORAL_ADDRESS, `127.0.0.1:${defaultPorts.temporal}`);
  assert.equal(env.SPACE_API_HOST, "127.0.0.1");
  assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
  assert.equal(env.SPACE_SETUP_TOKEN_FILE, "/state/secrets/setup-token");
  assert.ok(!Object.values(env).includes("t"), "the setup token is passed as a file");
  for (const [name, value] of Object.entries(env)) {
    assert.ok(!String(value).startsWith("/opt/spaceapp") && !String(value).startsWith("/var/lib/spaceapp"), name);
  }
});

test("the OpenCode version is the Dockerfile's pin and its command runs the dev wrapper", () => {
  assert.match(readOpencodeVersion(), /^\d+\.\d+\.\d+$/);
  assert.equal(opencodeVersion("RUN npm install --global opencode-ai@1.2.3 \\"), "1.2.3");
  assert.throws(() => opencodeVersion("RUN true"), /does not pin/);
  const command = renderCliCommand({ runtime: "opencode", paths: statePaths("/state it's"), nodePath: "/usr/bin/node" });
  assert.match(command, /^export SPACE_DEV_CLI_ROOT='\/state it'\\''s\/cli'$/m);
  assert.match(command, /scripts\/dev-stack\/cli-wrapper\.sh' 'opencode' "\$@"$/m);
});

test("package source changes map to the package to rebuild", () => {
  assert.equal(packageForChange("packages/contracts/src/index.ts"), "contracts");
  assert.equal(packageForChange("packages/contracts/dist/index.js"), null);
  assert.equal(packageForChange("packages/run-spaceapp/src/index.mjs"), null);
  assert.equal(packageForChange("apps/api/src/app.ts"), null);
});

test("the root script and the contributor guide document the dev stack", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts["dev:stack"], "node scripts/dev-stack.mjs");
  const guide = await readFile(new URL("../../CONTRIBUTING.md", import.meta.url), "utf8");
  assert.match(guide, /## Run the full app from source/);
  for (const command of ["npm run dev:stack", "npm run dev:stack -- down", "npm run dev:stack -- reset"]) {
    assert.ok(guide.includes(command), command);
  }
});

test("process identity verification detects PID recycling and accepts matching processes", () => {
  const recorded = { pid: 42, comm: "node", starttime: "100200" };
  assert.equal(verifyProcessIdentity(recorded, { pid: 42, comm: "node", starttime: "100200" }), 42);
  assert.equal(verifyProcessIdentity(recorded, { pid: 42, comm: "python", starttime: "300400" }), null);
  assert.equal(verifyProcessIdentity(recorded, { pid: 99, comm: "node", starttime: "100200" }), null);
  assert.equal(verifyProcessIdentity({ pid: 42, ps: "11:00 node main.js" }, { pid: 42, ps: "11:00 node main.js" }), 42);
  assert.equal(verifyProcessIdentity({ pid: 42, ps: "11:00 node main.js" }, { pid: 42, ps: "11:30 bash" }), null);
  assert.equal(verifyProcessIdentity(42, { pid: 42 }), 42);
  assert.equal(verifyProcessIdentity(null, { pid: 42 }), null);
  assert.equal(verifyProcessIdentity(42, null), null);
  assert.equal(sameProcess({ pid: 10, starttime: "1" }, { pid: 10, starttime: "1" }), true);
  assert.equal(sameProcess({ pid: 10, starttime: "1" }, { pid: 10, starttime: "2" }), false);
});

