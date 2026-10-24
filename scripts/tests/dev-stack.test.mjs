import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  assertResetAllowed, buildConfig, composeProjectName, ensureSecrets, ensureStateMarker,
  parseOpencodePin, parseServiceImage, renderCompose, repoRoot
} from "../dev-stack.mjs";

const templateCompose = readFileSync(
  join(repoRoot, "packages/run-spaceapp/templates/compose.yml"), "utf8"
);
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");

test("postgres and temporal images are parsed from the install template, digests included", () => {
  const postgres = parseServiceImage(templateCompose, "postgres");
  const temporal = parseServiceImage(templateCompose, "temporal");
  assert.match(postgres, /^pgvector\/pgvector:.+@sha256:[0-9a-f]{64}$/);
  assert.match(temporal, /^temporalio\/auto-setup:.+@sha256:[0-9a-f]{64}$/);
});

test("parseServiceImage rejects unknown services", () => {
  assert.throws(() => parseServiceImage(templateCompose, "nope"), /not found/);
});

test("opencode pin is read from the Dockerfile", () => {
  assert.match(parseOpencodePin(dockerfile), /^\d+\.\d+\.\d+$/);
});

test("default dev ports never collide with an installed SpaceApp (4910/4911)", () => {
  const config = buildConfig({});
  assert.notEqual(config.apiPort, 4910);
  assert.notEqual(config.webPort, 4911);
  assert.ok(config.apiPort > 0 && config.webPort > 0);
});

test("ports can be overridden through the environment", () => {
  const config = buildConfig({ SPACE_DEV_API_PORT: "20000", SPACE_DEV_WEB_PORT: "20001" });
  assert.equal(config.apiPort, 20000);
  assert.equal(config.webPort, 20001);
  assert.throws(() => buildConfig({ SPACE_DEV_API_PORT: "banana" }), /port number/);
});

test("secrets are created once, mode 0600, and reused on the next run", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dev-stack-test-"));
  const config = buildConfig({ SPACE_DEV_STATE_DIR: stateDir });
  const first = ensureSecrets(config);
  assert.equal(first.created, true);
  for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
    const path = join(config.secretsDir, name);
    assert.ok(existsSync(path), `${name} exists`);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600, `${name} is 0600`);
    }
  }
  const tokenBefore = readFileSync(join(config.secretsDir, "setup-token"), "utf8");
  const second = ensureSecrets(config);
  assert.equal(second.created, false);
  assert.equal(readFileSync(join(config.secretsDir, "setup-token"), "utf8"), tokenBefore);
  assert.match(first.databaseUrl, new RegExp(`:${config.postgresPort}/spaceapp$`));
});

test("rendered compose uses the parsed images and binds ports to 127.0.0.1 only", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dev-stack-test-"));
  const config = buildConfig({ SPACE_DEV_STATE_DIR: stateDir });
  const rendered = renderCompose(config, {
    postgres: parseServiceImage(templateCompose, "postgres"),
    temporal: parseServiceImage(templateCompose, "temporal")
  });
  assert.match(rendered, /pgvector\/pgvector:.+@sha256:/);
  assert.match(rendered, /temporalio\/auto-setup:.+@sha256:/);
  assert.match(rendered, new RegExp(`127\\.0\\.0\\.1:${config.postgresPort}:5432`));
  assert.match(rendered, new RegExp(`127\\.0\\.0\\.1:${config.temporalPort}:7233`));
  assert.doesNotMatch(rendered, /__[A-Z_]+__/);
  assert.doesNotMatch(rendered, /0\.0\.0\.0:/);
});

test("compose project name is derived from the state directory: stable, unique, valid", () => {
  const a1 = buildConfig({ SPACE_DEV_STATE_DIR: join(tmpdir(), "dev-stack-a") });
  const a2 = buildConfig({ SPACE_DEV_STATE_DIR: join(tmpdir(), "dev-stack-a") });
  const b = buildConfig({ SPACE_DEV_STATE_DIR: join(tmpdir(), "dev-stack-b") });
  assert.equal(a1.composeProject, a2.composeProject, "same state dir -> same project name");
  assert.notEqual(a1.composeProject, b.composeProject, "different state dirs -> different project names");
  assert.match(a1.composeProject, /^spaceapp-dev-[0-9a-f]{8}$/, "lowercase, digits and hyphens only");
  assert.equal(composeProjectName(a1.stateDir), a1.composeProject);
  assert.notEqual(buildConfig({}).composeProject, "spaceapp-dev", "no longer the shared hardcoded name");
});

test("reset guard refuses a state directory without the ownership marker", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dev-stack-test-"));
  const config = buildConfig({ SPACE_DEV_STATE_DIR: stateDir });
  assert.throws(() => assertResetAllowed(config), /ownership marker/);
  ensureStateMarker(config);
  assert.doesNotThrow(() => assertResetAllowed(config));
});

test("reset guard refuses repo root, home directory and filesystem root", () => {
  for (const dangerous of [repoRoot, homedir(), resolve("/")]) {
    const config = buildConfig({ SPACE_DEV_STATE_DIR: dangerous });
    assert.throws(() => assertResetAllowed(config), /Refusing to reset/);
  }
});

test("default temporal port stays 7233: the install template never publishes it on the host", () => {
  const config = buildConfig({});
  assert.equal(config.temporalPort, 7233);
  // The installed stack reaches Temporal over the compose network only
  // (SPACE_TEMPORAL_ADDRESS: temporal:7233); its service publishes no port,
  // so the dev stack binding 127.0.0.1:7233 cannot collide with an install.
  const start = templateCompose.indexOf("\n  temporal:\n");
  const end = templateCompose.indexOf("\nnetworks:", start);
  assert.ok(start >= 0 && end > start, "temporal service found in the install template");
  assert.doesNotMatch(templateCompose.slice(start, end), /\n    ports:/);
});

test("existing secret files with loose permissions are tightened to 0600", () => {
  if (process.platform === "win32") return;
  const stateDir = mkdtempSync(join(tmpdir(), "dev-stack-test-"));
  const config = buildConfig({ SPACE_DEV_STATE_DIR: stateDir });
  ensureSecrets(config);
  const tokenPath = join(config.secretsDir, "setup-token");
  chmodSync(tokenPath, 0o644);
  ensureSecrets(config);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
});
