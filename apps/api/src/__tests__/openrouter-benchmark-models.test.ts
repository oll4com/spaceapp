import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadOpenRouterBenchmarkModels,
  resetOpenRouterBenchmarkCaches,
  type OpenRouterDeps,
} from "../openrouter-benchmark-models.js";
import { fetchModelTactics } from "../benchmark-routes.js";

const CATALOG = {
  data: [
    {
      id: "acme/chat-free:free",
      name: "Acme Chat (free)",
      pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
    {
      id: "acme/chat-paid",
      name: "Acme Chat Paid",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
    {
      id: "acme/image-only",
      name: "Acme Image",
      pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    },
    {
      id: "acme/chat-paid:batch",
      name: "Acme Batch",
      pricing: { prompt: "0.000001", completion: "0.000002" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
  ],
};

const TEMP_ENV_KEYS = [
  "SPACE_OPENROUTER_TOKEN_FILE",
  "SPACE_OPENROUTER_CATALOG_FILE",
  "SPACE_OPENROUTER_VERIFIED_FILE",
  "SPACE_OPENROUTER_BASE_URL",
] as const;

let dir = "";

async function writeJson(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** Catalog/credits stub with call capture (tuple-safe, unlike vi.fn calls). */
function stubCatalogFetch(credits: unknown, catalog: unknown = CATALOG) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return jsonResponse(String(url).endsWith("/credits") ? credits : catalog);
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function isolatedDeps(overrides: Partial<OpenRouterDeps> & Pick<OpenRouterDeps, "fetchImpl">): OpenRouterDeps {
  return {
    tokenFile: join(dir, "missing.token"),
    catalogFile: join(dir, "missing-catalog.json"),
    verifiedFile: join(dir, "missing-verified.json"),
    cache: false,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "openrouter-bench-"));
  for (const key of TEMP_ENV_KEYS) delete process.env[key];
  resetOpenRouterBenchmarkCaches();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetOpenRouterBenchmarkCaches();
  for (const key of TEMP_ENV_KEYS) delete process.env[key];
});

describe("loadOpenRouterBenchmarkModels", () => {
  it("lists only verified zero-price models when the account has no credits", async () => {
    const verifiedFile = await writeJson(join(dir, "verified.json"), {
      generatedAt: new Date().toISOString(),
      mode: "free",
      hasCredits: false,
      verified: [{ id: "acme/chat-paid" }, { id: "acme/chat-free:free" }],
    });
    const { fetchImpl, calls } = stubCatalogFetch({ data: { total_credits: 15, total_usage: 15.065 } });

    const models = await loadOpenRouterBenchmarkModels(isolatedDeps({ fetchImpl, verifiedFile }));

    expect(calls.map((call) => call.url)).toEqual(["https://openrouter.ai/api/v1/models", "https://openrouter.ai/api/v1/credits"]);
    expect(models.map((model) => model.id)).toEqual(["openrouter/acme/chat-free:free"]);
    expect(models[0]).toMatchObject({ providerId: "openrouter", status: "VERIFIED" });
  });

  it("fails closed without a verification snapshot", async () => {
    const { fetchImpl } = stubCatalogFetch({ data: { total_credits: 1, total_usage: 1 } });

    const models = await loadOpenRouterBenchmarkModels(isolatedDeps({ fetchImpl }));

    expect(models).toEqual([]);
  });

  it("marks a stale verification snapshot", async () => {
    const verifiedFile = await writeJson(join(dir, "verified.json"), {
      generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      mode: "free",
      hasCredits: false,
      verified: [{ id: "acme/chat-free:free" }],
    });
    const { fetchImpl } = stubCatalogFetch({ data: { total_credits: 15, total_usage: 15.5 } });

    const models = await loadOpenRouterBenchmarkModels(isolatedDeps({ fetchImpl, verifiedFile }));

    expect(models.map((model) => model.status)).toEqual(["UNVERIFIED_STALE"]);
  });

  it("lists every chat-capable catalog model when the account has credits", async () => {
    const { fetchImpl } = stubCatalogFetch({ data: { total_credits: 20, total_usage: 15.065 } });

    const models = await loadOpenRouterBenchmarkModels(isolatedDeps({ fetchImpl }));

    expect(models.map((model) => model.id)).toEqual([
      "openrouter/acme/chat-free:free",
      "openrouter/acme/chat-paid",
    ]);
    expect(models.every((model) => model.status === "VERIFIED")).toBe(true);
  });

  it("falls back to the cached catalog when the live catalog is unreachable", async () => {
    const catalogFile = await writeJson(join(dir, "catalog.json"), {
      generatedAt: new Date().toISOString(),
      models: [{ id: "acme/chat-free:free", displayName: "Acme Chat (free)", zeroPrice: true }],
    });
    const verifiedFile = await writeJson(join(dir, "verified.json"), {
      generatedAt: new Date().toISOString(),
      mode: "free",
      hasCredits: false,
      verified: [{ id: "acme/chat-free:free" }],
    });
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/credits")) return jsonResponse({ data: { total_credits: 15, total_usage: 15 } });
      throw new Error("network down");
    }) as unknown as typeof globalThis.fetch;

    const models = await loadOpenRouterBenchmarkModels(isolatedDeps({ fetchImpl, catalogFile, verifiedFile }));

    expect(models.map((model) => model.id)).toEqual(["openrouter/acme/chat-free:free"]);
    expect(models[0]).toMatchObject({ displayName: "Acme Chat (free)" });
  });
});

describe("fetchModelTactics for OpenRouter models", () => {
  async function prepareToken() {
    const tokenFile = join(dir, "openrouter.token");
    await writeFile(tokenFile, "test-token\n", "utf8");
    process.env.SPACE_OPENROUTER_TOKEN_FILE = tokenFile;
    process.env.SPACE_OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
  }

  function stubChatFetch(respond: () => Response) {
    const calls: FetchCall[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return respond();
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, calls };
  }

  it("uses the live OpenRouter answer as the combat doctrine", async () => {
    await prepareToken();
    const doctrine = {
      aggression: 0.9,
      precision: 0.85,
      mobility: 0.7,
      leadAiming: 0.6,
      targetPreference: "enemies",
      tactic: "Aggressive forward sweep",
    };
    const { fetchImpl, calls } = stubChatFetch(() =>
      jsonResponse({ choices: [{ message: { content: `Here you go:\n${JSON.stringify(doctrine)}` } }] })
    );
    vi.stubGlobal("fetch", fetchImpl);

    const tactic = await fetchModelTactics("openrouter/acme/chat-free:free", { rocks: 8, difficulty: 4 });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://openrouter.test/api/v1/chat/completions");
    const body = JSON.parse(String(call?.init?.body));
    expect(body.model).toBe("acme/chat-free:free");
    expect(body.max_tokens).toBe(1500);
    expect(tactic).toMatchObject({
      aggression: 0.9,
      precision: 0.85,
      mobility: 0.7,
      leadAiming: 0.6,
      targetPreference: "enemies",
      tactic: "OR: Aggressive forward sweep",
      source: "model",
    });
  });

  it("falls back to the seed doctrine when OpenRouter rejects the call", async () => {
    await prepareToken();
    const { fetchImpl } = stubChatFetch(() => new Response('{"error":"insufficient credits"}', { status: 402 }));
    vi.stubGlobal("fetch", fetchImpl);

    const tactic = await fetchModelTactics("openrouter/acme/chat-paid", { rocks: 8, difficulty: 4 });

    expect(tactic.source).toBe("fallback");
    expect(tactic.tactic).not.toMatch(/^OR: /);
  }, 20000);
});
