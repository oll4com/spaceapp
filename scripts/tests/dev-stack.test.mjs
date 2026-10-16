import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Import only the pure helpers. The CLI entry is guarded behind `invokedDirectly`.
// pathToFileURL keeps this working on Windows, where a bare `d:\...` path is not
// a valid ESM specifier.
const { readPinnedImages, readPinnedOpenCode, generateSecrets, readSecrets, renderCompose, parseContainerState, waitForInfrastructure, buildServiceEnv, SETUP_TOKEN_FILE_VAR, PORTS } =
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

test("generateSecrets returns the database URL that migrations need", () => {
  // Regression: cmdUp passes `SPACE_DATABASE_URL: secrets.databaseUrl` to
  // packages/db/dist/migrate.js. generateSecrets() used to return only the raw
  // pieces, so the URL was undefined and every run died on
  // "SPACE_DATABASE_URL or DATABASE_URL is required to run migrations."
  const dir = mkdtempSync(join(tmpdir(), "spaceapp-devstack-test-"));
  try {
    const secrets = generateSecrets(dir);
    assert.equal(typeof secrets.databaseUrl, "string", "generateSecrets must return databaseUrl");
    assert.match(secrets.databaseUrl, /^postgresql:\/\/spaceapp:[^:@/]+@127\.0\.0\.1:\d+\/spaceapp$/);
    assert.ok(secrets.databaseUrl.includes(secrets.postgresPassword), "the URL must carry the generated password");
    assert.equal(readSecrets(dir).databaseUrl, secrets.databaseUrl, "what is written must be what is read back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForInfrastructure treats a healthy postgres and a running temporal as ready", () => {
  // A container being `running` is enough for Temporal: its image healthcheck
  // shells out to the `temporal` CLI, which is not a dependency this script
  // takes on. PostgreSQL has to actually report healthy.
  const ready = waitForInfrastructure.toString();
  assert.match(ready, /postgres\.status === "running"/, "postgres must be running");
  assert.match(ready, /postgres\.health === "healthy"/, "postgres must report healthy");
  assert.match(ready, /temporal\.status === "running"/, "temporal only has to be running");
  assert.doesNotMatch(ready, /--wait/, "the readiness wait must not delegate to `compose up --wait`");
});

test("parseContainerState reads the status and health fields docker inspect joins", () => {
  // `docker inspect --format "{{.State.Status}} {{.State.Health.Status}}"`
  // renders "running healthy". Treating that string as if it began with the
  // health word never matches, which stalled the stack until the 180s timeout
  // even though both containers were up.
  assert.deepEqual(parseContainerState("running healthy"), { raw: "running healthy", status: "running", health: "healthy" });
  assert.deepEqual(parseContainerState("  running healthy\n"), { raw: "running healthy", status: "running", health: "healthy" });
  // An image with no healthcheck renders the status alone.
  assert.deepEqual(parseContainerState("running"), { raw: "running", status: "running", health: "" });
  assert.deepEqual(parseContainerState("exited"), { raw: "exited", status: "exited", health: "" });
  assert.deepEqual(parseContainerState("restarting unhealthy"), { raw: "restarting unhealthy", status: "restarting", health: "unhealthy" });
  assert.deepEqual(parseContainerState(""), { raw: "", status: "", health: "" });
  assert.deepEqual(parseContainerState(undefined), { raw: "", status: "", health: "" });
});

test("container secrets are world-readable so non-root container users can mount them", () => {
  const dir = mkdtempSync(join(tmpdir(), "devstack-secrets-"));
  try {
    const secrets = generateSecrets(dir);

    for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
      assert.ok(existsSync(join(dir, name)), `${name} missing`);
    }

    // POSIX: the four compose-mounted secrets must be 0644, exactly as
    // packages/run-spaceapp/tests/cli.test.mjs:775 asserts. The temporalio/
    // auto-setup entrypoint does `cat /run/secrets/postgres-password` as a
    // non-root user; 0600 makes that EACCES and the container crash-loops.
    // Windows has no POSIX mode bits, so the assertion is meaningful only on
    // POSIX (see generateSecrets).
    if (process.platform !== "win32") {
      for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
        const mode = statSync(join(dir, name)).mode & 0o777;
        assert.equal(mode, 0o644, `${name} mode is ${mode.toString(8)}, expected 0644`);
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

test("buildServiceEnv hands the owner setup token over as a file, the only form the API reads", () => {
  // Regression: the first CI run that got /readyz to report ok still failed at
  // `POST /api/setup/claim` with 409 "The SpaceApp setup token is not valid.",
  // because GET /api/setup/status answered `expiresAt: null` — loading the token
  // from a plain environment value never registers it.
  const env = buildServiceEnv(
    { setupToken: "x".repeat(64), sessionSecret: "s", databaseUrl: "postgresql://u:p@127.0.0.1:1/db" },
    { binDir: join(repoRoot, ".dev-stack", "bin") }
  );

  assert.ok(env[SETUP_TOKEN_FILE_VAR], `${SETUP_TOKEN_FILE_VAR} missing from the service environment`);
  assert.equal(env.SPACE_SETUP_TOKEN, undefined, "the API never reads a plain SPACE_SETUP_TOKEN value");
  assert.equal(SETUP_TOKEN_FILE_VAR, "SPACE_SETUP_TOKEN_FILE");

  // And the path has to be the generated secret, not something else.
  const tokenPath = env[SETUP_TOKEN_FILE_VAR];
  assert.equal(basename(tokenPath), "setup-token");
  assert.equal(basename(dirname(tokenPath)), "secrets");
  assert.equal(basename(dirname(dirname(tokenPath))), ".dev-stack");
});

test("the setup token env var is the one apps/api/src/owner-setup.ts actually reads", () => {
  // This is the cross-file half of the contract. Asserting a string literal in
  // our own source would pass even if the API renamed the variable, so read the
  // consumer and pin the name to it.
  const ownerSetup = readFileSync(join(repoRoot, "apps/api/src/owner-setup.ts"), "utf8");
  assert.ok(
    ownerSetup.includes(`env.${SETUP_TOKEN_FILE_VAR}`),
    `apps/api/src/owner-setup.ts no longer reads env.${SETUP_TOKEN_FILE_VAR}`
  );

  // deploy/docker/core-entrypoint.sh hands its container the same variable —
  // scripts/tests/public-docker-distribution.test.mjs:191 asserts that half.
  const entrypoint = readFileSync(join(repoRoot, "deploy/docker/core-entrypoint.sh"), "utf8");
  assert.ok(
    entrypoint.includes(`export ${SETUP_TOKEN_FILE_VAR}`),
    `deploy/docker/core-entrypoint.sh no longer exports ${SETUP_TOKEN_FILE_VAR}`
  );
});

test("the token file the API is handed exists and survives the API's own validator", () => {
  const dir = mkdtempSync(join(tmpdir(), "devstack-tokenfile-"));
  try {
    const secrets = generateSecrets(dir);
    const tokenPath = join(dir, "setup-token");

    // loadOwnerSetupBootstrap rejects anything but a regular file, and only up
    // to 4 KiB (apps/api/src/owner-setup.ts:33), so the generated secret has to
    // be plain, small and newline-free — it strips only a trailing newline.
    assert.ok(statSync(tokenPath).isFile());
    assert.ok(statSync(tokenPath).size <= 4 * 1024);

    const token = readFileSync(tokenPath, "utf8").replace(/[\r\n]+$/, "");
    assert.equal(token, secrets.setupToken);
    assert.equal(token, readFileSync(tokenPath, "utf8"), "no trailing newline to strip");

    // The same bounds createOwnerSetupBootstrap enforces.
    assert.ok(token.length >= 32 && token.length <= 500);
    assert.ok(!/[\0\r\n]/.test(token));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stray 0600 container secret is repaired to 0644 on the next pass", () => {
  // Regression: the first CI run died with `cat: can't open
  // '/run/secrets/postgres-password': Permission denied` and temporal stuck in
  // Restarting (1). packages/run-spaceapp/tests/cli.test.mjs:778 chmods a secret
  // to 0600 and expects initializeInstallation to repair it; generateSecrets
  // must do the same so an already-populated state directory cannot wedge.
  const dir = mkdtempSync(join(tmpdir(), "devstack-secret-repair-"));
  try {
    generateSecrets(dir);
    if (process.platform !== "win32") {
      const path = join(dir, "postgres-password");
      chmodSync(path, 0o600);
      assert.equal(statSync(path).mode & 0o777, 0o600);

      generateSecrets(dir);
      assert.equal(statSync(path).mode & 0o777, 0o644, "the second pass must repair the mode");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the developer-facing copy of the secrets is owner-only", () => {
  // owner-only.env is never bound into a container, so the 0600 requirement
  // applies to it. It must carry the same values the containers see.
  const dir = mkdtempSync(join(tmpdir(), "devstack-owner-only-"));
  try {
    const secrets = generateSecrets(dir);
    const ownerOnly = join(dir, "owner-only.env");
    assert.ok(existsSync(ownerOnly), "owner-only.env missing");

    if (process.platform !== "win32") {
      assert.equal(statSync(ownerOnly).mode & 0o777, 0o600, "owner-only.env must be 0600");
    }

    const text = readFileSync(ownerOnly, "utf8");
    assert.ok(text.includes(`DATABASE_URL=${secrets.databaseUrl}`));
    assert.ok(text.includes(`SPACE_SESSION_SECRET=${secrets.sessionSecret}`));
    assert.ok(text.includes(`SPACE_OWNER_SETUP_TOKEN=${secrets.setupToken}`));
    assert.ok(text.startsWith("#"), "the copy must be labelled");
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

test("renderCompose keeps the dev network routable, as the shipped template does", () => {
  const images = { postgres: "pgvector/pgvector:0.8.3-pg17-trixie@sha256:" + "a".repeat(64), temporal: "temporalio/auto-setup:1.29.1@sha256:" + "b".repeat(64) };
  const secrets = { postgresPassword: "pw", sessionSecret: "ss", setupToken: "tt", databaseUrl: "db" };
  const text = renderCompose(images, secrets);

  // An `internal: true` network has no egress, and temporalio/auto-setup then
  // crash-loops: the first CI run on GitHub left temporal in `Restarting (1)`.
  // The shipped template says `internal: false`; the dev stack must agree.
  assert.match(text, /devstack:\s*\r?\n\s*internal: false/);
  assert.ok(!/internal: true/.test(text), "the dev network must not be internal");
});

test("waitForInfrastructure prints each container's logs before giving up", () => {
  const source = waitForInfrastructure.toString();
  // A crash-looping service only says "restarting"; the reason is in its own
  // output. The failure has to include it instead of leaving one `docker logs` away.
  assert.match(source, /docker", \["logs"/);
  assert.match(source, /docker logs/);
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
