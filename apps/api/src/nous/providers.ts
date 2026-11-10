import { readFile } from "node:fs/promises";
import { GATEWAY_DEFAULT_PROVIDER_ORDER, NOUS_FREE_ROUTE_MODELS, NOUS_PROVIDER_GATEWAY, nousFreeRouteProvider, NOUS_PROVIDER_NAMES, NOUS_SPACE_AUTO, NOUS_SPACE_ROUTES, type GatewayProviderOrder,
  type GatewayProviderRoute, type NousProvider, type NousProviderModel, type NousProviderOption } from "@space/contracts";
import type { SpaceRoute } from "./space-provider.js";
import { CODEX_LB_BASE_URL, codexAuthHeaders } from "../asteroids-arena/providers.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

type SupportedProvider = Exclude<NousProvider, "space">;
type Window = { resetAt?: string | null; usedPercent?: number | null } | null | undefined;
type CatalogAccount = { id?: string; provider: string; status: string; planType?: string | null; primaryWindow?: Window; secondaryWindow?: Window };
type ModelLoader = () => Promise<NousProviderModel[]>;
export interface NousProviderCatalogOptions {
  /** Sanitized gateway account metadata, never credentials. Re-read on every selection and validation. */
  listAccounts?: () => Promise<{ data: CatalogAccount[] }>;
  /** Public credential containers currently implement only Claude's Nous tool loop. */
  publicCredentialHost?: boolean;
  modelLoaders?: Partial<Record<SupportedProvider, ModelLoader>>;
  /** Space Gateway's provider order (settings `providerOrder`) for the Space provider; default the operator's first order. */
  providerOrder?: () => Promise<GatewayProviderOrder>;
  /** A Space route's cool-down after a refusal (space-provider.ts), shown as its reason. */
  cooling?: (route: GatewayProviderRoute) => { until: string; reason: string } | null;
  fetchImpl?: typeof fetch;
  authHeaders?: () => Promise<Record<string, string>>;
  readFileImpl?: (path: string) => Promise<string>;
  now?: () => number;
  cacheMs?: number;
}

const PROVIDERS = (Object.keys(NOUS_PROVIDER_NAMES) as NousProvider[]).map((id) => ({ id, name: NOUS_PROVIDER_NAMES[id], gateway: NOUS_PROVIDER_GATEWAY[id] }));
/**
 * Each Space route's own provider option; the OpenCode route reads the Claude catalog but runs on the API-key account.
 */
const ROUTE_PROVIDER: Partial<Record<GatewayProviderRoute, SupportedProvider>> = {
  CLAUDE: "claude", CODEX: "codex", CLAUDE_OPENCODE: "claude", ANTIGRAVITY: "gemini", ANTIGRAVITY_FLASH: "gemini", ANTIGRAVITY_CLAUDE: "gemini"
};
// The thinking budgets the OpenCode runner maps (scripts/space-opencode-nous-turn.mjs).
const OPENCODE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const GEMINI_MODELS_FILE = `${SPACE_INSTALL_ROOT}/var/gemini-models.last-good.json`;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";

function modelRows(value: unknown): Record<string, unknown>[] {
  const body = object(value);
  const rows = body?.models ?? body?.data;
  return Array.isArray(rows) ? rows.map(object).filter((row): row is Record<string, unknown> => row !== null) : [];
}

function cleanModels(models: NousProviderModel[]): NousProviderModel[] {
  const seen = new Set<string>();
  return models.flatMap((model) => {
    const id = string(model.id);
    const efforts = [...new Set(model.efforts.filter((effort) => EFFORTS.has(effort)))];
    if (!MODEL_ID.test(id) || seen.has(id) || !efforts.length) return [];
    seen.add(id);
    return [{ id, label: string(model.label).slice(0, 160) || id, efforts }];
  });
}

function codexModels(payload: unknown): NousProviderModel[] {
  return modelRows(payload).flatMap((row) => {
    if (row.visibility === "hide" || row.supports_tools === false || row.supports_function_calling === false) return [];
    const levels = row.supported_reasoning_levels ?? row.supportedReasoningEfforts;
    const efforts = Array.isArray(levels) ? levels.map((level) => string(object(level)?.effort ?? object(level)?.reasoningEffort ?? level)) : [];
    // Missing reasoning metadata is not evidence that an arbitrary effort will work.
    return [{ id: string(row.slug ?? row.id), label: string(row.display_name ?? row.displayName ?? row.name), efforts }];
  });
}

function claudeModels(payload: unknown): NousProviderModel[] {
  return modelRows(payload).filter((row) => /^claude-/.test(string(row.id))).map((row) => ({
    id: string(row.id), label: string(row.display_name ?? row.displayName),
    // The native Claude Code runner accepts these effort levels; Anthropic's listing has no effort field.
    efforts: ["low", "medium", "high", "xhigh", "max"]
  }));
}

/** Live gateway catalogs and the native Gemini catalog snapshot; never an installed-CLI or hardcoded-model inventory. */
export function createNousProviderCatalog(options: NousProviderCatalogOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const authHeaders = options.authHeaders ?? codexAuthHeaders;
  const read = options.readFileImpl ?? ((path: string) => readFile(path, "utf8"));
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? 30_000;
  const cached = new Map<SupportedProvider, { at: number; models: NousProviderModel[] }>();
  const pending = new Map<SupportedProvider, Promise<NousProviderModel[]>>();

  async function gateway(path: string, headers: Record<string, string> = {}): Promise<unknown> {
    const response = await fetchImpl(`${CODEX_LB_BASE_URL}${path}`, {
      headers: { ...await authHeaders(), ...headers }, signal: AbortSignal.timeout(15_000), redirect: "error"
    });
    if (!response.ok) throw new Error("Provider model catalog is unavailable.");
    return response.json();
  }
  const loaders: Record<SupportedProvider, ModelLoader> = {
    codex: options.modelLoaders?.codex ?? (async () => codexModels(await gateway("/backend-api/codex/models"))),
    claude: options.modelLoaders?.claude ?? (async () => claudeModels(await gateway("/v1/models?limit=100", {
      "anthropic-version": "2023-06-01", "user-agent": "claude-code/space-nous-catalog"
    }))),
    gemini: options.modelLoaders?.gemini ?? (async () => {
      const payload = object(JSON.parse(await read(GEMINI_MODELS_FILE)));
      return string(payload?.models).split("\n").flatMap((line) => {
        const [id, label] = line.split("\t").map((part) => part.trim());
        // This native runner targets Gemini and Antigravity's Claude models. Thinking variants are encoded in the native model id.
        return id && /^(?:gemini|claude)-/.test(id) ? [{ id, label: label || id, efforts: ["none"] }] : [];
      });
    })
  };

  function modelsFor(provider: SupportedProvider): Promise<NousProviderModel[]> {
    const recent = cached.get(provider);
    if (recent && now() - recent.at < cacheMs) return Promise.resolve(recent.models);
    const running = pending.get(provider);
    if (running) return running;
    const result = Promise.resolve().then(loaders[provider]).then(cleanModels).then((models) => {
      if (models.length) cached.set(provider, { at: now(), models });
      else cached.delete(provider);
      return models;
    }).finally(() => pending.delete(provider));
    pending.set(provider, result);
    return result;
  }

  async function accountState() {
    let accounts: CatalogAccount[] = [];
    let accountsAvailable = false;
    try {
      if (options.listAccounts) { accounts = (await options.listAccounts()).data; accountsAvailable = true; }
    } catch { /* No private gateway failure text is included in the public catalog. */ }
    return { accounts, accountsAvailable };
  }

  // Read cached windows only: no upstream probe. A spent weekly window still blocks an expired 5h window.
  function quotaState(account: CatalogAccount) {
    const windows = [account.primaryWindow, account.secondaryWindow].filter((window) => window?.usedPercent != null);
    const expired = (window: Window) => Number.isFinite(Date.parse(window?.resetAt ?? "")) && Date.parse(window!.resetAt!) <= now();
    const blocked = windows.some((window) => window!.usedPercent! >= 100 && !expired(window));
    const reset = windows.some(expired);
    const eligible = account.status === "ACTIVE" || (["RATE_LIMITED", "QUOTA_EXCEEDED"].includes(account.status) && reset);
    return { eligible: eligible && !blocked, ready: eligible && !blocked && windows.length > 0 };
  }

  // The Gemini provider itself offers Gemini models only; Antigravity's Claude models are its own Space route (`antigravityClaude`).
  async function providerOption({ id, name, gateway: provider }: typeof PROVIDERS[number], { accounts, accountsAvailable }: Awaited<ReturnType<typeof accountState>>, antigravityClaude = false): Promise<NousProviderOption> {
    const base = { id, name, available: false, models: [] as NousProviderModel[] };
    if (options.publicCredentialHost && id !== "claude") {
      return { ...base, reason: "This installation's credential container does not support this Nous provider yet." };
    }
    if (!accountsAvailable) return { ...base, reason: "The active provider accounts could not be checked." };
    const active = accounts.some((account) => account.provider === provider && quotaState(account).eligible
      && (id !== "claude" || account.planType?.toLowerCase() !== "api"));
    if (!active) return { ...base, reason: id === "claude"
      ? "No active Claude subscription account. Claude API credits do not serve Nous."
      : accounts.some((account) => account.provider === provider) ? `Its Space Gateway accounts are paused or out of quota.`
      : `No active ${name} account in Space Gateway. Add one under Space Gateway → Accounts.` };
    try {
      const models = (await modelsFor(id as SupportedProvider)).filter((model) => antigravityClaude || id !== "gemini" || model.id.startsWith("gemini-"));
      return models.length ? { ...base, models, available: true, reason: null }
        : { ...base, reason: "The provider did not advertise a supported Nous model." };
    } catch {
      return { ...base, reason: "The provider model catalog is unavailable." };
    }
  }

  /** The soonest reset among a pool's accounts, when they have one in the future (only a known time, never a guess). */
  function poolReset(accounts: CatalogAccount[], gateway: string): string | null {
    const at = accounts.filter((account) => account.provider === gateway).flatMap((account) => [account.primaryWindow?.resetAt, account.secondaryWindow?.resetAt])
      .map((value) => Date.parse(value ?? "")).filter((value) => Number.isFinite(value) && value > now()).sort((a, b) => a - b)[0];
    return at === undefined ? null : new Date(at).toISOString();
  }

  /** The Space provider's routes in the Gateway's order, each with its own models (unprefixed), availability and reason. */
  async function routes(state?: Awaited<ReturnType<typeof accountState>>): Promise<SpaceRoute[]> {
    const accounts = state ?? await accountState();
    const order = await (options.providerOrder?.() ?? Promise.resolve(GATEWAY_DEFAULT_PROVIDER_ORDER)).catch(() => GATEWAY_DEFAULT_PROVIDER_ORDER);
    return Promise.all(order.flatMap(({ route, enabled }) => {
      const own = ROUTE_PROVIDER[route as keyof typeof ROUTE_PROVIDER];
      const meta = NOUS_SPACE_ROUTES[route as keyof typeof NOUS_SPACE_ROUTES];
      return own && meta && meta.provider ? [{ route: route as GatewayProviderRoute, enabled, own, provider: meta.provider, meta }] : [];
    }).map(async ({ route, enabled, own, provider, meta }) => {
      const base = { route, name: meta.name, runtime: meta.runtime, prefix: meta.prefix, provider, enabled };
      let option: Pick<NousProviderOption, "available" | "reason" | "models">;
      if (route === "CLAUDE_OPENCODE") {
        // Operator decision 8/11: Nous never spends the Claude API budget; the Gateway also refuses the key to Nous projects (isClaudeCodeRequest).
        option = { available: false, reason: "Off for Nous: the Claude API budget is never spent by Nous (operator decision 8/11).", models: [] };
      } else {
        option = await providerOption(PROVIDERS.find((item) => item.id === own)!, accounts, true);
        if (route === "ANTIGRAVITY") {
          const argon = option.models.filter((m) => m.id.includes("argon"));
          option = { ...option, models: argon, available: option.available && argon.length > 0,
            reason: argon.length ? option.reason : "No Argon model in provider catalog." };
        } else if (route === "ANTIGRAVITY_FLASH") {
          const flash = option.models.filter((m) => m.id.startsWith("gemini-") && !m.id.includes("argon"));
          option = { ...option, models: flash, available: option.available && flash.length > 0,
            reason: flash.length ? option.reason : "No 3.8 Flash model in provider catalog." };
        } else if (route === "ANTIGRAVITY_CLAUDE") {
          const claude = option.models.filter((m) => m.id.startsWith("claude-"));
          option = { ...option, models: claude, available: option.available && claude.length > 0,
            reason: claude.length ? option.reason : "No Claude model in the Antigravity catalog." };
        }
      }
      const pool = accounts.accounts.filter((account) => account.provider === NOUS_PROVIDER_GATEWAY[own]
        && (route !== "CLAUDE" || account.planType?.toLowerCase() !== "api"));
      const quota = route === "CLAUDE" || route === "CODEX" ? {
        ready: pool.some((account) => quotaState(account).ready),
        // Include effective readiness so crossing a cached reset changes the evidence without fetching upstream.
        key: JSON.stringify(pool.map((account) => [account.id, account.status, account.primaryWindow, account.secondaryWindow, quotaState(account)]).sort())
      } : undefined;
      const cool = options.cooling?.(route);
      const resetAt = cool?.until ?? (route === "CLAUDE_OPENCODE" ? null : poolReset(accounts.accounts, NOUS_PROVIDER_GATEWAY[own]));
      return { ...base, ...option, name: meta.name, quota, reason: option.available && cool ? `Cooling down after a refusal: ${cool.reason.slice(0, 200)}` : option.reason, resetAt: option.available && !cool ? null : resetAt };
    })).then((own) => {
      // The free and granted pools (nous_msg:d9b67550), each with its one tool-taking model, in the Gateway's order after the routes above.
      const free = order.flatMap(({ route, enabled }): SpaceRoute[] => {
        const model = NOUS_FREE_ROUTE_MODELS[route];
        if (!model || options.publicCredentialHost) return [];
        const meta = NOUS_SPACE_ROUTES[route];
        const serving = accounts.accounts.some((account) => account.provider === nousFreeRouteProvider(route) && (account.status === "ACTIVE" || account.status === "RATE_LIMITED"));
        const cool = options.cooling?.(route);
        return [{ route, name: meta.name, runtime: "OpenCode (free pool)", prefix: meta.prefix, provider: "opencode", enabled, free: true,
          available: serving && accounts.accountsAvailable, models: serving ? [{ id: model, label: model, efforts: OPENCODE_EFFORTS }] : [],
          reason: !accounts.accountsAvailable ? "The active provider accounts could not be checked." : !serving ? "No active account of this pool in Space Gateway."
            : cool ? `Cooling down after a refusal: ${cool.reason.slice(0, 200)}` : null, resetAt: cool?.until ?? null }];
      });
      const at = (route: GatewayProviderRoute) => order.findIndex((entry) => entry.route === route);
      return [...own, ...free].sort((left, right) => at(left.route) - at(right.route));
    });
  }

  async function spaceOption(state: Awaited<ReturnType<typeof accountState>>): Promise<NousProviderOption> {
    const all = await routes(state);
    const usable = all.filter((route) => route.available);
    const auto = all.some((route) => route.enabled && route.available)
      ? Object.entries(NOUS_SPACE_AUTO).map(([id, entry]) => ({ id, label: entry.label, efforts: ["auto", "low", "medium", "high", "xhigh", "max"] })) : [];
    const models = [...auto, ...usable.flatMap((route) => route.models.map((model) => ({ id: `${route.prefix}:${model.id}`, label: `${model.label} · ${route.name}`, efforts: model.efforts })))];
    return { id: "space", name: NOUS_PROVIDER_NAMES.space, available: models.length > 0, models,
      reason: models.length ? null : options.publicCredentialHost ? "This installation's credential container does not support this Nous provider yet."
        : `No Space Gateway route can serve now: ${all.map((route) => `${route.name}: ${route.reason ?? "off"}`).join("; ")}`,
      routes: all.map(({ route, name, runtime, enabled, available, reason, resetAt }) => ({ route, name, runtime, enabled, available, reason, resetAt: resetAt ?? null })) };
  }

  async function list(): Promise<NousProviderOption[]> {
    const state = await accountState();
    return Promise.all(PROVIDERS.map((provider) => provider.id === "space" ? spaceOption(state) : providerOption(provider, state)));
  }

  async function validate(choice: { provider: string; model: string; effort: string }): Promise<void> {
    // A slow unrelated model catalog must never delay an otherwise valid turn.
    const definition = PROVIDERS.find((item) => item.id === choice.provider);
    const provider = !definition ? undefined : definition.id === "space" ? await spaceOption(await accountState()) : await providerOption(definition, await accountState());
    const reject = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
    if (!provider?.available) reject(provider?.reason ?? "This Nous provider is not available.");
    const model = provider!.models.find((item) => item.id === choice.model);
    if (!model) reject("The selected model is not available from this Nous provider.");
    const effort = (model!.efforts.length === 1 && model!.efforts[0] === "none") ? "none" : choice.effort;
    if (!model!.efforts.includes(effort)) reject("The selected reasoning effort is not supported by this Nous model.");
  }

  return { list, validate, routes: () => routes() };
}
