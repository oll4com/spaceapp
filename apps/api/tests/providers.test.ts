import { describe, expect, it } from "vitest";
import type { SpaceApiConfig } from "../src/config.js";
import { validateProviderCredential } from "../src/providers.js";

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

describe("provider credential validation", () => {
  it("fails closed when Codex-LB config is missing", async () => {
    const result = await validateProviderCredential("codex-lb", baseConfig());

    expect(result).toMatchObject({
      providerId: "codex-lb",
      status: "DISABLED",
      code: "MISSING_CONFIG",
      maskedKeyPrefix: null,
      modelCount: null
    });
  });

  it("rejects non-dedicated Codex-LB key labels before reading credentials", async () => {
    let didRead = false;
    const result = await validateProviderCredential(
      "codex-lb",
      baseConfig({
        codexLbBaseUrl: "http://127.0.0.1:2458/v1",
        codexLbKeyFile: "/run/secrets/codex-lb-main",
        codexLbKeyName: "codex-lb-main"
      }),
      {
        readFileImpl: async () => {
          didRead = true;
          return "credential-value";
        }
      }
    );

    expect(didRead).toBe(false);
    expect(result.status).toBe("ERROR");
    expect(result.code).toBe("KEY_NAME_NOT_DEDICATED");
  });

  it("verifies a dedicated Codex-LB credential with a safe masked response", async () => {
    let authorization = "";
    let requestedUrl = "";
    const result = await validateProviderCredential(
      "codex-lb",
      baseConfig({
        codexLbBaseUrl: "http://codex-lb.local/v1",
        codexLbKeyFile: "/run/secrets/space-dev",
        codexLbKeyName: "space-dev"
      }),
      {
        readFileImpl: async () => "credential-value-for-space",
        fetchImpl: async (url, init) => {
          requestedUrl = String(url);
          authorization = String((init?.headers as { Authorization?: string }).Authorization ?? "");
          return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
    );

    expect(authorization).toBe("Bearer credential-value-for-space");
    expect(requestedUrl).toBe("http://codex-lb.local/v1/models");
    expect(result).toMatchObject({
      status: "VERIFIED",
      code: "VERIFIED",
      credentialLabel: "space-dev",
      modelCount: 2
    });
    expect(result.models).toEqual([
      expect.objectContaining({
        id: "model-a",
        providerId: "codex-lb",
        runtimeId: "model-a",
        displayName: "model-a",
        status: "VERIFIED"
      }),
      expect.objectContaining({
        id: "model-b",
        providerId: "codex-lb",
        runtimeId: "model-b",
        displayName: "model-b",
        status: "VERIFIED"
      })
    ]);
    expect(JSON.stringify(result)).not.toContain("credential-value-for-space");
    expect(result.maskedKeyPrefix).toBe("cred...pace");
  });

  it("validates a Codex-LB-backed route provider against its own base URL without shared route state", async () => {
    let requestedUrl = "";
    const result = await validateProviderCredential(
      "direct-246-primary",
      baseConfig({
        codexLbBaseUrl: "http://shared-proxy.local/v1",
        codexLbKeyFile: "/run/secrets/space-direct",
        codexLbKeyName: "space-direct"
      }),
      {
        id: "direct-246-primary",
        displayName: "Direct .246 Primary",
        type: "CODEX_LB",
        status: "DISABLED",
        statusReason: "Pending smoke.",
        healthCheckedAt: null,
        maskedKeyPrefix: null,
        baseUrl: "http://192.0.2.246:2455/v1",
        routeProfile: "direct-primary",
        backingProviderId: "codex-lb",
        credentialRef: null,
        isBuiltIn: true
      },
      {
        readFileImpl: async () => "credential-value-for-space",
        fetchImpl: async (url) => {
          requestedUrl = String(url);
          return new Response(JSON.stringify({ data: [{ id: "gpt-direct" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
    );

    expect(result).toMatchObject({
      providerId: "direct-246-primary",
      status: "VERIFIED",
      modelCount: 1
    });
    expect(result.models?.[0]).toMatchObject({
      providerId: "direct-246-primary",
      id: "direct-246-primary:gpt-direct",
      runtimeId: "gpt-direct"
    });
    expect(requestedUrl).toBe("http://192.0.2.246:2455/v1/models");
  });

  it("maps nested provider metadata modalities into vision support", async () => {
    const result = await validateProviderCredential(
      "codex-lb",
      baseConfig({
        codexLbBaseUrl: "http://codex-lb.local/v1",
        codexLbKeyFile: "/run/secrets/space-dev",
        codexLbKeyName: "space-dev"
      }),
      {
        readFileImpl: async () => "credential-value-for-space",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: "gpt-5.5", metadata: { input_modalities: ["text", "image"] } },
                { id: "gpt-5.3-codex-spark", metadata: { input_modalities: ["text"] } }
              ]
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" }
            }
          )
      }
    );

    expect(result.status).toBe("VERIFIED");
    expect(result.models).toEqual([
      expect.objectContaining({
        id: "gpt-5.5",
        supportsVision: true
      }),
      expect.objectContaining({
        id: "gpt-5.3-codex-spark",
        supportsVision: false
      })
    ]);
  });

  it("rejects unusable model payloads without persisting untrusted shape", async () => {
    const result = await validateProviderCredential(
      "codex-lb",
      baseConfig({
        codexLbBaseUrl: "http://codex-lb.local/v1",
        codexLbKeyFile: "/run/secrets/space-dev",
        codexLbKeyName: "space-dev"
      }),
      {
        readFileImpl: async () => "credential-value-for-space",
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: [{ object: "model" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
      }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      code: "SMOKE_FAILED",
      modelCount: null
    });
    expect(result.models).toBeUndefined();
  });
});
