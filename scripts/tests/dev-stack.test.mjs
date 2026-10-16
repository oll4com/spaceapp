import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildApiEnv,
  buildCliHostEnv,
  buildWorkerEnv,
  cliSocketPath,
  DEV_DATABASE_NAME,
  ensurePtySpawnHelpers,
  ensureSecrets,
  parseOpencodePin,
  parsePinnedImages,
  renderCompose,
  renderOpencodeWrapper,
  resolveConfig
} from "../dev-stack.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeTemplate = readFileSync(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

describe("parsePinnedImages", () => {
  it("reads the postgres and temporal images from the real compose template", () => {
    const images = parsePinnedImages(composeTemplate);
    assert.match(images.postgres, /^pgvector\/pgvector:.+@sha256:[0-9a-f]{64}$/);
    assert.match(images.temporal, /^temporalio\/auto-setup:.+@sha256:[0-9a-f]{64}$/);
  });

  it("returns exactly the strings the template declares, character for character", () => {
    const images = parsePinnedImages(composeTemplate);
    for (const image of Object.values(images)) {
      assert.ok(composeTemplate.includes(`image: ${image}`), `${image} must come from the template`);
    }
  });

  it("fails closed when a digest is missing", () => {
    const doctored = composeTemplate.replace(/pgvector\/pgvector:[^\s]+@sha256:[0-9a-f]{64}/, "pgvector/pgvector:0.8.3-pg17-trixie");
    assert.throws(() => parsePinnedImages(doctored), /not pinned by digest/);
  });

  it("fails closed when a service image is absent", () => {
    assert.throws(() => parsePinnedImages("services:\n  postgres:\n    image: x@sha256:" + "a".repeat(64) + "\n"), /temporal/);
  });
});

describe("parseOpencodePin", () => {
  it("reads the pinned opencode-ai version from the real Dockerfile", () => {
    const pin = parseOpencodePin(dockerfile);
    assert.match(pin, /^\d+\.\d+\.\d+$/);
    assert.ok(dockerfile.includes(`opencode-ai@${pin}`));
  });

  it("fails closed when the pin is absent", () => {
    assert.throws(() => parseOpencodePin("FROM node:22\n"), /opencode-ai/);
  });
});

describe("resolveConfig", () => {
  it("defaults to the isolated dev ports and the .dev-stack state directory", () => {
    const cfg = resolveConfig({}, "/repo");
    assert.deepEqual(cfg.ports, { api: 5910, web: 5911, postgres: 55432, temporal: 57233 });
    assert.equal(cfg.stateDir, "/repo/.dev-stack");
    assert.equal(cfg.project, "spaceapp-dev-stack");
  });

  it("honours port overrides from the environment", () => {
    const cfg = resolveConfig({ SPACE_DEV_API_PORT: "6010", SPACE_DEV_POSTGRES_PORT: "65432" }, "/repo");
    assert.equal(cfg.ports.api, 6010);
    assert.equal(cfg.ports.postgres, 65432);
    assert.equal(cfg.ports.web, 5911);
  });

  it("refuses ports that collide with an installed SpaceApp", () => {
    assert.throws(() => resolveConfig({ SPACE_DEV_API_PORT: "4910" }, "/repo"), /collides with an installed SpaceApp/);
    assert.throws(() => resolveConfig({ SPACE_DEV_WEB_PORT: "4911" }, "/repo"), /collides with an installed SpaceApp/);
  });

  it("refuses two services on the same port and non-numeric ports", () => {
    assert.throws(() => resolveConfig({ SPACE_DEV_API_PORT: "5911" }, "/repo"), /must be distinct/);
    assert.throws(() => resolveConfig({ SPACE_DEV_API_PORT: "soon" }, "/repo"), /integer TCP port/);
  });
});

describe("ensureSecrets", () => {
  it("generates 0600 files in a 0700 directory and reuses them on the next call", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-stack-secrets-"));
    try {
      const first = ensureSecrets(dir);
      assert.equal(first.setupToken.length, 64);
      if (process.platform !== "win32") {
        assert.equal(statSync(join(dir, "secrets")).mode & 0o777, 0o700);
        for (const name of ["postgres-password", "session-secret", "setup-token"]) {
          assert.equal(statSync(join(dir, "secrets", name)).mode & 0o777, 0o600, `${name} must be 0600`);
        }
      }
      const second = ensureSecrets(dir);
      assert.equal(second.setupToken, first.setupToken);
      assert.equal(second.postgresPassword, first.postgresPassword);
      assert.equal(second.sessionSecret, first.sessionSecret);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tightens permissions on pre-existing loose secret files", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-stack-secrets-"));
    try {
      ensureSecrets(dir);
      if (process.platform !== "win32") {
        chmodSync(join(dir, "secrets", "session-secret"), 0o644);
        ensureSecrets(dir);
        assert.equal(statSync(join(dir, "secrets", "session-secret")).mode & 0o777, 0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderCompose", () => {
  const cfg = resolveConfig({}, "/repo");
  const dir = mkdtempSync(join(tmpdir(), "dev-stack-compose-"));
  const secrets = ensureSecrets(dir);
  const images = parsePinnedImages(composeTemplate);
  const compose = renderCompose({ ...cfg, stateDir: dir }, images);

  it("uses only the parsed, digest-pinned images", () => {
    assert.ok(compose.includes(`image: ${images.postgres}`));
    assert.ok(compose.includes(`image: ${images.temporal}`));
  });

  it("binds every published port to 127.0.0.1 only", () => {
    const portLines = compose.split("\n").filter((line) => line.includes('127.0.0.1:'));
    assert.equal(portLines.length, 2);
    assert.ok(compose.includes('"127.0.0.1:55432:5432"'));
    assert.ok(compose.includes('"127.0.0.1:57233:7233"'));
    assert.ok(!/^\s*-\s*"\d+:/m.test(compose), "no port may be published on all interfaces");
  });

  it("keeps the install's ports and database out of the dev stack", () => {
    assert.ok(!compose.includes("4910") && !compose.includes("4911"));
    assert.ok(compose.includes(`POSTGRES_DB: ${DEV_DATABASE_NAME}`));
    assert.ok(compose.includes(`name: spaceapp-dev-stack`));
  });

  it("hands the database password over through the compose process environment only", () => {
    assert.ok(compose.includes("POSTGRES_PASSWORD: ${SPACEAPP_DEV_POSTGRES_PASSWORD}"));
    assert.ok(compose.includes("POSTGRES_PWD: ${SPACEAPP_DEV_POSTGRES_PASSWORD}"));
    assert.ok(!compose.includes(secrets.postgresPassword), "the password value itself is never rendered");
    assert.ok(
      !compose.includes("secrets:"),
      "no bind-mounted secret file: a 0600 file is unreadable by the Temporal image's non-root user"
    );
  });
});

describe("instance environments", () => {
  const cfg = resolveConfig({}, "/repo");
  const dir = mkdtempSync(join(tmpdir(), "dev-stack-env-"));
  const secrets = ensureSecrets(dir);
  const apiEnv = buildApiEnv({ ...cfg, stateDir: dir }, secrets);

  it("marks the API as the isolated dev instance", () => {
    assert.equal(apiEnv.SPACE_INSTANCE, "dev");
    assert.equal(apiEnv.SPACE_API_PORT, "5910");
    assert.equal(apiEnv.SPACE_DEV_LOGIN, "false");
    assert.equal(apiEnv.SPACEAPP_WORKFLOWS_ENABLED, "true");
    assert.equal(apiEnv.SPACE_BROWSER_SESSIONS_ENABLED, "false");
  });

  it("points the API at the dev database, namespace and task queue — never the stable defaults", () => {
    assert.ok(apiEnv.SPACE_DATABASE_URL.endsWith(`/${DEV_DATABASE_NAME}`));
    assert.ok(!apiEnv.SPACE_DATABASE_URL.endsWith("/space"));
    assert.equal(apiEnv.SPACE_TEMPORAL_NAMESPACE, "spaceapp-dev");
    assert.notEqual(apiEnv.SPACE_TEMPORAL_NAMESPACE, "default");
    assert.equal(apiEnv.SPACE_TEMPORAL_TASK_QUEUE, "space-agent-turns-dev");
    assert.notEqual(apiEnv.SPACE_TEMPORAL_TASK_QUEUE, "space-agent-turns");
  });

  it("keeps every data root inside the state directory", () => {
    for (const key of ["SPACE_MEMORY_ROOT", "SPACE_MEMORY_GRAPH_ROOT", "SPACE_ARTIFACT_ROOT", "SPACE_CLI_COMMAND_PATH", "SPACE_CLI_WORKSPACE_ROOT", "SPACE_TELEGRAM_SECRET_ROOT"]) {
      assert.ok(apiEnv[key].startsWith(dir), `${key} must live in the state directory, got ${apiEnv[key]}`);
    }
    assert.equal(apiEnv.SPACE_SETUP_TOKEN_FILE, join(dir, "secrets", "setup-token"));
  });

  it("never leaves a writable root at the /opt/spaceapp install default", () => {
    // Regression: on macOS /opt is root-owned, AppDiagnosticsService
    // mkdirs its root eagerly at boot, and the API died with EACCES
    // before ever listening (fork CI run 38951758529, macOS job).
    for (const key of [
      "SPACE_APP_DIAGNOSTICS_ROOT",
      "SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE",
      "SPACE_STREAMING_SECRET_ROOT",
      "SPACE_DEMO_PROJECTS_ROOT",
      "SPACE_DEMO_PROJECTS_VAR_ROOT",
      "SPACE_PROJECTS_ROOT",
      "SPACE_PERSONAL_GIT_ROOT"
    ]) {
      assert.ok(apiEnv[key].startsWith(dir), `${key} must live in the state directory, got ${apiEnv[key]}`);
      assert.ok(!apiEnv[key].startsWith("/opt/spaceapp"), `${key} must not use the install default`);
    }
  });

  it("gives the CLI host the same socket path the API will dial", () => {
    const hostEnv = buildCliHostEnv({ ...cfg, stateDir: dir });
    assert.equal(hostEnv.SPACE_CLI_HOST_SOCKET, apiEnv.SPACE_CLI_HOST_SOCKET);
    assert.ok(existsSync(dir));
  });

  it("gives the worker the dev API port too (its isolation guard checks it for every role)", () => {
    const workerEnv = buildWorkerEnv({ ...cfg, stateDir: dir }, secrets);
    assert.equal(workerEnv.SPACE_API_PORT, "5910");
    assert.equal(workerEnv.SPACE_TEMPORAL_NAMESPACE, "spaceapp-dev");
    assert.ok(workerEnv.SPACE_DATABASE_URL.endsWith(`/${DEV_DATABASE_NAME}`));
  });
});

describe("ensurePtySpawnHelpers", () => {
  it("repairs a non-executable darwin spawn-helper and leaves other platforms alone", () => {
    // Regression: node-pty's published darwin prebuilds ship spawn-helper
    // without +x; every PTY spawn on macOS then fails with EACCES and the
    // pane session never leaves IDLE (fork CI run 38957388065).
    const fakeRoot = mkdtempSync(join(tmpdir(), "dev-stack-pty-"));
    try {
      const helper = join(fakeRoot, "node_modules", "node-pty", "prebuilds", "darwin-x64", "spawn-helper");
      mkdirSync(dirname(helper), { recursive: true });
      writeFileSync(helper, "#!/bin/sh\n");
      chmodSync(helper, 0o644);
      const cfg = { root: fakeRoot };
      assert.deepEqual(ensurePtySpawnHelpers(cfg, "linux"), []);
      assert.equal(statSync(helper).mode & 0o111, 0);
      assert.deepEqual(ensurePtySpawnHelpers(cfg, "darwin"), [helper]);
      assert.ok((statSync(helper).mode & 0o111) !== 0, "spawn-helper must be executable after repair");
      assert.deepEqual(ensurePtySpawnHelpers(cfg, "darwin"), [], "a healthy helper is left untouched");
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});

describe("cliSocketPath", () => {
  it("stays inside the state directory for ordinary checkouts", () => {
    const cfg = resolveConfig({}, "/repo");
    assert.equal(cliSocketPath(cfg), "/repo/.dev-stack/run/cli-host.sock");
  });

  it("falls back to a short tmp path for deeply nested checkouts", () => {
    const deep = "/very/deeply/nested/" + "x".repeat(120);
    const cfg = resolveConfig({}, deep);
    const socket = cliSocketPath(cfg);
    assert.ok(Buffer.byteLength(socket) <= 100, `socket path too long: ${socket}`);
  });
});

describe("renderOpencodeWrapper", () => {
  it("keeps provider state and the OpenCode install inside the state directory", () => {
    const wrapper = renderOpencodeWrapper(resolveConfig({}, "/repo"));
    assert.ok(wrapper.includes('state_root="/repo/.dev-stack/providers/opencode"'));
    assert.ok(wrapper.includes("/repo/.dev-stack/opencode/node_modules/.bin"));
    assert.ok(wrapper.includes("credential-status"));
    assert.ok(wrapper.includes('exec opencode "$@"'));
  });
});
