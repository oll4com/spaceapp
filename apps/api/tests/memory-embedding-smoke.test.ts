import { describe, expect, it } from "vitest";
import { getApiConfig } from "../src/config.js";
import { createMemoryEmbedding, runMemoryEmbeddingSmoke } from "../src/memory-embedding-smoke.js";

// t3-env (fa4e165e7c) requires a URL with the postgres store; the smoke never connects.
const TEST_DATABASE_URL = "postgres://space:space@127.0.0.1:5432/space";

describe("memory embedding smoke", () => {
  it("stays disabled by default and does not imply semantic search readiness", async () => {
    const result = await runMemoryEmbeddingSmoke(getApiConfig({}), {
      now: new Date("2026-06-26T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      id: "memory-embedding-smoke",
      status: "DISABLED",
      code: "EMBEDDING_SMOKE_DISABLED",
      smokeEnabled: false,
      provider: null,
      model: null,
      dimensions: 1536,
      pgvectorReady: false,
      embeddingProviderReady: false
    });
  });

  it("requires postgres storage, pgvector, provider config and dedicated credentials", async () => {
    const memoryStoreResult = await runMemoryEmbeddingSmoke(
      getApiConfig({ SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "true" }),
      { now: new Date("2026-06-26T00:00:00.000Z") }
    );
    expect(memoryStoreResult.code).toBe("RUNTIME_STORE_NOT_POSTGRES");

    const pgvectorUnavailable = await runMemoryEmbeddingSmoke(
      getApiConfig({
        SPACE_RUNTIME_STORE: "postgres",
        SPACE_DATABASE_URL: TEST_DATABASE_URL,
        SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "true",
        SPACE_MEMORY_EMBEDDING_PROVIDER: "openai",
        SPACE_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small"
      }),
      { now: new Date("2026-06-26T00:00:00.000Z") }
    );
    expect(pgvectorUnavailable).toMatchObject({
      status: "ERROR",
      code: "PGVECTOR_UNAVAILABLE",
      pgvectorReady: false,
      embeddingProviderReady: false
    });

    const missingCredential = await runMemoryEmbeddingSmoke(
      getApiConfig({
        SPACE_RUNTIME_STORE: "postgres",
        SPACE_DATABASE_URL: TEST_DATABASE_URL,
        SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "true",
        SPACE_MEMORY_EMBEDDING_PROVIDER: "openai",
        SPACE_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
        SPACE_MEMORY_EMBEDDING_KEY_NAME: "space-openai-embedding"
      }),
      { now: new Date("2026-06-26T00:00:00.000Z"), pgvectorReady: true }
    );
    expect(missingCredential).toMatchObject({
      status: "DISABLED",
      code: "EMBEDDING_CREDENTIAL_MISSING",
      pgvectorReady: true,
      embeddingProviderReady: false
    });
  });

  it("calls OpenAI embeddings without leaking credentials when provider smoke passes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await runMemoryEmbeddingSmoke(
      getApiConfig({
        SPACE_RUNTIME_STORE: "postgres",
        SPACE_DATABASE_URL: TEST_DATABASE_URL,
        SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "true",
        SPACE_MEMORY_EMBEDDING_PROVIDER: "openai",
        SPACE_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
        SPACE_MEMORY_EMBEDDING_DIMENSIONS: "3",
        SPACE_MEMORY_EMBEDDING_KEY_FILE: "/opt/spaceapp/secrets/space-openai-embedding.key",
        SPACE_MEMORY_EMBEDDING_KEY_NAME: "space-openai-embedding"
      }),
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        pgvectorReady: true,
        readFileImpl: async () => "dummy-credential-that-must-not-leak",
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
          };
        }
      }
    );

    expect(result).toMatchObject({
      status: "VERIFIED",
      code: "EMBEDDING_SMOKE_OK",
      pgvectorReady: true,
      embeddingProviderReady: true,
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 3
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      model: "text-embedding-3-small",
      input: expect.any(String),
      dimensions: 3
    });
    expect(JSON.stringify(result)).not.toContain("dummy-credential");
    expect(JSON.stringify(calls[0]?.init?.headers)).toContain("dummy-credential-that-must-not-leak");
  });

  it("calls Codex-LB embeddings through the dedicated Space credential when provider smoke passes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const result = await runMemoryEmbeddingSmoke(
      getApiConfig({
        SPACE_RUNTIME_STORE: "postgres",
        SPACE_DATABASE_URL: TEST_DATABASE_URL,
        SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "true",
        SPACE_MEMORY_EMBEDDING_PROVIDER: "codex-lb",
        SPACE_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
        SPACE_MEMORY_EMBEDDING_DIMENSIONS: "3",
        SPACE_MEMORY_EMBEDDING_BASE_URL: "http://codex-lb.local/v1",
        SPACE_MEMORY_EMBEDDING_KEY_FILE: "/opt/spaceapp/secrets/space-codex-lb-provider.key",
        SPACE_MEMORY_EMBEDDING_KEY_NAME: "space-codex-lb-provider"
      }),
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        pgvectorReady: true,
        readFileImpl: async () => "dummy-codex-lb-credential-that-must-not-leak",
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ embedding: [0.4, 0.5, 0.6] }] })
          };
        }
      }
    );

    expect(result).toMatchObject({
      status: "VERIFIED",
      code: "EMBEDDING_SMOKE_OK",
      pgvectorReady: true,
      embeddingProviderReady: true,
      provider: "codex-lb",
      model: "text-embedding-3-small",
      dimensions: 3
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://codex-lb.local/v1/embeddings");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.stringify(result)).not.toContain("dummy-codex-lb-credential");
  });

  it("keeps the OpenAI provider pinned to the official API host", async () => {
    const result = await runMemoryEmbeddingSmoke(
      getApiConfig({
        SPACE_RUNTIME_STORE: "postgres",
        SPACE_DATABASE_URL: TEST_DATABASE_URL,
        SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "true",
        SPACE_MEMORY_EMBEDDING_PROVIDER: "openai",
        SPACE_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
        SPACE_MEMORY_EMBEDDING_BASE_URL: "http://codex-lb.local/v1",
        SPACE_MEMORY_EMBEDDING_KEY_FILE: "/opt/spaceapp/secrets/space-openai-embedding.key",
        SPACE_MEMORY_EMBEDDING_KEY_NAME: "space-openai-embedding"
      }),
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        pgvectorReady: true,
        readFileImpl: async () => "dummy-credential-that-must-not-leak"
      }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      code: "EMBEDDING_PROVIDER_CONFIG_INVALID",
      embeddingProviderReady: false
    });
    expect(JSON.stringify(result)).not.toContain("dummy-credential");
  });

  it("creates Codex-LB semantic query embeddings without leaking credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const embedding = await createMemoryEmbedding(
      getApiConfig({
        SPACE_RUNTIME_STORE: "postgres",
        SPACE_DATABASE_URL: TEST_DATABASE_URL,
        SPACE_MEMORY_EMBEDDING_PROVIDER: "codex-lb",
        SPACE_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
        SPACE_MEMORY_EMBEDDING_DIMENSIONS: "3",
        SPACE_MEMORY_EMBEDDING_BASE_URL: "http://codex-lb.local/v1",
        SPACE_MEMORY_EMBEDDING_KEY_FILE: "/opt/spaceapp/secrets/space-codex-lb-provider.key",
        SPACE_MEMORY_EMBEDDING_KEY_NAME: "space-codex-lb-provider"
      }),
      "storage blocker",
      {
        readFileImpl: async () => "dummy-codex-lb-credential-that-must-not-leak",
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init });
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: [{ embedding: [0.7, 0.8, 0.9] }] })
          };
        }
      }
    );

    expect(embedding).toEqual([0.7, 0.8, 0.9]);
    expect(calls[0]?.url).toBe("http://codex-lb.local/v1/embeddings");
    expect(JSON.stringify(calls[0]?.init?.body)).not.toContain("dummy-codex-lb-credential");
  });

  it("tells Space Gateway whether a vector is for a query or a document, and never sends the task type to OpenAI itself", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
    };
    const env = { SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: TEST_DATABASE_URL, SPACE_MEMORY_EMBEDDING_MODEL: "gemini-embedding-001",
      SPACE_MEMORY_EMBEDDING_DIMENSIONS: "3", SPACE_MEMORY_EMBEDDING_KEY_FILE: "/opt/spaceapp/secrets/space-gateway-internal.key", SPACE_MEMORY_EMBEDDING_KEY_NAME: "space-gateway-internal" };
    const readFileImpl = async () => "dummy";
    await createMemoryEmbedding(getApiConfig({ ...env, SPACE_MEMORY_EMBEDDING_PROVIDER: "codex-lb", SPACE_MEMORY_EMBEDDING_BASE_URL: "http://127.0.0.1:4920/v1" }),
      "what did we decide", { readFileImpl, fetchImpl, taskType: "RETRIEVAL_QUERY" });
    await createMemoryEmbedding(getApiConfig({ ...env, SPACE_MEMORY_EMBEDDING_PROVIDER: "openai" }), "doc", { readFileImpl, fetchImpl, taskType: "RETRIEVAL_DOCUMENT" });
    expect(bodies[0]).toEqual({ model: "gemini-embedding-001", input: "what did we decide", dimensions: 3, task_type: "RETRIEVAL_QUERY" });
    expect(bodies[1]).not.toHaveProperty("task_type");
  });

  it("fails closed when OpenAI embedding response dimensions do not match pgvector", async () => {
    const result = await runMemoryEmbeddingSmoke(
      getApiConfig({
        SPACE_RUNTIME_STORE: "postgres",
        SPACE_DATABASE_URL: TEST_DATABASE_URL,
        SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED: "true",
        SPACE_MEMORY_EMBEDDING_PROVIDER: "openai",
        SPACE_MEMORY_EMBEDDING_MODEL: "text-embedding-3-small",
        SPACE_MEMORY_EMBEDDING_DIMENSIONS: "3",
        SPACE_MEMORY_EMBEDDING_KEY_FILE: "/opt/spaceapp/secrets/space-openai-embedding.key",
        SPACE_MEMORY_EMBEDDING_KEY_NAME: "space-openai-embedding"
      }),
      {
        now: new Date("2026-06-26T00:00:00.000Z"),
        pgvectorReady: true,
        readFileImpl: async () => "dummy-credential-that-must-not-leak",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ embedding: [0.1, 0.2] }] })
        })
      }
    );

    expect(result).toMatchObject({
      status: "ERROR",
      code: "EMBEDDING_DIMENSIONS_MISMATCH",
      pgvectorReady: true,
      embeddingProviderReady: false
    });
    expect(result.message).toContain("expected 3");
    expect(JSON.stringify(result)).not.toContain("dummy-credential");
  });
});
