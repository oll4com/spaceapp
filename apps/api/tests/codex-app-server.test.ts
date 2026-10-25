import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpaceApiConfig } from "../src/config.js";
import type { CodexAppServerStdioProcess } from "@space/codex-app-server";
import {
  buildCodexAppServerChildEnv,
  getCodexAppServerStatus,
  performCodexAppServerStdioTurnSmoke,
  runCodexAppServerHandshake,
  runCodexAppServerTurnSmoke
} from "../src/codex-app-server.js";

class FakeCodexAppServerProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown> };
        if (message.method === "initialize") {
          this.emitJson({ id: message.id, result: { userAgent: "fake-codex" } });
        }
        if (message.method === "configRequirements/read") {
          this.emitJson({ id: message.id, result: { requirements: null } });
        }
        if (message.method === "thread/start") {
          this.emitJson({ id: message.id, result: { thread: { id: "thread:api-env-test" } } });
        }
        if (message.method === "turn/start") {
          this.emitJson({ id: message.id, result: { turn: { id: "turn:api-env-test", status: "inProgress" } } });
          this.emitJson({
            method: "turn/completed",
            params: {
              threadId: message.params?.threadId,
              turn: { id: "turn:api-env-test", status: "completed" }
            }
          });
        }
      }
      return true;
    }
  };

  kill(): boolean {
    return true;
  }

  private emitJson(message: unknown) {
    queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify(message)}\n`));
  }
}

function baseConfig(overrides: Partial<SpaceApiConfig> = {}): SpaceApiConfig {
  return {
    host: "127.0.0.1",
    port: 4910,
    version: "0.1.0",
    runtimeStore: "memory",
    databaseUrl: null,
    temporalAddress: "127.0.0.1:7233",
    temporalNamespace: "default",
    temporalTaskQueue: "space-agent-turns",
    enableDummyTurns: false,
    enableCodexTurns: false,
    codexLbConfigured: false,
    codexLbBaseUrl: null,
    codexLbKeyFile: null,
    codexLbKeyName: null,
    codexAppServerEnabled: false,
    codexAppServerCommand: "codex",
    codexAppServerTransport: "stdio",
    codexAppServerSocketPath: null,
    codexAppServerWebsocketUrl: null,
    codexAppServerSchemaDir: null,
    codexAppServerHome: null,
    codexAppServerKeyFile: null,
    codexAppServerKeyEnv: "OPENAI_API_KEY",
    codexAppServerAllowStdioSpawn: false,
    codexAppServerAllowTurnSmoke: false,
    ...overrides
  };
}

const schemaManifest = {
  schemaVersion: 1 as const,
  codexCliVersion: "codex-cli 0.142.2",
  generatedAt: "2026-06-26T00:00:00.000Z",
  jsonSchemaFileCount: 200,
  typeScriptFileCount: 100,
  jsonSchemaBundleSha256: "a".repeat(64),
  typeScriptIndexSha256: "b".repeat(64)
};

describe("Codex App Server adapter status", () => {
  it("defaults to disabled and does not imply a live Codex connection", () => {
    const result = getCodexAppServerStatus(baseConfig(), {
      now: new Date("2026-06-26T00:00:00.000Z"),
      schemaManifest: null
    });

    expect(result).toMatchObject({
      id: "codex-app-server",
      status: "DISABLED",
      reasonCode: "DISABLED_BY_DEFAULT",
      transport: "stdio",
      command: "codex",
      schemasGenerated: false,
      schemaManifest: null
    });
    expect(result.statusReason).toContain("disabled");
  });

  it("marks stdio config as ready to attempt without spawning Codex", () => {
    const result = getCodexAppServerStatus(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "stdio",
        codexAppServerCommand: "codex"
      }),
      { now: new Date("2026-06-26T00:00:00.000Z"), schemaManifest: null }
    );

    expect(result).toMatchObject({
      status: "READY",
      reasonCode: "CONFIG_SAFE",
      transport: "stdio",
      command: "codex"
    });
    expect(result.statusReason).toContain("not connected");
  });

  it("rejects non-loopback websocket transports fail-closed", () => {
    const result = getCodexAppServerStatus(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "websocket",
        codexAppServerWebsocketUrl: "ws://0.0.0.0:4500"
      }),
      { now: new Date("2026-06-26T00:00:00.000Z"), schemaManifest: null }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      reasonCode: "WEBSOCKET_NON_LOOPBACK_FORBIDDEN",
      transport: "websocket",
      websocketUrl: "ws://0.0.0.0:4500"
    });
  });

  it("rejects relative unix socket paths", () => {
    const result = getCodexAppServerStatus(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "unix",
        codexAppServerSocketPath: "tmp/codex.sock"
      }),
      { now: new Date("2026-06-26T00:00:00.000Z"), schemaManifest: null }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      reasonCode: "SOCKET_PATH_NOT_ABSOLUTE",
      transport: "unix"
    });
  });

  it("rejects relative isolated Codex home paths", () => {
    const result = getCodexAppServerStatus(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerHome: "var/codex-home"
      }),
      { now: new Date("2026-06-26T00:00:00.000Z"), schemaManifest: null }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      reasonCode: "HOME_PATH_NOT_ABSOLUTE",
      transport: "stdio"
    });
  });

  it("rejects relative Codex App Server key file paths", () => {
    const result = getCodexAppServerStatus(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerKeyFile: "secrets/codex.key"
      }),
      { now: new Date("2026-06-26T00:00:00.000Z"), schemaManifest: null }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      reasonCode: "KEY_FILE_PATH_NOT_ABSOLUTE",
      transport: "stdio"
    });
  });

  it("builds an isolated child environment without mutating the service environment", () => {
    const baseEnv = {
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/opt/spaceapp",
      CODEX_HOME: "/opt/spaceapp",
      SPACE_SESSION_SECRET: "session-secret-sentinel",
      SPACE_DATABASE_URL: "database-url-sentinel",
      SPACE_INTERNAL_API_TOKEN: "internal-api-token-sentinel",
      OPENAI_API_KEY: "inherited-openai-key-sentinel",
      AWS_SECRET_ACCESS_KEY: "aws-secret-sentinel",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
      LD_PRELOAD: "/tmp/evil.so"
    };
    const result = buildCodexAppServerChildEnv(
      baseConfig({ codexAppServerHome: "/opt/spaceapp/var/codex-app-server-home" }),
      baseEnv
    );

    expect(result).toMatchObject({
      PATH: "/usr/local/bin:/usr/bin",
      HOME: "/opt/spaceapp/var/codex-app-server-home",
      CODEX_HOME: "/opt/spaceapp/var/codex-app-server-home",
      XDG_CACHE_HOME: "/opt/spaceapp/var/codex-app-server-home/cache",
      XDG_CONFIG_HOME: "/opt/spaceapp/var/codex-app-server-home/config",
      XDG_DATA_HOME: "/opt/spaceapp/var/codex-app-server-home/data"
    });
    expect(result).not.toHaveProperty("SPACE_SESSION_SECRET");
    expect(result).not.toHaveProperty("SPACE_DATABASE_URL");
    expect(result).not.toHaveProperty("SPACE_INTERNAL_API_TOKEN");
    expect(result).not.toHaveProperty("OPENAI_API_KEY");
    expect(result).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(result).not.toHaveProperty("NODE_OPTIONS");
    expect(result).not.toHaveProperty("LD_PRELOAD");
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

  it("builds the shared VS Code Codex environment for a .codex home", () => {
    const baseEnv = {
      HOME: "/opt/spaceapp",
      CODEX_HOME: "/opt/spaceapp",
      XDG_CACHE_HOME: "/opt/spaceapp/cache",
      XDG_CONFIG_HOME: "/opt/spaceapp/config",
      XDG_DATA_HOME: "/opt/spaceapp/data"
    };
    const result = buildCodexAppServerChildEnv(
      baseConfig({ codexAppServerHome: "/var/lib/spaceapp-user/.codex" }),
      baseEnv
    );

    expect(result).toMatchObject({
      HOME: "/var/lib/spaceapp-user",
      CODEX_HOME: "/var/lib/spaceapp-user/.codex",
      TMPDIR: "/var/lib/spaceapp-user/.codex/tmp",
      TMP: "/var/lib/spaceapp-user/.codex/tmp",
      TEMP: "/var/lib/spaceapp-user/.codex/tmp"
    });
    expect(result.XDG_CACHE_HOME).toBeUndefined();
    expect(result.XDG_CONFIG_HOME).toBeUndefined();
    expect(result.XDG_DATA_HOME).toBeUndefined();
    expect(baseEnv).toEqual({
      HOME: "/opt/spaceapp",
      CODEX_HOME: "/opt/spaceapp",
      XDG_CACHE_HOME: "/opt/spaceapp/cache",
      XDG_CONFIG_HOME: "/opt/spaceapp/config",
      XDG_DATA_HOME: "/opt/spaceapp/data"
    });
  });

  it("injects the Codex App Server key from a file without mutating the service environment", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "space-codex-app-server-"));
    const keyFile = join(tempDir, "key");
    writeFileSync(keyFile, "space-test-key\n", { mode: 0o600 });
    const baseEnv = { OPENAI_API_KEY: "old-value" };
    try {
      const result = buildCodexAppServerChildEnv(
        baseConfig({
          codexAppServerHome: join(tempDir, "codex-home"),
          codexAppServerKeyFile: keyFile,
          codexAppServerKeyEnv: "CODEX_LB_API_KEY"
        }),
        baseEnv
      );

      expect(result).toMatchObject({
        CODEX_LB_API_KEY: "space-test-key"
      });
      expect(result.OPENAI_API_KEY).toBeUndefined();
      expect(baseEnv).toEqual({ OPENAI_API_KEY: "old-value" });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("passes only the allowlist and configured credential to the API stdio spawn", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "space-codex-app-server-spawn-env-"));
    const keyFile = join(tempDir, "key");
    writeFileSync(keyFile, "configured-provider-key\n", { mode: 0o600 });
    let childEnv: NodeJS.ProcessEnv | null = null;
    try {
      await performCodexAppServerStdioTurnSmoke(
        baseConfig({
          codexAppServerCommand: "/definitely-not-a-real-codex-command",
          codexAppServerHome: join(tempDir, "codex-home"),
          codexAppServerKeyFile: keyFile,
          codexAppServerKeyEnv: "OPENAI_API_KEY"
        }),
        { prompt: "environment capture" },
        {
          baseEnv: {
            PATH: "/usr/local/bin:/usr/bin",
            SPACE_SESSION_SECRET: "session-secret-sentinel",
            SPACE_DATABASE_URL: "database-url-sentinel",
            SPACE_INTERNAL_API_TOKEN: "internal-api-token-sentinel",
            OPENAI_API_KEY: "inherited-openai-key-sentinel",
            AWS_SECRET_ACCESS_KEY: "aws-secret-sentinel",
            NODE_OPTIONS: "--require=/tmp/evil.cjs",
            LD_PRELOAD: "/tmp/evil.so",
            HTTPS_PROXY: "http://proxy.invalid",
            INVOCATION_ID: "systemd-invocation-sentinel"
          },
          spawnProcess: (_command, _args, options) => {
            childEnv = options.env;
            return new FakeCodexAppServerProcess();
          }
        }
      );

      expect(childEnv).toEqual({
        PATH: "/usr/local/bin:/usr/bin",
        HOME: join(tempDir, "codex-home"),
        CODEX_HOME: join(tempDir, "codex-home"),
        XDG_CACHE_HOME: join(tempDir, "codex-home", "cache"),
        XDG_CONFIG_HOME: join(tempDir, "codex-home", "config"),
        XDG_DATA_HOME: join(tempDir, "codex-home", "data"),
        OPENAI_API_KEY: "configured-provider-key"
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("surfaces generated schema manifest metadata when configured", () => {
    const result = getCodexAppServerStatus(baseConfig(), {
      now: new Date("2026-06-26T00:00:00.000Z"),
      schemaManifest
    });

    expect(result.schemasGenerated).toBe(true);
    expect(result.schemaManifest).toMatchObject({
      schemaVersion: 1,
      codexCliVersion: "codex-cli 0.142.2"
    });
  });

  it("keeps handshake fail-closed until explicit stdio spawn opt-in", async () => {
    const result = await runCodexAppServerHandshake(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "stdio",
        codexAppServerSchemaDir: "not-used-in-test"
      }),
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        performStdioHandshake: async () => {
          throw new Error("must not run");
        }
      }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      code: "SCHEMAS_MISSING",
      transport: "stdio"
    });

    const withSchema = await runCodexAppServerHandshake(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "stdio",
        codexAppServerAllowStdioSpawn: false
      }),
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        schemaManifest,
        performStdioHandshake: async () => ({ initialized: true })
      }
    );

    expect(withSchema).toMatchObject({
      status: "ERROR",
      code: "STDIO_SPAWN_NOT_ENABLED"
    });
  });

  it("returns verified only after explicit stdio spawn opt-in and handshake success", async () => {
    const result = await runCodexAppServerHandshake(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "stdio",
        codexAppServerAllowStdioSpawn: true
      }),
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        schemaManifest,
        performStdioHandshake: async () => ({ platformFamily: "unix" })
      }
    );

    expect(result).toMatchObject({
      status: "VERIFIED",
      code: "HANDSHAKE_OK",
      serverInfo: { platformFamily: "unix" }
    });
  });

  it("keeps thread and turn smoke fail-closed behind schema, spawn, and turn-smoke gates", async () => {
    const missingSchemas = await runCodexAppServerTurnSmoke(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "stdio"
      }),
      { prompt: "hello" },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        performStdioTurnSmoke: async () => {
          throw new Error("must not run");
        }
      }
    );

    expect(missingSchemas).toMatchObject({
      status: "ERROR",
      code: "SCHEMAS_MISSING"
    });

    const spawnDisabled = await runCodexAppServerTurnSmoke(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "stdio",
        codexAppServerAllowStdioSpawn: false
      }),
      { prompt: "hello" },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        schemaManifest,
        performStdioTurnSmoke: async () => {
          throw new Error("must not run");
        }
      }
    );

    expect(spawnDisabled).toMatchObject({
      status: "ERROR",
      code: "STDIO_SPAWN_NOT_ENABLED"
    });

    const turnSmokeDisabled = await runCodexAppServerTurnSmoke(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "stdio",
        codexAppServerAllowStdioSpawn: true,
        codexAppServerAllowTurnSmoke: false
      }),
      { prompt: "hello" },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        schemaManifest,
        performStdioTurnSmoke: async () => {
          throw new Error("must not run");
        }
      }
    );

    expect(turnSmokeDisabled).toMatchObject({
      status: "ERROR",
      code: "TURN_SMOKE_NOT_ENABLED"
    });
  });

  it("returns verified for thread and turn smoke only after injected completion evidence", async () => {
    const result = await runCodexAppServerTurnSmoke(
      baseConfig({
        codexAppServerEnabled: true,
        codexAppServerTransport: "stdio",
        codexAppServerAllowStdioSpawn: true,
        codexAppServerAllowTurnSmoke: true
      }),
      { prompt: "Reply with exactly: space-ok", model: "gpt-5.4" },
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        schemaManifest,
        performStdioTurnSmoke: async () => ({
          threadId: "thread:test-1",
          turnId: "turn:test-1",
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true
        })
      }
    );

    expect(result).toMatchObject({
      status: "VERIFIED",
      code: "TURN_COMPLETED",
      threadId: "thread:test-1",
      turnId: "turn:test-1",
      turnStatus: "completed",
      completedNotificationSeen: true
    });
    expect(JSON.stringify(result)).not.toContain("space-ok");
  });
});
