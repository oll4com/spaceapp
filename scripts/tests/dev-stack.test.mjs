import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Import only the pure helpers. The CLI entry is guarded behind `invokedDirectly`.
// pathToFileURL keeps this working on Windows, where a bare `d:\...` path is not
// a valid ESM specifier.
const { readPinnedImages, readPinnedOpenCode, generateSecrets, readSecrets, renderCompose, PORTS } =
  await import(pathToFileURL(join(repoRoot, "scripts", "dev-stack.mjs")).href);

const TEMPLATE = join(repoRoot, "packages/run-spaceapp/templates/compose.yml");
const DOCKERFILE = join(repoRoot, "Dockerfile");

test("readPinnedImages extracts both digest-pinned images from the compose template", () => {
  const images = readPinnedImages(readFileSync(TEMPLATE, "utf8"));

  // Both must be pinned by digest — that is the whole point of reading them.
  assert.match(images.postgres, /^pgvector\/pgvector:.*@sha256:[0-9a-f]{64}$/);
  assert.match(images.temporal, /^temporalio\/.*@sha256:[0-9a-f]{64}$/);

  // And they must be exactly what the template ships, byte for byte. Copying
  // them by hand is what this check exists to prevent.
  const template = readFileSync(TEMPLATE, "utf8");
  assert.ok(template.includes(`image: ${images.postgres}`), "postgres image not verbatim in template");
  assert.ok(template.includes(`image: ${images.temporal}`), "temporal image not verbatim in template");
});

test("readPinnedImages fails closed when a digest is missing", () => {
  const goodPostgres = `    image: pgvector/pgvector:0.8.3-pg17-trixie@sha256:${"a".repeat(64)}\r\n`;
  const goodTemporal = `    image: temporalio/auto-setup:1.29.1@sha256:${"b".repeat(64)}\r\n`;

  // No digest at all on postgres → refuses to run.
  assert.throws(() => readPinnedImages("services:\n  postgres:\n    image: pgvector/pgvector:latest\n"), /digest-pinned postgres/);

  // Tag-only temporal (postgres fine) → refuses to run.
  assert.throws(() => readPinnedImages(`services:\n  postgres:\n${goodPostgres}  temporal:\n    image: temporalio/auto-setup:1.29.1\n`), /digest-pinned temporal/);

  // Both missing → refuses rather than inventing a tag.
  assert.throws(() => readPinnedImages("services: {}\n"), /digest-pinned postgres/);

  // CRLF checkout (what Windows and core.autocrlf produce) must still parse.
  const crlf = `services:\n  postgres:\n${goodPostgres}  temporal:\n${goodTemporal}`;
  const images = readPinnedImages(crlf);
  assert.ok(images.postgres.includes("@"), "CRLF postgres image lost its digest");
  assert.ok(images.temporal.includes("@"), "CRLF temporal image lost its digest");
});

test("generateSecrets writes every secret with mode 0600 and a valid setup token", () => {
  const dir = mkdtempSync(join(tmpdir(), "devstack-secrets-"));
  try {
    const secrets = generateSecrets(dir);

    for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
      assert.ok(existsSync(join(dir, name)), `${name} missing`);
    }

    // POSIX: the modes must actually be 0600. Windows has no POSIX mode bits,
    // so the assertion is meaningful only on POSIX (see generateSecrets).
    if (process.platform !== "win32") {
      for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
        const mode = statSync(join(dir, name)).mode & 0o777;
        assert.equal(mode, 0o600, `${name} mode is ${mode.toString(8)}, expected 0600`);
      }
    }

    // Matches scripts/rotate-owner-setup-token.mjs's validator: 32-500 chars,
    // no line breaks.
    assert.ok(secrets.setupToken.length >= 32 && secrets.setupToken.length <= 500);
    assert.ok(!/[\0\r\n]/.test(secrets.setupToken));

    // Secrets differ per state directory — no shared defaults.
    const other = generateSecrets(mkdtempSync(join(tmpdir(), "devstack-secrets-")));
    assert.notEqual(secrets.postgresPassword, other.postgresPassword);
    assert.notEqual(secrets.sessionSecret, other.sessionSecret);
    assert.notEqual(secrets.setupToken, other.setupToken);

    // readSecrets round-trips exactly what generateSecrets wrote.
    const reread = readSecrets(dir);
    assert.equal(reread.setupToken, secrets.setupToken);
    assert.equal(reread.sessionSecret, secrets.sessionSecret);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderCompose binds every published port to 127.0.0.1 only", () => {
  const images = { postgres: "pgvector/pgvector:0.8.3-pg17-trixie@sha256:" + "a".repeat(64), temporal: "temporalio/auto-setup:1.29.1@sha256:" + "b".repeat(64) };
  const secrets = { postgresPassword: "pw", sessionSecret: "ss", setupToken: "tt", databaseUrl: "db" };
  const text = renderCompose(images, secrets);

  // Every `ports:` entry must be 127.0.0.1-bound. No 0.0.0.0, no bare host port.
  const portLines = [...text.matchAll(/-\s*"([^"]+:\d+)"/g)].map((m) => m[1]);
  assert.ok(portLines.length >= 3, "expected at least postgres, temporal and temporal-ui ports");
  for (const entry of portLines) {
    assert.ok(entry.startsWith("127.0.0.1:"), `port ${entry} is not bound to 127.0.0.1`);
  }
  assert.ok(!text.includes("0.0.0.0"), "compose must not bind 0.0.0.0");
});

test("renderCompose uses the digest-pinned images verbatim", () => {
  const images = readPinnedImages(readFileSync(TEMPLATE, "utf8"));
  const secrets = { postgresPassword: "pw", sessionSecret: "ss", setupToken: "tt", databaseUrl: "db" };
  const text = renderCompose(images, secrets);
  assert.ok(text.includes(`image: ${images.postgres}`));
  assert.ok(text.includes(`image: ${images.temporal}`));
});

test("renderCompose namespaced resources never collide with an installed SpaceApp", () => {
  const images = { postgres: "pgvector/pgvector:0.8.3-pg17-trixie@sha256:" + "a".repeat(64), temporal: "temporalio/auto-setup:1.29.1@sha256:" + "b".repeat(64) };
  const secrets = { postgresPassword: "pw", sessionSecret: "ss", setupToken: "tt", databaseUrl: "db" };
  const text = renderCompose(images, secrets);

  // No install-owned volumes, no install-owned container names.
  for (const forbidden of ["spaceapp-data", "spaceapp-postgres", "spaceapp-memory", "spaceapp-cli-socket", "container_name:"]) {
    assert.ok(!text.includes(forbidden), `dev compose must not reference ${forbidden}`);
  }
  // Its own volume and its own network.
  assert.ok(text.includes("postgres-data:"));
  assert.ok(text.includes("devstack:"));
});

test("dev-stack ports do not collide with an installed SpaceApp on 4910/4911", () => {
  assert.notEqual(PORTS.api, 4910);
  assert.notEqual(PORTS.web, 4911);
  assert.notEqual(PORTS.api, PORTS.web);
  assert.notEqual(PORTS.postgres, 5432);
  assert.notEqual(PORTS.temporal, 7233);
  for (const [name, port] of Object.entries(PORTS)) {
    assert.ok(Number.isInteger(port) && port > 1024 && port < 65536, `${name} port out of range: ${port}`);
    assert.ok(port !== 4910 && port !== 4911, `${name} port collides with an installed SpaceApp`);
  }
});

test("the dev stack never enables the dev-login shortcut", () => {
  const source = readFileSync(join(repoRoot, "scripts/dev-stack.mjs"), "utf8");
  // The API's own `dev` script sets SPACE_DEV_LOGIN=true; this orchestrator must not.
  const devLoginLines = [...source.matchAll(/SPACE_DEV_LOGIN:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(devLoginLines.length >= 1, "dev-stack must set SPACE_DEV_LOGIN explicitly");
  for (const value of devLoginLines) assert.equal(value, "false");
});

test("gitignore covers the dev-stack state directory", () => {
  const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".dev-stack/"), ".gitignore must ignore .dev-stack/");
});

test("readPinnedOpenCode reads the pinned OpenCode version from the Dockerfile", () => {
  const version = readPinnedOpenCode(readFileSync(DOCKERFILE, "utf8"));
  // Must be an exact semver pin — the pane's CLI comes from here, so a range
  // would let the dev stack and the shipped image drift apart.
  assert.match(version, /^\d+\.\d+\.\d+$/, `opencode-ai pin "${version}" is not an exact version`);

  // And it must be the literal string the Dockerfile installs.
  const dockerfile = readFileSync(DOCKERFILE, "utf8");
  assert.ok(dockerfile.includes(`opencode-ai@${version}`), "pin not found verbatim in Dockerfile");
});

test("readPinnedOpenCode fails closed when the pin is missing", () => {
  assert.throws(() => readPinnedOpenCode("RUN npm install --global opencode-ai\n"), /pinned opencode-ai version/);
  assert.throws(() => readPinnedOpenCode("RUN npm install --global opencode-ai@latest\n"), /pinned opencode-ai version/);
});

test("dev-stack installs OpenCode into the state directory, never globally", () => {
  const source = readFileSync(join(repoRoot, "scripts", "dev-stack.mjs"), "utf8");
  // `npm install --prefix <stateDir>` scopes the install to the state dir.
  assert.ok(source.includes('"--prefix", stateDir'), "OpenCode must be installed with --prefix into the state directory");
  // And it must not use `--global`/`-g`, which would touch the user's npm prefix.
  assert.ok(!source.includes('"--global"') && !source.includes('"-g"'), "OpenCode must not be installed globally");
});
