import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Import only the pure helpers. The CLI entry is guarded behind `invokedDirectly`.
// pathToFileURL keeps this working on Windows, where a bare `d:\...` path is not
// a valid ESM specifier.
const devStack = await import(pathToFileURL(join(repoRoot, "scripts", "dev-stack.mjs")).href);
const { readPinnedImages, readPinnedOpenCode, generateSecrets, readSecrets, renderCompose, parseContainerState, waitForInfrastructure, buildServiceEnv, SETUP_TOKEN_FILE_VAR, PORTS, OPENCODE_PARITY_COMMAND, renderOpenCodeWrapper, writeOpenCodeWrapper } = devStack;
// The teardown helpers stay off the module's public surface; they are reachable
// through `__testing` with the rest of the internals these tests pin.
const { signalProcessTree, processTreeAlive, stopProcessTrees, readPidFile, sleepSync } = devStack.__testing;

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

test("only the password a container reads is 0644; the host-only secrets stay 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "devstack-secrets-"));
  try {
    const secrets = generateSecrets(dir);

    for (const name of ["postgres-password", "session-secret", "setup-token", "database-url"]) {
      assert.ok(existsSync(join(dir, name)), `${name} missing`);
    }

    // Windows has no POSIX mode bits, so every half of this is POSIX-only (see
    // generateSecrets).
    if (process.platform !== "win32") {
      // The directory is the real door, and the reason one 0644 file is safe.
      // At 0700 no other local user can traverse into `secrets/` to reach it,
      // which is what closes the "secrets in directories other local users may
      // traverse" finding and is stricter than the installed app's directory.
      const dirMode = statSync(dir).mode & 0o777;
      assert.equal(dirMode, 0o700, `secrets dir mode is ${dirMode.toString(8)}, expected 0700`);

      // postgres-password is the ONLY secret that crosses into a container, and
      // the container reads it as a non-root user: temporalio/auto-setup:1.29.1
      // declares `User: temporal` and its entrypoint runs
      // `cat /run/secrets/postgres-password`. At 0600 that cat fails with
      // `Permission denied`, temporal crash-loops, the worker dialing it exits
      // 1 and dev-stack tears the whole stack down — measured, not theorised:
      // CI run 38892278575 failed exactly this way with postgres Healthy.
      const containerMode = statSync(join(dir, "postgres-password")).mode & 0o777;
      assert.equal(
        containerMode,
        0o644,
        "postgres-password is bind-mounted and read by a non-root container user"
      );

      // These four never leave the host: session-secret and database-url travel
      // as environment values, setup-token is read by the API through
      // SPACE_SETUP_TOKEN_FILE, and owner-only.env is the developer-facing copy.
      for (const name of ["session-secret", "setup-token", "database-url", "owner-only.env"]) {
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

test("an existing state directory is moved to the declared mode in both directions", () => {
  // A state directory written by an earlier version of this script can carry any
  // mode. generateSecrets must land each file on its declared mode anyway,
  // because writeFileSync only applies `mode` when it creates the file — an
  // existing file keeps whatever bits it already had. Only the re-chmod makes
  // the contract hold on every pass, not just on a fresh state directory.
  const dir = mkdtempSync(join(tmpdir(), "devstack-secret-repair-"));
  try {
    generateSecrets(dir);
    if (process.platform !== "win32") {
      // A host secret left readable by others is tightened.
      const hostOnly = join(dir, "session-secret");
      chmodSync(hostOnly, 0o644);
      assert.equal(statSync(hostOnly).mode & 0o777, 0o644);

      // And the one container secret left unreadable by the container is opened
      // back up. Without this direction an older 0600 state directory would
      // crash-loop temporal forever, with no way out but `rm -rf .dev-stack`.
      const container = join(dir, "postgres-password");
      chmodSync(container, 0o600);
      assert.equal(statSync(container).mode & 0o777, 0o600);

      // A directory an older run left world-traversable is narrowed.
      chmodSync(dir, 0o755);
      assert.equal(statSync(dir).mode & 0o777, 0o755);

      generateSecrets(dir);

      assert.equal(statSync(hostOnly).mode & 0o777, 0o600, "the second pass must tighten the mode");
      assert.equal(statSync(container).mode & 0o777, 0o644, "the container secret must be readable again");
      assert.equal(statSync(dir).mode & 0o777, 0o700, "the secrets directory must be narrowed");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the developer-facing copy of the secrets is owner-only", () => {
  // owner-only.env is the convenience copy of the same values. Like every other
  // file here it is never bound into a container and stays 0600.
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

test("only postgres-password is mounted into a container, so it is the only one that may be 0644", () => {
  // This is the contract that decides the modes. Of the four generated secrets
  // exactly one is handed to a container: postgres-password, declared under the
  // compose file's top-level `secrets:`. session-secret and database-url travel
  // as environment values and setup-token is read by the API on the host, so
  // none of the three has to be readable by any container user — and that is why
  // they can hold 0600 while the mounted one cannot.
  //
  // This test is what keeps the split honest: if a later change mounts another
  // secret, the reasoning in generateSecrets stops holding and this fails first,
  // before the mode is wrong in a way only CI would notice.
  const images = { postgres: "pgvector/pgvector:0.8.3-pg17-trixie@sha256:" + "a".repeat(64), temporal: "temporalio/auto-setup:1.29.1@sha256:" + "b".repeat(64) };
  // Long, distinctive values: a short value like "pw" would match inside an
  // ordinary word such as "password" and make the value-leak assertion lie.
  const secrets = {
    postgresPassword: "ZZQQPOSTGRESVALUEZZ",
    sessionSecret: "ZZQQSESSIONVALUEZZ",
    setupToken: "ZZQQSETUPVALUEZZ",
    databaseUrl: "postgresql://ZZQQDBVALUEZZ@127.0.0.1:5432/db"
  };
  const text = renderCompose(images, secrets);

  const mounted = text.slice(text.indexOf("\nsecrets:\n"));
  assert.ok(mounted.includes("postgres-password"), "postgres-password must be mounted");
  for (const name of ["session-secret", "setup-token", "database-url"]) {
    assert.ok(!mounted.includes(name), `${name} must not be mounted into a container`);
  }

  // No secret value is ever written into the generated file, not even the one
  // that is mounted: it reaches the container as a file the runtime reads.
  for (const value of Object.values(secrets)) {
    assert.ok(!text.includes(value), `${value} must not appear in the compose text`);
  }
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

test("the pane command is named exactly what the API's descriptor fixes", () => {
  // Regression: the first run that reached the pane step got
  //   503 CLI_RUNTIME_DISABLED
  //   "Command opencode-vscode-parity was not executable inside
  //    SPACE_CLI_COMMAND_PATH for the space service user."
  // The API does not run `opencode`; it probes SPACE_CLI_COMMAND_PATH for a file
  // named after the descriptor's commandName and gates on access(X_OK)
  // (apps/api/src/cli-runtimes.ts detectCommand). Renaming either side breaks
  // pane startup, so pin the two together here instead of restating a literal.
  const descriptors = readFileSync(join(repoRoot, "apps/api/src/cli-runtime-descriptors.ts"), "utf8");
  const opencodeBlock = descriptors.slice(descriptors.indexOf('key: "opencode"'));
  const descriptorCommandName = opencodeBlock.match(/commandName:\s*"([^"]+)"/)?.[1];
  assert.ok(descriptorCommandName, "the opencode descriptor must declare a commandName");
  assert.equal(
    descriptorCommandName,
    OPENCODE_PARITY_COMMAND,
    "the wrapper file name and apps/api/src/cli-runtime-descriptors.ts must agree"
  );

  // Executability, not mere existence, is the contract.
  const runtimes = readFileSync(join(repoRoot, "apps/api/src/cli-runtimes.ts"), "utf8");
  assert.match(
    runtimes,
    /access\(\s*\w+,\s*constants\.X_OK/,
    "detectCommand must gate on X_OK, so the wrapper needs the execute bit"
  );
});

test("renderOpenCodeWrapper isolates provider state and execs the pinned launcher", () => {
  const stateDir = join(repoRoot, ".dev-stack");
  const script = renderOpenCodeWrapper(stateDir);
  const providerRoot = join(stateDir, "providers", "opencode");
  const launcher = join(stateDir, "node_modules", ".bin", "opencode");

  assert.ok(script.startsWith("#!/bin/sh"), "the wrapper must be a POSIX sh script");

  // Provider state lives under the state directory, mirroring the opencode
  // branch of deploy/docker/public-cli-wrapper.sh, which redirects it under
  // /var/lib/spaceapp-cli/providers/<runtime>. The script anchors everything on
  // one `state_root`, so assert that anchor and then that each variable uses it.
  assert.ok(script.includes(`state_root="${providerRoot}"`), "state_root must be the provider root");
  assert.ok(script.includes('export HOME="$state_root"'), "HOME must point at the provider root");
  assert.ok(script.includes('export TMPDIR="$state_root/tmp"'), "TMPDIR must stay under the provider root");
  for (const variable of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
    assert.ok(script.includes(`export ${variable}="$state_root/`), `${variable} must stay under the provider root`);
  }

  // The state-dir install, never a PATH lookup that could find a global one.
  assert.ok(script.includes(`exec "${launcher}" "$@"`), "the wrapper must exec the pinned launcher with every argument");
  assert.ok(!/exec\s+opencode\b/.test(script), "the wrapper must not resolve opencode from PATH");

  // The API appends --run-inner when it resumes a native session.
  assert.ok(script.includes('"--run-inner"'), "the wrapper must tolerate --run-inner");
});

test("writeOpenCodeWrapper writes an executable file where the API looks for it", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "devstack-wrapper-"));
  try {
    const { binDir, commandPath } = writeOpenCodeWrapper(stateDir);

    assert.equal(basename(commandPath), OPENCODE_PARITY_COMMAND);
    assert.equal(dirname(commandPath), binDir);
    assert.equal(binDir, join(stateDir, "bin"));
    assert.ok(existsSync(commandPath), "the wrapper must exist");
    assert.ok(statSync(commandPath).isFile(), "the wrapper must be a regular file, not a directory");

    // detectCommand runs access(candidate, X_OK). Windows has no execute bit and
    // its X_OK check only proves existence, so the mode assertion is POSIX-only.
    if (process.platform !== "win32") {
      const mode = statSync(commandPath).mode & 0o777;
      assert.ok(mode & 0o111, `wrapper mode ${mode.toString(8)} is not executable`);
    }

    // `up` runs again on an existing state directory, so regenerating must not
    // fail and must not need a network round trip.
    writeOpenCodeWrapper(stateDir);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("buildServiceEnv points the CLI command path at the wrapper directory", () => {
  // A temp state directory, so running the tests never writes into the repo.
  const stateDir = mkdtempSync(join(tmpdir(), "devstack-clipath-"));
  try {
    const { binDir, commandPath } = writeOpenCodeWrapper(stateDir);
    const env = buildServiceEnv(
      { setupToken: "x".repeat(64), sessionSecret: "s", databaseUrl: "postgresql://u:p@127.0.0.1:1/db" },
      { version: "0.0.0", binDir, commandPath }
    );

    assert.equal(env.SPACE_CLI_ENABLED, "true");
    assert.equal(env.SPACE_CLI_COMMAND_PATH, binDir, "SPACE_CLI_COMMAND_PATH must be the directory holding the wrapper");
    // The API resolves commandName inside that directory; a path would make
    // commandNameIsSafe reject it.
    assert.equal(basename(join(env.SPACE_CLI_COMMAND_PATH, OPENCODE_PARITY_COMMAND)), OPENCODE_PARITY_COMMAND);
    assert.ok((env.PATH ?? "").startsWith(`${binDir}${process.platform === "win32" ? ";" : ":"}`));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Teardown. `down` and `reset` have to reach a whole process tree, and the
// acceptance contract's last CI step checks that reset leaves nothing behind.
// ---------------------------------------------------------------------------

test("readPidFile survives a missing, truncated or hand-edited pid file", () => {
  // `down` must not throw before it has stopped anything: the containers would
  // come down while the host processes kept running.
  const dir = mkdtempSync(join(tmpdir(), "devstack-pidfile-"));
  const path = join(dir, "dev-stack.pids.json");
  try {
    assert.deepEqual(readPidFile(path), [], "a missing pid file means nothing to stop");

    writeFileSync(path, '{"not":"an array"}', "utf8");
    assert.deepEqual(readPidFile(path), [], "a non-array is not a pid list");

    writeFileSync(path, '[{"name":"api","pid":', "utf8");
    assert.deepEqual(readPidFile(path), [], "a truncated file must not throw");

    writeFileSync(path, JSON.stringify([
      { name: "api", pid: 4242 },
      { name: "init", pid: 1 },
      { name: "junk", pid: "nope" },
      { name: "nopid" }
    ]), "utf8");
    // pid 1 is init and a non-integer is not a pid. Signalling either is how a
    // teardown takes out something it never started.
    assert.deepEqual(readPidFile(path), [{ name: "api", pid: 4242 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("teardown reaches a child's own children, not just the leader it recorded", () => {
  // Regression: `down` and `reset` signalled only the pid recorded at spawn
  // time. spawnService starts every child with `detached`, so that pid is a
  // process-group leader and the workers it forked — `npx tsx watch`, `vite` —
  // survived the teardown.
  if (process.platform === "win32") {
    // Windows has no POSIX process groups; signalProcessTree goes through
    // taskkill /T there and needs a real console process to prove anything,
    // which a unit test cannot create reliably.
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "devstack-tree-"));
  const marker = join(dir, "grandchild.pid");
  // A leader that forks a grandchild and then idles: the shape `npx tsx watch`
  // produces. The grandchild outlives a leader-only signal.
  const leaderScript = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    "writeFileSync(process.argv[1], String(grandchild.pid));",
    "setInterval(() => {}, 1000);"
  ].join("\n");

  const leader = spawn(process.execPath, ["-e", leaderScript, marker], { detached: true, stdio: "ignore" });
  leader.unref();

  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(marker) && Date.now() < deadline) sleepSync(50);
    assert.ok(existsSync(marker), "the leader never recorded its grandchild");

    const grandchildPid = Number(readFileSync(marker, "utf8"));
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1, `bad grandchild pid ${grandchildPid}`);
    assert.ok(processTreeAlive(grandchildPid), "the grandchild should be running before teardown");

    assert.equal(stopProcessTrees([{ name: "fixture", pid: leader.pid }]), 1);

    assert.ok(!processTreeAlive(leader.pid), "the leader must be gone");
    assert.ok(!processTreeAlive(grandchildPid), "the grandchild must be gone too");
  } finally {
    // Never leave the fixture behind if an assertion above failed.
    signalProcessTree(leader.pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
