import { describe, expect, it } from "vitest";
import { getApiConfig } from "../src/config.js";
import { T3EnvValidationError, validateT3ApiEnv } from "../src/t3-env.js";

const fail = (env: NodeJS.ProcessEnv) => {
  try { validateT3ApiEnv(env); } catch (error) { return error as T3EnvValidationError; }
  throw new Error("Expected validation to fail");
};

describe("T3 Env validation", () => {
  it("keeps the historical defaults with typed values", () => {
    const env = validateT3ApiEnv({});
    expect(env.SPACE_API_HOST).toBe("127.0.0.1");
    expect(env.SPACE_API_PORT).toBe(4910);
    expect(env.SPACE_RUNTIME_STORE).toBe("memory");
    expect(env.SPACE_T3CODE_SOCKET).toBe("/run/space-t3code/transport.sock");
    expect(env.SPACE_T3CODE_PROXY_TIMEOUT_MS).toBe(30_000);
  });

  it("feeds getApiConfig from the normalized result", () => {
    const config = getApiConfig({ SPACE_API_PORT: " 4999 ", SPACE_DATABASE_POOL_MAX: "500", SPACE_ENABLE_DB_SWEEP: "0",
      SPACE_T3CODE_ENABLED: "false", SPACE_T3CODE_PROXY_TIMEOUT_MS: "45000", SPACE_DEMO_PROJECTS_PUBLIC_ORIGIN: "https://space.test:4911" });
    expect(config.port).toBe(4999);
    expect(config.databasePoolMax).toBe(100);
    expect(config.enableDbSweep).toBe(false);
    expect(config.t3CodeEnabled).toBe(false);
    expect(config.t3CodeProxyTimeoutMs).toBe(45_000);
    expect(config.demoProjectsPublicOrigin).toBe("https://space.test:4911");
    expect(getApiConfig({}).t3CodeEnabled).toBe(true);
  });

  it("accepts the historical flag spellings of each variable", () => {
    for (const value of ["true", "false", "1", "0"]) expect(() => validateT3ApiEnv({ SPACE_ENABLE_DB_SWEEP: value })).not.toThrow();
    for (const value of ["true", "false"]) expect(() => validateT3ApiEnv({ SPACE_CLI_ENABLED: value, SPACE_T3CODE_ENABLED: value })).not.toThrow();
    expect(validateT3ApiEnv({ SPACE_CLI_ENABLED: "" }).SPACE_CLI_ENABLED).toBeUndefined();
  });

  it.each([
    ["SPACE_API_PORT", "0"], ["SPACE_API_PORT", "65536"], ["SPACE_API_PORT", "49.10"], ["SPACE_API_PORT", "port"],
    ["SPACE_DATABASE_POOL_MAX", "ten"], ["SPACE_CLI_TOKEN_TTL_MS", "-5"], ["SPACE_CLI_ENABLED", "yes"],
    ["SPACE_T3CODE_ENABLED", "TRUE"], ["SPACE_ENABLE_DB_SWEEP", "off"], ["SPACE_API_HOST", "   "],
    ["SPACE_DEMO_PROJECTS_PUBLIC_ORIGIN", "not a url"], ["SPACE_DEMO_PROJECTS_PUBLIC_ORIGIN", "ftp://space.test"],
    ["SPACE_T3CODE_SOCKET", "relative.sock"], ["SPACE_RUNTIME_STORE", "invalid_store"]
  ])("fails fast on %s=%j", (name, value) => {
    const error = fail({ [name]: value });
    expect(error).toBeInstanceOf(T3EnvValidationError);
    expect(error.fields).toContain(name);
  });

  it("requires a postgres URL for the postgres store", () => {
    expect(fail({ SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: "" }).message).toMatch(/SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres/);
    expect(fail({ SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: "mysql://x" }).fields).toContain("SPACE_DATABASE_URL");
    expect(validateT3ApiEnv({ SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: "postgres://space:test@localhost:5432/space" }).SPACE_RUNTIME_STORE).toBe("postgres");
  });

  it("refuses a validation bypass in every environment", () => {
    for (const NODE_ENV of ["production", "test", "development"]) {
      expect(fail({ NODE_ENV, SKIP_ENV_VALIDATION: "true", SPACE_RUNTIME_STORE: "postgres" }).fields).toEqual(["SKIP_ENV_VALIDATION"]);
    }
  });

  it("never echoes configured values in errors", () => {
    const secretish = "postgres-canary-value-7f3a";
    const error = fail({ SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: secretish, SPACE_API_PORT: "canary-port-91", SPACE_SESSION_SECRET: "   " });
    expect(error.message).not.toContain(secretish);
    expect(error.message).not.toContain("canary-port-91");
    expect(error.fields).toEqual(expect.arrayContaining(["SPACE_DATABASE_URL", "SPACE_API_PORT", "SPACE_SESSION_SECRET"]));
  });
});
