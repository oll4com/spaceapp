import { describe, expect, it, vi } from "vitest";
import { createNousProviderCatalog } from "../src/nous/providers.js";

const active = (provider: string, planType = "subscription") => ({ provider, status: "ACTIVE", planType });
const astra = { id: "gpt-6-astra", label: "GPT-6 Astra", efforts: ["low", "high", "xhigh"] };
const own = async (catalog: { list: () => Promise<Array<{ id: string }>> }) => (await catalog.list()).filter((provider) => provider.id !== "space");
const accountReader = (...data: ReturnType<typeof active>[]) => async () => ({ data });

describe("Nous provider catalog", () => {
  it("uses each native catalog and keeps provider-specific model and effort choices", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes("/backend-api/")
      ? { models: [
        { slug: astra.id, display_name: astra.label, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "xhigh" }] },
        { slug: "hidden-model", visibility: "hide", supported_reasoning_levels: ["high"] },
        { slug: "missing-effort-metadata" },
        { slug: "no-tools", supports_tools: false, supported_reasoning_levels: ["high"] }
      ] }
      : String(url).includes("/pools/") ? { data: [
        { id: "gpt-6-astra" }, { id: "gpt-5.2" }, { id: "o3-mini" }, { id: "gpt-4.1" }, { id: "text-embedding-3-small" },
        { id: "gpt-5-audio" }, { id: "gpt-5-chat-latest" }, { id: "gpt-5-pro" }, { id: "o3-deep-research" }, { id: "gpt-6-no-tools", supports_tools: false }
      ] } : { data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] })));
    const readFileImpl = vi.fn(async () => JSON.stringify({ models: "gemini-3.8-flash-high\tGemini High\ngemini-3.8-flash-medium\tGemini Medium\nclaude-opus-4-6-thinking\tClaude\n" }));
    const catalog = createNousProviderCatalog({
      listAccounts: accountReader(active("CODEX"), active("CLAUDE"), active("ANTIGRAVITY"), active("OPENAI_API", "api")),
      fetchImpl: fetchImpl as typeof fetch, authHeaders: async () => ({ Authorization: "Bearer internal-test-key" }), readFileImpl
    });
    const result = await own(catalog) as Awaited<ReturnType<typeof catalog.list>>;
    expect(result.map((provider) => [provider.id, provider.available])).toEqual([["codex", true], ["claude", true], ["gemini", true]]);
    expect(result[0].models).toEqual([astra]);
    expect(result[1].models[0]).toMatchObject({ id: "claude-opus-5-5", label: "Claude Opus 5.5" });
    expect(result[2].models.map((model) => [model.id, model.efforts])).toEqual([["gemini-3.8-flash-high", ["none"]], ["gemini-3.8-flash-medium", ["none"]]]);
    expect(readFileImpl).toHaveBeenCalledWith("/opt/spaceapp/var/gemini-models.last-good.json");
    // A provider that is up but lists no Argon model says so.
    expect((await catalog.list())[0].routes?.find((route) => route.route === "ANTIGRAVITY")).toMatchObject({ available: false, reason: "No Argon model in provider catalog." });
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("/v1/models?limit=100"), expect.objectContaining({
      headers: { Authorization: "Bearer internal-test-key", "anthropic-version": "2023-06-01", "user-agent": "claude-code/space-nous-catalog" }, redirect: "error"
    }));
  });

  it("does not confuse Claude API credits, paused accounts or installed runtimes with active subscriptions", async () => {
    const loader = vi.fn(async () => [astra]);
    const claude = vi.fn(async () => [{ id: "claude-opus-5-5", label: "Opus", efforts: ["high"] }]);
    const catalog = createNousProviderCatalog({ listAccounts: async () => ({ data: [
      active("CLAUDE", "api"), { ...active("CODEX"), status: "PAUSED" }, { ...active("ANTIGRAVITY"), status: "RATE_LIMITED" }
    ] }), modelLoaders: { codex: loader, claude, gemini: loader } });
    const all = await catalog.list();
    const providers = all.filter((provider) => provider.id !== "space");
    expect(providers.every((provider) => !provider.available)).toBe(true);
    expect(providers.find((provider) => provider.id === "claude")?.reason).toContain("subscription");
    // The API-key account never serves Nous, not even through "Claude via OpenCode" (operator decision 8/11).
    expect(all[0].routes?.filter((route) => route.available).map((route) => route.route)).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
    // Space routes include only the 6 subscription/native routes: Claude, Codex, Claude OpenCode, Gemini Argon, Gemini 3.8 Flash and Claude (Antigravity).
    expect(all[0].routes?.map((route) => route.route)).toEqual(["CLAUDE", "CODEX", "CLAUDE_OPENCODE", "ANTIGRAVITY", "ANTIGRAVITY_FLASH", "ANTIGRAVITY_CLAUDE"]);
    expect(all[0].routes?.find((route) => route.route === "ANTIGRAVITY")?.name).toBe("Gemini Argon (Antigravity)");
    expect(all[0].routes?.find((route) => route.route === "ANTIGRAVITY_FLASH")?.name).toBe("Gemini 3.8 Flash (Antigravity)");
    expect(all[0].routes?.find((route) => route.route === "ANTIGRAVITY_CLAUDE")?.name).toBe("Claude (Antigravity)");
    // An unavailable provider keeps its own reason on every Antigravity route, not "No … model in provider catalog" (12/11).
    expect(all[0].routes?.filter((route) => route.route.startsWith("ANTIGRAVITY")).map((route) => route.reason))
      .toEqual(Array(3).fill("Its Space Gateway accounts are paused or out of quota."));
  });

  it("does not include free pools or third-party relays on the Space provider", async () => {
    const catalog = createNousProviderCatalog({ listAccounts: accountReader(active("INCEPTION", "api"), active("OPENROUTER", "api"), { ...active("GROQ", "api"), status: "PAUSED" },
      active("AGENTROUTER", "api")), modelLoaders: { codex: async () => [], claude: async () => [], gemini: async () => [] }, fetchImpl: (async () => Response.json({ data: [] })) as unknown as typeof fetch });
    const routes = await catalog.routes();
    expect(routes.filter((route) => route.free)).toEqual([]);
    expect(routes.some((route) => route.route === "AGENTROUTER" || route.route === "FREEAI" || route.route === "INCEPTION")).toBe(false);
  });

  it("does not offer OpenRouter, DeepSeek or other gateway accounts in the Nous provider catalog", async () => {
    const catalog = createNousProviderCatalog({ listAccounts: accountReader(active("OPENROUTER", "api"), active("DEEPSEEK", "api"), active("GOOGLE_AI", "api")) });
    const providers = await catalog.list();
    expect(providers.map((provider) => provider.id)).toEqual(["space", "codex", "claude", "gemini"]);
    expect(providers.find((provider) => provider.id === "openrouter")).toBeUndefined();
    expect(providers.find((provider) => provider.id === "deepseek")).toBeUndefined();
    expect(providers.find((provider) => provider.id === "google_ai")).toBeUndefined();
  });

  it("fails closed when accounts or model metadata cannot be checked, without exposing upstream error text", async () => {
    const accountFailure = createNousProviderCatalog({ listAccounts: async () => { throw new Error("private account details"); } });
    expect((await accountFailure.list()).every((provider) => !provider.available && !provider.reason?.includes("private"))).toBe(true);
    const modelFailure = createNousProviderCatalog({ listAccounts: accountReader(active("CODEX")), modelLoaders: { codex: async () => { throw new Error("secret response"); } } });
    expect((await own(modelFailure))[0]).toMatchObject({ available: false, models: [], reason: "The provider model catalog is unavailable." });
  });

  it("keeps public credential-container choices unavailable until they have a supported runner", async () => {
    const codex = vi.fn(async () => [astra]);
    const catalog = createNousProviderCatalog({ publicCredentialHost: true, listAccounts: accountReader(active("CODEX"), active("CLAUDE")),
      modelLoaders: { codex, claude: async () => [{ id: "claude-opus-5-5", label: "Opus", efforts: ["high"] }] } });
    expect((await own(catalog) as Awaited<ReturnType<typeof catalog.list>>).map((provider) => [provider.id, provider.available])).toEqual([["codex", false], ["claude", true], ["gemini", false]]);
    expect(codex).not.toHaveBeenCalled();
  });

  it("does not advertise an active embeddings-only OpenAI account as a working Nous provider", async () => {
    const catalog = createNousProviderCatalog({ listAccounts: accountReader(active("OPENAI_API", "api")), authHeaders: async () => ({}),
      fetchImpl: (async () => new Response(JSON.stringify({ data: [{ id: "text-embedding-3-small" }, { id: "gpt-image-1" }, { id: "whisper-1" }] }))) as typeof fetch });
    expect((await catalog.list()).find((provider) => provider.id === "openai")).toBeUndefined();
  });

  it("validates provider, model and effort together, and rechecks current account availability", async () => {
    let enabled = true;
    const loader = vi.fn(async () => [astra]);
    const catalog = createNousProviderCatalog({ listAccounts: async () => ({ data: enabled ? [active("CODEX")] : [] }), modelLoaders: { codex: loader } });
    await expect(catalog.validate({ provider: "codex", model: astra.id, effort: "high" })).resolves.toBeUndefined();
    await expect(catalog.validate({ provider: "codex", model: "claude-opus-5-5", effort: "high" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(catalog.validate({ provider: "codex", model: astra.id, effort: "max" })).rejects.toThrow("reasoning effort");
    enabled = false;
    await expect(catalog.validate({ provider: "codex", model: astra.id, effort: "high" })).rejects.toThrow("No active");
    expect(loader).toHaveBeenCalledTimes(1);

    const geminiFlash = { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)", efforts: ["none"] };
    const geminiCatalog = createNousProviderCatalog({ listAccounts: async () => ({ data: [active("ANTIGRAVITY")] }), modelLoaders: { gemini: async () => [geminiFlash] } });
    await expect(geminiCatalog.validate({ provider: "gemini", model: geminiFlash.id, effort: "none" })).resolves.toBeUndefined();
    await expect(geminiCatalog.validate({ provider: "gemini", model: geminiFlash.id, effort: "high" })).resolves.toBeUndefined();
  });

  it("coalesces model discovery, expires model metadata and removes a retired model", async () => {
    let time = 0;
    const loader = vi.fn().mockResolvedValueOnce([astra]).mockResolvedValueOnce([]);
    const catalog = createNousProviderCatalog({ listAccounts: accountReader(active("CODEX")), modelLoaders: { codex: loader }, now: () => time });
    const [a, b] = await Promise.all([catalog.list(), catalog.list()]);
    expect(a[0].models).toEqual(b[0].models);
    expect(loader).toHaveBeenCalledTimes(1);
    time = 30_001;
    expect((await catalog.list())[0]).toMatchObject({ available: false, models: [] });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("validates the selected provider without waiting for other provider catalogs", async () => {
    const unrelated = vi.fn(() => new Promise<never>(() => {}));
    const catalog = createNousProviderCatalog({ listAccounts: accountReader(active("CODEX"), active("CLAUDE")),
      modelLoaders: { codex: async () => [astra], claude: unrelated } });
    await expect(catalog.validate({ provider: "codex", model: astra.id, effort: "high" })).resolves.toBeUndefined();
    expect(unrelated).not.toHaveBeenCalled();
  });
});
