import { describe, expect, it } from "vitest";
import { buildCodexAppServerProcessEnv } from "../src/index.js";

describe("buildCodexAppServerProcessEnv", () => {
  it("inherits only the process allowlist and injects only the configured provider credential", () => {
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/opt/spaceapp",
      USER: "space",
      LOGNAME: "space",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp/service",
      TMP: "/tmp/service",
      TEMP: "/tmp/service",
      SPACE_SESSION_SECRET: "session-secret-sentinel",
      SPACE_DATABASE_URL: "database-url-sentinel",
      SPACE_INTERNAL_API_TOKEN: "internal-api-token-sentinel",
      OPENAI_API_KEY: "inherited-openai-key-sentinel",
      AWS_SECRET_ACCESS_KEY: "aws-secret-sentinel",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
      LD_PRELOAD: "/tmp/evil.so",
      HTTPS_PROXY: "http://proxy.invalid",
      INVOCATION_ID: "systemd-invocation-sentinel"
    };

    const result = buildCodexAppServerProcessEnv({
      baseEnv,
      codexHome: "/opt/spaceapp/var/codex-app-server-home",
      credential: {
        name: "OPENAI_API_KEY",
        value: "configured-provider-key"
      }
    });

    expect(result).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/opt/spaceapp/var/codex-app-server-home",
      USER: "space",
      LOGNAME: "space",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp/service",
      TMP: "/tmp/service",
      TEMP: "/tmp/service",
      CODEX_HOME: "/opt/spaceapp/var/codex-app-server-home",
      XDG_CACHE_HOME: "/opt/spaceapp/var/codex-app-server-home/cache",
      XDG_CONFIG_HOME: "/opt/spaceapp/var/codex-app-server-home/config",
      XDG_DATA_HOME: "/opt/spaceapp/var/codex-app-server-home/data",
      OPENAI_API_KEY: "configured-provider-key"
    });
    expect(baseEnv).toMatchObject({
      SPACE_SESSION_SECRET: "session-secret-sentinel",
      SPACE_DATABASE_URL: "database-url-sentinel",
      SPACE_INTERNAL_API_TOKEN: "internal-api-token-sentinel",
      OPENAI_API_KEY: "inherited-openai-key-sentinel",
      AWS_SECRET_ACCESS_KEY: "aws-secret-sentinel",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
      LD_PRELOAD: "/tmp/evil.so"
    });
  });

  it("uses server-controlled temp paths and no XDG overrides for a shared .codex home", () => {
    const result = buildCodexAppServerProcessEnv({
      baseEnv: {
        HOME: "/opt/spaceapp",
        TMPDIR: "/tmp/service",
        XDG_CACHE_HOME: "/tmp/inherited-cache",
        XDG_CONFIG_HOME: "/tmp/inherited-config",
        XDG_DATA_HOME: "/tmp/inherited-data"
      },
      codexHome: "/var/lib/spaceapp-user/.codex",
      credential: null
    });

    expect(result).toEqual({
      HOME: "/var/lib/spaceapp-user",
      TMPDIR: "/var/lib/spaceapp-user/.codex/tmp",
      TMP: "/var/lib/spaceapp-user/.codex/tmp",
      TEMP: "/var/lib/spaceapp-user/.codex/tmp",
      CODEX_HOME: "/var/lib/spaceapp-user/.codex"
    });
  });

  it("freezes the builder result so callers cannot add inherited process state after validation", () => {
    const result = buildCodexAppServerProcessEnv({
      baseEnv: { PATH: "/usr/bin" },
      codexHome: "/opt/spaceapp/var/codex-app-server-home",
      credential: null
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(() => Object.assign(result, {
      SPACE_SESSION_SECRET: "session-secret-sentinel",
      NODE_OPTIONS: "--require=/tmp/evil.cjs"
    })).toThrow();
    expect(result).not.toHaveProperty("SPACE_SESSION_SECRET");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
  });

  it("uses only an explicitly supplied workspace while preserving the frozen environment", () => {
    const baseEnv = { SPACE_CLI_WORKSPACE: "/untrusted-inherited-workspace", SPACE_SESSION_SECRET: "sentinel" };
    const defaults = { baseEnv, codexHome: "/var/lib/spaceapp-user/.codex", credential: null };
    expect(buildCodexAppServerProcessEnv(defaults)).not.toHaveProperty("SPACE_CLI_WORKSPACE");
    const result = buildCodexAppServerProcessEnv({ ...defaults, workspace: "/srv/project with spaces" });
    expect(result.SPACE_CLI_WORKSPACE).toBe("/srv/project with spaces");
    expect(result).not.toHaveProperty("SPACE_SESSION_SECRET");
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => buildCodexAppServerProcessEnv({ ...defaults, workspace: "../relative" })).toThrow("workspace must be absolute");
  });

  it.each([
    "HOME",
    "CODEX_HOME",
    "XDG_CONFIG_HOME",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "HTTPS_PROXY",
    "INVOCATION_ID",
    "SPACE_SESSION_SECRET",
    "AWS_SECRET_ACCESS_KEY",
    "OPENAI_AWS_SECRET_ACCESS_KEY",
    "AWS_OPENAI_SESSION_TOKEN",
    "CODEX_GOOGLE_SERVICE_ACCOUNT_KEY"
  ])("rejects %s as a provider credential variable", (name) => {
    expect(() => buildCodexAppServerProcessEnv({
      baseEnv: {},
      codexHome: "/opt/spaceapp/var/codex-app-server-home",
      credential: { name, value: "credential-sentinel" }
    })).toThrow("provider credential environment variable");
  });

  it("requires a server-controlled Codex home", () => {
    expect(() => buildCodexAppServerProcessEnv({
      baseEnv: { HOME: "/opt/spaceapp" },
      codexHome: null as unknown as string,
      credential: null
    })).toThrow("Codex App Server home is required.");
  });
});
