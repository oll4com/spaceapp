import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { memoryEmbeddingSmokeResultSchema, type MemoryEmbeddingSmokeResult } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";

interface EmbeddingSmokeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type EmbeddingFetchLike = (url: string, init: RequestInit) => Promise<EmbeddingSmokeResponse>;
type MemoryEmbeddingProvider = "openai" | "codex-lb";

export interface MemoryEmbeddingSmokeOptions {
  now?: Date;
  pgvectorReady?: boolean;
  fetchImpl?: EmbeddingFetchLike;
  readFileImpl?: (path: string) => Promise<string>;
}

export interface CreateMemoryEmbeddingOptions {
  fetchImpl?: EmbeddingFetchLike;
  readFileImpl?: (path: string) => Promise<string>;
}

function parseMemoryEmbeddingProvider(provider: string): MemoryEmbeddingProvider | null {
  return provider === "openai" || provider === "codex-lb" ? provider : null;
}

function embeddingProviderName(provider: MemoryEmbeddingProvider): string {
  return provider === "codex-lb" ? "Codex-LB" : "OpenAI";
}

function finishResult(
  input: Omit<MemoryEmbeddingSmokeResult, "id" | "startedAt" | "finishedAt" | "durationMs"> & {
    startedAt: Date;
    finishedAt: Date;
  }
): MemoryEmbeddingSmokeResult {
  return memoryEmbeddingSmokeResultSchema.parse({
    id: "memory-embedding-smoke",
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    status: input.status,
    code: input.code,
    message: input.message,
    smokeEnabled: input.smokeEnabled,
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    pgvectorReady: input.pgvectorReady,
    embeddingProviderReady: input.embeddingProviderReady
  });
}

export async function runMemoryEmbeddingSmoke(
  config: SpaceApiConfig,
  options: MemoryEmbeddingSmokeOptions = {}
): Promise<MemoryEmbeddingSmokeResult> {
  const startedAt = options.now ?? new Date();
  const finish = () => new Date();
  const provider = config.memoryEmbeddingProvider;
  const model = config.memoryEmbeddingModel;
  const dimensions = config.memoryEmbeddingDimensions;
  const smokeEnabled = config.memoryEmbeddingSmokeEnabled === true;
  const pgvectorReady = options.pgvectorReady === true;

  if (!smokeEnabled) {
    return finishResult({
      status: "DISABLED",
      code: "EMBEDDING_SMOKE_DISABLED",
      message: "SPACE_MEMORY_EMBEDDING_SMOKE_ENABLED=true is required before embedding smoke can run.",
      smokeEnabled: false,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  if (config.runtimeStore !== "postgres") {
    return finishResult({
      status: "DISABLED",
      code: "RUNTIME_STORE_NOT_POSTGRES",
      message: "Semantic memory smoke requires SPACE_RUNTIME_STORE=postgres and pgvector-backed storage.",
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady: false,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!pgvectorReady) {
    return finishResult({
      status: "ERROR",
      code: "PGVECTOR_UNAVAILABLE",
      message: "Postgres is configured, but pgvector readiness has not been confirmed.",
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady: false,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!provider || !model) {
    return finishResult({
      status: "DISABLED",
      code: "EMBEDDING_PROVIDER_MISSING",
      message: "Embedding provider and model config are required before semantic memory can be enabled.",
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  const embeddingProvider = parseMemoryEmbeddingProvider(provider);
  if (!embeddingProvider) {
    return finishResult({
      status: "ERROR",
      code: "EMBEDDING_PROVIDER_UNSUPPORTED",
      message: `Embedding provider ${provider} is not supported yet. Only OpenAI and Codex-LB embedding smoke are implemented.`,
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  const credentialLabel = config.memoryEmbeddingKeyName ?? (config.memoryEmbeddingKeyFile ? basename(config.memoryEmbeddingKeyFile) : null);
  if (!credentialLabel?.startsWith("space-")) {
    return finishResult({
      status: "ERROR",
      code: "EMBEDDING_KEY_NAME_NOT_DEDICATED",
      message: "Embedding key label must start with space- before Space can run a provider credential smoke.",
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!config.memoryEmbeddingKeyFile) {
    return finishResult({
      status: "DISABLED",
      code: "EMBEDDING_CREDENTIAL_MISSING",
      message: `SPACE_MEMORY_EMBEDDING_KEY_FILE is required before ${embeddingProviderName(embeddingProvider)} embedding smoke can run.`,
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  const readCredential = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
  let credential: string;
  try {
    credential = (await readCredential(config.memoryEmbeddingKeyFile)).trim();
  } catch {
    return finishResult({
      status: "ERROR",
      code: "EMBEDDING_KEY_FILE_UNREADABLE",
      message: "Embedding key file could not be read.",
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  if (!credential) {
    return finishResult({
      status: "ERROR",
      code: "EMBEDDING_KEY_FILE_UNREADABLE",
      message: "Embedding key file is empty.",
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  let endpoint: string;
  try {
    endpoint = embeddingsUrl(embeddingProvider, config.memoryEmbeddingBaseUrl);
  } catch {
    return finishResult({
      status: "ERROR",
      code: "EMBEDDING_PROVIDER_CONFIG_INVALID",
      message:
        embeddingProvider === "openai"
          ? "OpenAI embedding smoke requires SPACE_MEMORY_EMBEDDING_BASE_URL to be https://api.openai.com/v1."
          : "Codex-LB embedding smoke requires SPACE_MEMORY_EMBEDDING_BASE_URL to be an http(s) Codex-LB /v1 endpoint.",
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  }

  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), config.memoryEmbeddingTimeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: "Space embedding smoke check.",
        dimensions
      }),
      signal: abort.signal
    });

    if (!response.ok) {
      return finishResult({
        status: "ERROR",
        code: "EMBEDDING_PROVIDER_SMOKE_FAILED",
        message: `${embeddingProviderName(embeddingProvider)} embedding smoke failed with HTTP ${response.status}.`,
        smokeEnabled,
        provider,
        model,
        dimensions,
        pgvectorReady,
        embeddingProviderReady: false,
        startedAt,
        finishedAt: finish()
      });
    }

    const embeddingDimensions = parseEmbeddingDimensions(await response.json());
    if (embeddingDimensions === null) {
      return finishResult({
        status: "ERROR",
        code: "EMBEDDING_PROVIDER_RESPONSE_INVALID",
        message: `${embeddingProviderName(embeddingProvider)} embedding smoke returned an unexpected embedding response shape.`,
        smokeEnabled,
        provider,
        model,
        dimensions,
        pgvectorReady,
        embeddingProviderReady: false,
        startedAt,
        finishedAt: finish()
      });
    }

    if (embeddingDimensions !== dimensions) {
      return finishResult({
        status: "ERROR",
        code: "EMBEDDING_DIMENSIONS_MISMATCH",
        message: `${embeddingProviderName(embeddingProvider)} embedding smoke returned ${embeddingDimensions} dimensions, expected ${dimensions}.`,
        smokeEnabled,
        provider,
        model,
        dimensions,
        pgvectorReady,
        embeddingProviderReady: false,
        startedAt,
        finishedAt: finish()
      });
    }

    return finishResult({
      status: "VERIFIED",
      code: "EMBEDDING_SMOKE_OK",
      message: `${embeddingProviderName(embeddingProvider)} embedding provider smoke completed and pgvector storage is ready.`,
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: true,
      startedAt,
      finishedAt: finish()
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "failed";
    return finishResult({
      status: "ERROR",
      code: "EMBEDDING_PROVIDER_SMOKE_FAILED",
      message: `${embeddingProviderName(embeddingProvider)} embedding smoke ${reason}.`,
      smokeEnabled,
      provider,
      model,
      dimensions,
      pgvectorReady,
      embeddingProviderReady: false,
      startedAt,
      finishedAt: finish()
    });
  } finally {
    clearTimeout(timeout);
  }
}

function embeddingsUrl(provider: MemoryEmbeddingProvider, baseUrl: string): string {
  const base = new URL(baseUrl);
  if (provider === "openai") {
    if (base.protocol !== "https:" || base.hostname !== "api.openai.com") {
      throw new Error("Unsupported OpenAI embeddings base URL.");
    }
  } else if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Unsupported Codex-LB embeddings base URL.");
  }
  if (base.username || base.password) {
    throw new Error("Embedding provider base URL must not include credentials.");
  }
  const normalized = base.href.endsWith("/") ? base.href : `${base.href}/`;
  return new URL("embeddings", normalized).toString();
}

function parseEmbeddingDimensions(payload: unknown): number | null {
  const embedding = parseEmbeddingVector(payload);
  return embedding ? embedding.length : null;
}

function parseEmbeddingVector(payload: unknown): number[] | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const first = data[0];
  if (!first || typeof first !== "object") return null;
  const embedding = (first as { embedding?: unknown }).embedding;
  if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) return null;
  return embedding;
}

export async function createMemoryEmbedding(
  config: SpaceApiConfig,
  input: string,
  options: CreateMemoryEmbeddingOptions = {}
): Promise<number[]> {
  if (!config.memoryEmbeddingProvider || !config.memoryEmbeddingModel) {
    throw new Error("Memory embedding provider is not configured.");
  }
  const embeddingProvider = parseMemoryEmbeddingProvider(config.memoryEmbeddingProvider);
  if (!embeddingProvider) {
    throw new Error("Configured memory embedding provider is not supported.");
  }
  const credentialLabel =
    config.memoryEmbeddingKeyName ?? (config.memoryEmbeddingKeyFile ? basename(config.memoryEmbeddingKeyFile) : null);
  if (!credentialLabel?.startsWith("space-") || !config.memoryEmbeddingKeyFile) {
    throw new Error("Dedicated Space embedding credential is not configured.");
  }
  const endpoint = embeddingsUrl(embeddingProvider, config.memoryEmbeddingBaseUrl);
  const readCredential = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
  const credential = (await readCredential(config.memoryEmbeddingKeyFile)).trim();
  if (!credential) {
    throw new Error("Embedding credential file is empty.");
  }
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), config.memoryEmbeddingTimeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.memoryEmbeddingModel,
        input,
        dimensions: config.memoryEmbeddingDimensions
      }),
      signal: abort.signal
    });
    if (!response.ok) {
      throw new Error(`${embeddingProviderName(embeddingProvider)} embedding request failed with HTTP ${response.status}.`);
    }
    const embedding = parseEmbeddingVector(await response.json());
    if (!embedding) {
      throw new Error(`${embeddingProviderName(embeddingProvider)} embedding response shape was invalid.`);
    }
    if (embedding.length !== config.memoryEmbeddingDimensions) {
      throw new Error(`${embeddingProviderName(embeddingProvider)} embedding dimensions did not match configured pgvector dimensions.`);
    }
    return embedding;
  } finally {
    clearTimeout(timeout);
  }
}
