import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { getApiConfig } from "../src/config.js";
import { T3EnvValidationError } from "../src/t3-env.js";
import { apiConfigRegistry, describeApiConfiguration, unregisteredApiConfigKeys, validateApiConfiguration } from "../src/config-registry.js";

describe("API configuration registry", () => {
  it("runs the preflight command with bounded, value-free failure output", async () => {
    const run = promisify(execFile);
    const command = ["--import", "tsx", resolve("src/config-reference.ts")];
    const options = { env: { PATH: process.env.PATH, SPACE_INTERNAL_API_TOKEN: "synthetic-private-value" }, timeout: 10000, maxBuffer: 128 * 1024 };
    const defaults = await run(process.execPath, [...command, "--defaults"], options);
    expect(JSON.parse(defaults.stdout).fields.length).toBeGreaterThan(100);
    expect(defaults.stdout).not.toContain("synthetic-private-value");
    await expect(run(process.execPath, [...command, "--check"], {
      ...options, env: { ...options.env, SPACE_API_PORT: "synthetic-private-value" }
    })).rejects.toMatchObject({ code: 1, stdout: expect.not.stringContaining("synthetic-private-value") });
    await expect(run(process.execPath, [...command, "--unknown"], options)).rejects.toMatchObject({ code: 2 });
  }, 40_000); // three sequential tsx processes, each bounded at 10 s
  it("covers the effective API shape and derives defaults from the existing parser", () => {
    const config = getApiConfig({});
    const entries = describeApiConfiguration();
    expect(entries.map(entry => entry.key).sort()).toEqual(Object.keys(config).sort());
    // Add new SpaceApiConfig fields to apiConfigRegistry (sources, exposure, validation).
    expect(unregisteredApiConfigKeys(), "SpaceApiConfig fields missing from apiConfigRegistry").toEqual([]);
    for (const entry of entries) {
      expect(entry.scope).toBe("api");
      expect(entry.sources.length).toBeGreaterThan(0);
      if (entry.exposure === "public") expect(entry.defaultValue).toEqual(config[entry.key]);
    }
    expect(entries.find(entry => entry.key === "cliTokenTtlMs")?.defaultValue).toBe(60000);
  });

  it("documents supported aliases in parser precedence without inventing deprecations", () => {
    expect(apiConfigRegistry.googleVoiceKeyFile.sources).toEqual([
      "SPACE_GOOGLE_VOICE_KEY_FILE", "SPACE_GEMINI_VOICE_KEY_FILE"
    ]);
    expect(apiConfigRegistry.awsRegion.sources).toEqual(["AWS_REGION", "AWS_DEFAULT_REGION"]);
    expect(apiConfigRegistry.googleVoiceKeyFile.deprecatedSources).toEqual([]);
    expect(getApiConfig({ SPACE_GOOGLE_VOICE_KEY_FILE: "primary", SPACE_GEMINI_VOICE_KEY_FILE: "alias" }).googleVoiceKeyFile).toBe("primary");
    expect(getApiConfig({ SPACE_GOOGLE_VOICE_KEY_FILE: "", SPACE_GEMINI_VOICE_KEY_FILE: "alias" }).googleVoiceKeyFile).toBe("alias");
  });

  it("reads the Space Gateway names before the codex-lb names they replaced", () => {
    expect(apiConfigRegistry.codexLbBaseUrl.sources).toEqual(["SPACE_GATEWAY_BASE_URL", "SPACE_CODEX_LB_BASE_URL"]);
    const both = getApiConfig({ SPACE_GATEWAY_BASE_URL: "http://127.0.0.1:4920/v1", SPACE_CODEX_LB_BASE_URL: "http://old.invalid/v1",
      SPACE_GATEWAY_KEY_FILE: "/k/gateway.key", SPACE_CODEX_LB_KEY_FILE: "/k/old.key" });
    expect(both).toMatchObject({ codexLbBaseUrl: "http://127.0.0.1:4920/v1", codexLbKeyFile: "/k/gateway.key", codexLbConfigured: true });
    const legacy = getApiConfig({ SPACE_CODEX_LB_BASE_URL: "http://127.0.0.1:4920/v1", SPACE_CODEX_LB_KEY_FILE: "/k/old.key" });
    expect(legacy).toMatchObject({ codexLbBaseUrl: "http://127.0.0.1:4920/v1", codexLbKeyFile: "/k/old.key", codexLbConfigured: true });
  });

  it("reports invalid numbers and compound ranges while the runtime parser fails fast", () => {
    const env = { SPACE_API_PORT: "bad-port", SPACE_DATABASE_POOL_MAX: "0", SPACE_DEMO_PROJECTS_PORT_START: "4999", SPACE_DEMO_PROJECTS_PORT_END: "4930" };
    expect(validateApiConfiguration(env).map(issue => issue.key)).toEqual(expect.arrayContaining([
      "port", "databasePoolMax", "demoProjectsPortEnd"
    ]));
    // T3 Env validation rejects the environment instead of silently falling back.
    expect(() => getApiConfig(env)).toThrow(T3EnvValidationError);
    expect(() => getApiConfig(env)).not.toThrow(/bad-port/);
    expect(validateApiConfiguration({})).toEqual([]);
  });

  it("rejects malformed flags and structured settings with value-free diagnostics", () => {
    const env = {
      SPACE_CLI_ENABLED: "yes",
      SPACE_MCP_SERVERS_JSON: '{"secret":"synthetic-private-value"}',
      SPACE_LIVE_MODEL_POLICY_JSON: '{"secret":"synthetic-private-value"}',
      SPACE_API_PORT: "synthetic-private-value"
    };
    const issues = validateApiConfiguration(env);
    expect(issues.map(issue => issue.key)).toEqual(expect.arrayContaining([
      "cliEnabled", "mcpServerConfigs", "liveModelPolicy", "port"
    ]));
    expect(JSON.stringify(issues)).not.toContain("synthetic-private-value");
  });

  it("does not read inherited environment secrets for the defaults reference", () => {
    const previous = process.env.SPACE_INTERNAL_API_TOKEN;
    process.env.SPACE_INTERNAL_API_TOKEN = "synthetic-private-value";
    try {
      expect(JSON.stringify(describeApiConfiguration())).not.toContain("synthetic-private-value");
      expect(apiConfigRegistry.internalApiToken.exposure).toBe("secret");
      expect(apiConfigRegistry.mcpServerConfigs.exposure).toBe("secret");
      expect(apiConfigRegistry.databaseUrl.exposure).toBe("secret");
      expect(apiConfigRegistry.googleVoiceKeyFile.exposure).toBe("sensitive");
    } finally {
      if (previous === undefined) delete process.env.SPACE_INTERNAL_API_TOKEN;
      else process.env.SPACE_INTERNAL_API_TOKEN = previous;
    }
  });
});
