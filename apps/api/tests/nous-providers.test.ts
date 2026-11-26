import { describe, expect, it, vi } from "vitest";
import { createNousProviderCatalog, NOUS_PUBLIC_NO_CLAUDE } from "../src/nous/providers.js";

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
    // The API-key account serves Nous only through "Claude via OpenCode" (nous_msg:35d3e36f8d414784bde8e43f, superseding 8/11), never Claude Code.
    expect(all[0].routes?.filter((route) => route.available).map((route) => route.route)).toEqual(["CLAUDE_OPENCODE"]);
    // Paused or rate-limited accounts still list their models, unavailable, so Settings offers them (operator 24/11, f1fdc799).
    expect(providers.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
    // Space routes include only the 6 subscription/native routes: Claude, Codex, Claude OpenCode, Gemini Neon, Gemini 3.8 Flash and Claude (Antigravity).
    expect(all[0].routes?.map((route) => route.route)).toEqual(["CLAUDE", "CODEX", "CLAUDE_OPENCODE", "ANTIGRAVITY", "ANTIGRAVITY_CLAUDE", "ANTIGRAVITY_FLASH"]);
    expect(all[0].routes?.find((route) => route.route === "ANTIGRAVITY")?.name).toBe("Gemini Neon (Antigravity)");
    expect(all[0].routes?.find((route) => route.route === "ANTIGRAVITY_FLASH")?.name).toBe("Gemini 3.8 Flash (Antigravity)");
    expect(all[0].routes?.find((route) => route.route === "ANTIGRAVITY_CLAUDE")?.name).toBe("Claude (Antigravity)");
    // An unavailable provider keeps its own reason on every Antigravity route, not "No … model in provider catalog" (12/11).
    expect(all[0].routes?.filter((route) => route.route.startsWith("ANTIGRAVITY")).map((route) => route.reason))
      .toEqual(Array(3).fill("Its Space Gateway accounts are paused or out of quota."));
  });

  it("marks Claude via OpenCode unavailable when the Claude API monthly budget is reached", async () => {
    const claude = vi.fn(async () => [{ id: "claude-opus-5-5", label: "Opus", efforts: ["high"] }]);
    const catalog = createNousProviderCatalog({
      listAccounts: async () => ({ data: [active("CLAUDE", "api")] }),
      apiBudget: async () => ({ budgetUsd: 900, monthSpentUsd: 900.09, remainingUsd: -0.09, daysLeft: 13, allowanceTodayUsd: 0.85, todaySpentUsd: 11.1, stop: "MONTHLY_BUDGET_REACHED" }),
      modelLoaders: { claude }
    });
    const routes = await catalog.routes();
    const opencode = routes.find((route) => route.route === "CLAUDE_OPENCODE");
    expect(opencode).toMatchObject({ available: false, reason: "Claude API monthly budget reached." });
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
    // Without Claude a public install still answers on the free model: the reason says so, not "API credits do not serve Nous".
    const none = createNousProviderCatalog({ publicCredentialHost: true, listAccounts: async () => ({ data: [] }) });
    expect((await none.list()).find((provider) => provider.id === "claude")).toMatchObject({ available: false, reason: NOUS_PUBLIC_NO_CLAUDE });
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

  it("reads an Antigravity route's room from its quota group and names the reset of a pool's full windows (17/11)", async () => {
    const at = Date.parse("2026-11-17T13:00:00Z");
    const w = (usedPercent: number, resetAt: string) => ({ usedPercent, resetAt });
    const pro = { ...active("ANTIGRAVITY"), quotaGroups: [{ key: "claude", primaryWindow: w(0, "2026-11-17T17:41:00Z"), secondaryWindow: w(100, "2026-11-18T01:16:00Z") },
      { key: "gemini", primaryWindow: w(100, "2026-11-20T23:19:00Z"), secondaryWindow: w(100, "2026-11-21T03:43:00Z") }] };
    // Its Argon 5-hour bucket full, its week at 98%: Flash answered here.
    const free = { ...pro, quotaGroups: [pro.quotaGroups[0], { key: "gemini", primaryWindow: w(100, "2026-11-24T05:21:00Z"), secondaryWindow: w(98.3, "2026-11-24T05:21:00Z") }] };
    const codex = { ...active("CODEX"), status: "RATE_LIMITED", primaryWindow: w(0, "2026-11-17T17:47:00Z"), secondaryWindow: w(100, "2026-11-21T01:45:00Z") };
    const gemini = async () => [{ id: "gemini-4-argon-high", label: "Argon", efforts: ["none"] }, { id: "gemini-4-hydrogen-high", label: "Hydrogen", efforts: ["none"] },
      { id: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator", efforts: ["none"] }, { id: "gemini-3.8-flash-high", label: "Flash", efforts: ["none"] },
      { id: "claude-sonnet-5-5-medium", label: "Sonnet", efforts: ["none"] }];
    const catalog = createNousProviderCatalog({ listAccounts: async () => ({ data: [pro, free, codex] }), modelLoaders: { gemini, codex: async () => [astra] }, now: () => at });
    const routes = Object.fromEntries(((await catalog.list())[0].routes ?? []).map((route) => [route.route, route]));
    expect(routes.ANTIGRAVITY).toMatchObject({ available: false, resetAt: "2026-11-21T03:43:00.000Z" });
    expect(routes.ANTIGRAVITY_FLASH).toMatchObject({ available: true, resetAt: null });
    expect(routes.ANTIGRAVITY_CLAUDE).toMatchObject({ available: false, resetAt: "2026-11-18T01:16:00.000Z" });
    expect(routes.CODEX).toMatchObject({ available: false, resetAt: "2026-11-21T01:45:00.000Z" });
    const fullRoutes = Object.fromEntries((await catalog.routes()).map((route) => [route.route, route]));
    expect(fullRoutes.ANTIGRAVITY_FLASH?.models.map((m) => m.id)).toEqual(["gemini-3.8-flash-high"]);
    const openPro = { ...pro, quotaGroups: [pro.quotaGroups[0], { key: "gemini", primaryWindow: w(20, "2026-11-20T23:19:00Z"), secondaryWindow: w(10, "2026-11-21T03:43:00Z") }] };
    const openCatalog = createNousProviderCatalog({ listAccounts: async () => ({ data: [openPro] }), modelLoaders: { gemini }, now: () => at });
    const openRoutes = Object.fromEntries((await openCatalog.routes()).map((route) => [route.route, route]));
    expect(openRoutes.ANTIGRAVITY?.models.map((m) => m.id)).toEqual(["gemini-4-argon-high", "gemini-4-hydrogen-high"]);

    // When Argon quota is exhausted (100%), ANTIGRAVITY falls back cleanly to Hydrogen and stays available
    const argonSpentPro = { ...pro, quotaGroups: [
      pro.quotaGroups[0],
      { key: "argon", primaryWindow: w(100, "2026-11-20T23:19:00Z"), secondaryWindow: w(100, "2026-11-21T03:43:00Z") },
      { key: "gemini", primaryWindow: w(20, "2026-11-20T23:19:00Z"), secondaryWindow: w(10, "2026-11-21T03:43:00Z") }
    ] };
    const argonSpentCatalog = createNousProviderCatalog({ listAccounts: async () => ({ data: [argonSpentPro] }), modelLoaders: { gemini }, now: () => at });
    const argonSpentRoutes = Object.fromEntries((await argonSpentCatalog.routes()).map((route) => [route.route, route]));
    expect(argonSpentRoutes.ANTIGRAVITY).toMatchObject({ available: true });
    expect(argonSpentRoutes.ANTIGRAVITY?.models.map((m) => m.id)).toEqual(["gemini-4-hydrogen-high"]);

    // Operator 22/11 c74c7453: a catalog with Neon serves Neon, never Argon; the Neon orchestrator stays out of both routes.
    const withNeon = async () => [...await gemini(), { id: "gemini-4-neon-high", label: "Neon", efforts: ["none"] }, { id: "gemini-pro-orchestrator-neon", label: "Orchestrator", efforts: ["none"] }];
    const neonRoutes = Object.fromEntries((await createNousProviderCatalog({ listAccounts: async () => ({ data: [openPro] }), modelLoaders: { gemini: withNeon }, now: () => at }).routes()).map((route) => [route.route, route]));
    expect(neonRoutes.ANTIGRAVITY?.models.map((m) => m.id)).toEqual(["gemini-4-hydrogen-high", "gemini-4-neon-high"]);
    expect(neonRoutes.ANTIGRAVITY_FLASH?.models.map((m) => m.id)).toEqual(["gemini-3.8-flash-high"]);
  });
});
