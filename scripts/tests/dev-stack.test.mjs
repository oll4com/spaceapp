import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_DEV_STACK_PORTS,
  DEV_STACK_BIND_HOST,
  DEV_STACK_PORT_ENV_VARS,
  DEV_STACK_POSTGRES_IMAGE,
  DEV_STACK_PROJECT_NAME,
  DEV_STACK_TEMPORAL_IMAGE,
  buildDevStackComposeYaml,
  devStackChildProcessEnv,
  devStackPortMappings,
  parseComposeServiceImage,
  parseOpencodePackage,
  parseOpencodeVersion,
  resolveDevStackPorts,
} from "../dev-stack-config.mjs";

const DOCKERFILE_PATH = fileURLToPath(new URL("../../Dockerfile", import.meta.url));

describe("resolveDevStackPorts", () => {
  it("returns the default ports for an empty environment", () => {
    assert.deepEqual(resolveDevStackPorts({}), {
      api: 4912,
      web: 4913,
      postgres: 5433,
      temporal: 7234,
    });
    assert.deepEqual(DEFAULT_DEV_STACK_PORTS, {
      api: 4912,
      web: 4913,
      postgres: 5433,
      temporal: 7234,
    });
  });

  it("applies environment overrides for each port", () => {
    const env = {
      [DEV_STACK_PORT_ENV_VARS.api]: "5010",
      [DEV_STACK_PORT_ENV_VARS.web]: "5011",
      [DEV_STACK_PORT_ENV_VARS.postgres]: "5544",
      [DEV_STACK_PORT_ENV_VARS.temporal]: "7235",
    };

    assert.deepEqual(resolveDevStackPorts(env), {
      api: 5010,
      web: 5011,
      postgres: 5544,
      temporal: 7235,
    });
  });

  it("falls back to defaults for garbage values", () => {
    for (const garbage of ["abc", "0", "99999", "12.5"]) {
      const env = {
        [DEV_STACK_PORT_ENV_VARS.api]: garbage,
        [DEV_STACK_PORT_ENV_VARS.web]: garbage,
        [DEV_STACK_PORT_ENV_VARS.postgres]: garbage,
        [DEV_STACK_PORT_ENV_VARS.temporal]: garbage,
      };

      assert.deepEqual(
        resolveDevStackPorts(env),
        { api: 4912, web: 4913, postgres: 5433, temporal: 7234 },
        `garbage value ${JSON.stringify(garbage)} should fall back to defaults`,
      );
    }
  });

  it("reads process.env by default and restores it afterwards", () => {
    const saved = process.env[DEV_STACK_PORT_ENV_VARS.api];
    try {
      process.env[DEV_STACK_PORT_ENV_VARS.api] = "5050";
      assert.equal(resolveDevStackPorts().api, 5050);
    } finally {
      if (saved === undefined) {
        delete process.env[DEV_STACK_PORT_ENV_VARS.api];
      } else {
        process.env[DEV_STACK_PORT_ENV_VARS.api] = saved;
      }
    }
  });
});

describe("buildDevStackComposeYaml", () => {
  const ports = resolveDevStackPorts({});
  const compose = buildDevStackComposeYaml({ ports });

  it("uses the expected project name", () => {
    assert.equal(DEV_STACK_PROJECT_NAME, "spaceapp-dev-stack");
    assert.ok(compose.split("\n").includes("name: spaceapp-dev-stack"));
    assert.equal(compose.split("\n")[0], "name: spaceapp-dev-stack");
  });

  it("embeds overridden ports while binding to the loopback host", () => {
    const overridden = buildDevStackComposeYaml({
      ports: { api: 5010, web: 5011, postgres: 5544, temporal: 7235 },
    });

    assert.ok(overridden.includes(`- "${DEV_STACK_BIND_HOST}:5544:5432"`));
    assert.ok(overridden.includes(`- "${DEV_STACK_BIND_HOST}:7235:7233"`));
  });
});

describe("parseComposeServiceImage", () => {
  const ports = resolveDevStackPorts({});
  const generated = buildDevStackComposeYaml({ ports });
  const fixture = [
    "services:",
    "  postgres:",
    `    image: ${DEV_STACK_POSTGRES_IMAGE}`,
    "    ports:",
    '      - "127.0.0.1:5433:5432"',
    "  temporal:",
    `    image: ${DEV_STACK_TEMPORAL_IMAGE}`,
    "  other:",
    "    image: example/other:latest",
    "",
  ].join("\n");

  it("extracts digest images from generated YAML", () => {
    assert.equal(parseComposeServiceImage(generated, "postgres"), DEV_STACK_POSTGRES_IMAGE);
    assert.equal(parseComposeServiceImage(generated, "temporal"), DEV_STACK_TEMPORAL_IMAGE);
    assert.ok(parseComposeServiceImage(generated, "postgres").includes("@sha256:"));
    assert.ok(parseComposeServiceImage(generated, "temporal").includes("@sha256:"));
  });

  it("extracts digest images from a minimal fixture", () => {
    assert.equal(parseComposeServiceImage(fixture, "postgres"), DEV_STACK_POSTGRES_IMAGE);
    assert.equal(parseComposeServiceImage(fixture, "temporal"), DEV_STACK_TEMPORAL_IMAGE);
    assert.ok(parseComposeServiceImage(fixture, "postgres").includes("@sha256:"));
    assert.ok(parseComposeServiceImage(fixture, "temporal").includes("@sha256:"));
  });

  it("returns null for a missing service", () => {
    assert.equal(parseComposeServiceImage(generated, "missing"), null);
    assert.equal(parseComposeServiceImage(fixture, "missing"), null);
  });
});

describe("parseOpencodeVersion", () => {
  it("parses a version from fixture text", () => {
    const text = "RUN npm install --global --no-audit --no-fund opencode-ai@1.18.4";
    assert.equal(parseOpencodeVersion(text), "1.18.4");
  });

  it("parses the version from the real repo Dockerfile", () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
    assert.equal(parseOpencodeVersion(dockerfile), "2.0.32");
  });

  it("supports prerelease suffixes", () => {
    assert.equal(parseOpencodeVersion("opencode-ai@2.0.0-beta.3"), "2.0.0-beta.3");
  });

  it("returns null when no opencode-ai reference exists", () => {
    assert.equal(parseOpencodeVersion("RUN echo hello"), null);
    assert.equal(parseOpencodeVersion(""), null);
  });
});

describe("parseOpencodePackage", () => {
  it("parses the OpenCode 2 package spec", () => {
    const text = "RUN npm install --global --no-audit --no-fund @opencode/cli@2.0.32";
    assert.equal(parseOpencodePackage(text), "@opencode/cli@2.0.32");
    assert.equal(parseOpencodeVersion(text), "2.0.32");
  });

  it("parses the legacy opencode-ai package spec", () => {
    const text = "RUN npm install --global --no-audit --no-fund opencode-ai@1.18.4";
    assert.equal(parseOpencodePackage(text), "opencode-ai@1.18.4");
  });

  it("parses the package pinned in the real repo Dockerfile", () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");
    assert.equal(parseOpencodePackage(dockerfile), "@opencode/cli@2.0.32");
  });

  it("returns null when no OpenCode CLI package is pinned", () => {
    assert.equal(parseOpencodePackage("RUN echo hello"), null);
    assert.equal(parseOpencodePackage(""), null);
  });
});

describe("devStackPortMappings", () => {
  it("binds every mapping to the loopback host", () => {
    const mappings = devStackPortMappings(DEFAULT_DEV_STACK_PORTS);
    assert.ok(mappings.length > 0);
    for (const mapping of mappings) {
      assert.ok(mapping.startsWith("127.0.0.1:"), mapping);
    }
  });

  it("includes default postgres and temporal mappings", () => {
    const mappings = devStackPortMappings(DEFAULT_DEV_STACK_PORTS);
    assert.ok(mappings.includes("127.0.0.1:5433:5432"));
    assert.ok(mappings.includes("127.0.0.1:7234:7233"));
  });

  it("includes overridden postgres mappings", () => {
    const mappings = devStackPortMappings({ ...DEFAULT_DEV_STACK_PORTS, postgres: 5544 });
    assert.ok(mappings.includes("127.0.0.1:5544:5432"));
  });
});

describe("devStackChildProcessEnv", () => {
  it("builds api and web environments from the ports", () => {
    const ports = { api: 4912, web: 4913, postgres: 5433, temporal: 7234 };
    const env = devStackChildProcessEnv(ports);

    assert.equal(env.api.SPACE_API_PORT, "4912");
    assert.equal(env.web.SPACE_WEB_HOST, "127.0.0.1");
    assert.equal(env.web.SPACE_WEB_HOST, DEV_STACK_BIND_HOST);
    assert.equal(env.web.SPACE_WEB_PORT, "4913");
    assert.equal(env.web.SPACE_API_PORT, "4912");
  });
});
