import assert from "node:assert/strict";
import test from "node:test";
import {
  generateDevComposeYaml,
  parsePinnedImages,
  parsePinnedOpencodeVersion,
  resolveDevStackConfig,
  validatePort
} from "../dev-stack.mjs";

/**
 * Verifies that parsePinnedImages accurately extracts the pinned image tags and digests.
 */
test("parsePinnedImages extracts exact digests for postgres and temporal", () => {
  const sampleCompose = `
services:
  postgres:
    image: pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b
  temporal:
    image: temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312
`;
  const images = parsePinnedImages(sampleCompose);
  assert.equal(images.postgres, "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b");
  assert.equal(images.temporal, "temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312");

  assert.throws(() => parsePinnedImages("services: {}"), /Failed to extract pinned/);
});

/**
 * Verifies that parsePinnedOpencodeVersion extracts the pinned semver from Dockerfile.
 */
test("parsePinnedOpencodeVersion extracts exact version from Dockerfile", () => {
  const sampleDockerfile = `
RUN npm install --global --no-audit --no-fund opencode-ai@1.18.4 \\
    && opencode --version
`;
  const version = parsePinnedOpencodeVersion(sampleDockerfile);
  assert.equal(version, "1.18.4");

  assert.throws(() => parsePinnedOpencodeVersion("FROM node:22"), /Failed to extract pinned opencode-ai/);
});

/**
 * Verifies that validatePort strictly rejects out-of-range or non-integer port numbers.
 */
test("validatePort validates range 1-65535 and rejects invalid values", () => {
  assert.equal(validatePort("testPort", 80), 80);
  assert.equal(validatePort("testPort", 65535), 65535);

  assert.throws(() => validatePort("testPort", 0), /Invalid port for testPort: 0/);
  assert.throws(() => validatePort("testPort", -1), /Invalid port for testPort: -1/);
  assert.throws(() => validatePort("testPort", 65536), /Invalid port for testPort: 65536/);
  assert.throws(() => validatePort("testPort", 72339), /Invalid port for testPort: 72339/);
  assert.throws(() => validatePort("testPort", Number.NaN), /Invalid port for testPort/);
});

/**
 * Verifies that resolveDevStackConfig applies isolated defaults and parses environment overrides.
 */
test("resolveDevStackConfig respects port and directory overrides while defaulting to 127.0.0.1 isolated ports", () => {
  const defaultConfig = resolveDevStackConfig({});
  assert.equal(defaultConfig.webPort, 5911);
  assert.equal(defaultConfig.apiPort, 5910);
  assert.equal(defaultConfig.postgresPort, 54329);
  assert.equal(defaultConfig.temporalPort, 57233);
  assert.match(defaultConfig.stateRoot, /\\.dev-stack$/);

  const customConfig = resolveDevStackConfig({
    SPACEAPP_DEV_STATE_ROOT: "custom-state",
    SPACEAPP_DEV_WEB_PORT: "6911",
    SPACEAPP_DEV_API_PORT: "6910",
    SPACEAPP_DEV_POSTGRES_PORT: "54330",
    SPACEAPP_DEV_TEMPORAL_PORT: "57234",
    SPACEAPP_DEV_PROJECT: "custom-project"
  });
  assert.equal(customConfig.webPort, 6911);
  assert.equal(customConfig.apiPort, 6910);
  assert.equal(customConfig.postgresPort, 54330);
  assert.equal(customConfig.temporalPort, 57234);
  assert.equal(customConfig.composeProject, "custom-project");
  assert.match(customConfig.stateRoot, /custom-state$/);

  assert.throws(
    () => resolveDevStackConfig({ SPACEAPP_DEV_TEMPORAL_PORT: "99999" }),
    /Invalid port for temporalPort: 99999/
  );
});

/**
 * Verifies that generateDevComposeYaml produces standard secrets and 127.0.0.1-bound configurations.
 */
test("generateDevComposeYaml creates isolated compose configuration strictly bound to 127.0.0.1 with secrets", () => {
  const yaml = generateDevComposeYaml({
    postgresImage: "pgvector/pgvector:0.8.3",
    temporalImage: "temporalio/auto-setup:1.29.1",
    postgresPort: 54329,
    temporalPort: 57233,
    secretsDir: "/path/to/secrets",
    composeProject: "test-dev-project"
  });

  assert.match(yaml, /name: test-dev-project/);
  assert.match(yaml, /"127\.0\.0\.1:54329:5432"/);
  assert.match(yaml, /"127\.0\.0\.1:57233:7233"/);
  assert.doesNotMatch(yaml, /0\.0\.0\.0/);
  assert.match(yaml, /secrets:\s*\n\s*postgres-password:\s*\n\s*file:/);
  assert.match(yaml, /image: pgvector\/pgvector:0\.8\.3/);
  assert.match(yaml, /image: temporalio\/auto-setup:1\.29\.1/);
});
