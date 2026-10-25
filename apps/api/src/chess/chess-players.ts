import { readFile } from "node:fs/promises";
import { CODEX_LB_BASE_URL, codexAuthHeaders, getCodexApiKey } from "../benchmark-routes.js";
import { loadOpenRouterBenchmarkModels, requestOpenRouterDoctrine } from "../openrouter-benchmark-models.js";
import { nativeOpenCodeModelCatalog } from "../task-title-opencode.js";
import {
  CHESS_CLI_PROVIDERS,
  CLI_PROVIDER_IDS,
  cliModelEfforts,
  currentOpenCodeBinary,
  parseCliModelCatalog,
  type CliMoveRunner,
  type ChessCliModel,
  type ChessCliProviderSpec,
} from "./chess-cli.js";

/**
 * Chess contestants are model x reasoning level pairs taken from the live
 * catalogs of every SpaceApp provider with a one-shot move path: Space Gateway
 * (every supported reasoning level), the CLI runtimes with an agent-chat mode
 * (Claude Code, Gemini, DeepSeek, GitHub Copilot, Grok, Cursor, Qwen, Hermes,
 * Kimi, Autohand, OpenCode; see chess-cli.ts) and OpenRouter.
 */

export type ChessProviderId = string;

export interface ChessContestant {
  /** `${modelId}@${reasoningEffort}` */
  id: string;
  modelId: string;
  providerId: ChessProviderId;
  modelName: string;
  /** Provider reasoning level, or "default" when the provider decides. */
  reasoningEffort: string;
  displayName: string;
}

export interface ChessProviderSummary {
  id: ChessProviderId;
  name: string;
  available: boolean;
  count: number;
  /** Moves this provider is asked for at the same time. */
  requestLimit: number;
  note?: string;
  /** Result of the last provider check (one real move), if any. */
  check?: ChessProviderCheck;
}

export interface ChessProviderCheck {
  ok: boolean;
  latencyMs: number;
  contestantId: string;
  error: string | null;
  checkedAt: string;
}

export interface ChessContestantCatalog {
  contestants: ChessContestant[];
  providers: ChessProviderSummary[];
  generatedAt: string;
}

export interface ChessMoveRequest {
  contestant: ChessContestant;
  system: string;
  prompt: string;
  signal: AbortSignal;
}

export interface ChessMoveReply {
  text: string;
  tokens?: number;
}

export type ChessMoveRequester = (request: ChessMoveRequest) => Promise<ChessMoveReply>;

/**
 * Requests in flight per provider. The shared Codex pool answers a burst
 * quickly and then queues or returns 503 (measured 2026-10-12: 6 parallel
 * requests went from 3 s to 10-60 s); free OpenRouter and OpenCode models
 * rate-limit sooner. Games beyond the limit wait before their move clock starts.
 */
export const PROVIDER_REQUEST_LIMITS: Record<string, number> = {
  codex: 4,
  openrouter: 2,
  ...Object.fromEntries(CHESS_CLI_PROVIDERS.map((provider) => [provider.id, 2])),
};

/**
 * Every CLI move starts a CLI process (startup 2-10 s plus the model);
 * this caps how many run at once across all CLI providers.
 */
export const CLI_CONCURRENCY_LIMIT = 6;
export const CLI_SLOT_GROUP = "cli";

export function isCliProvider(providerId: string): boolean {
  return CLI_PROVIDER_IDS.has(providerId);
}

const CODEX_MODELS_CACHE_FILE = "/var/lib/spaceapp-user/.codex/models_cache.json";
const CATALOG_CACHE_MS = 60_000;
const CONTESTANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}@[A-Za-z0-9._-]{1,40}$/;
const REASONING_ORDER = ["default", "auto", "disabled", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function isChessContestantId(value: unknown): value is string {
  return typeof value === "string" && CONTESTANT_ID_PATTERN.test(value);
}

export function reasoningRank(effort: string): number {
  const index = REASONING_ORDER.indexOf(effort);
  return index < 0 ? REASONING_ORDER.length : index;
}

/** Output budget per move: reasoning tokens count against it on every provider. */
export function moveTokenBudget(effort: string): number {
  switch (effort) {
    case "medium":
      return 2_000;
    case "high":
      return 4_000;
    case "xhigh":
      return 8_000;
    case "max":
    case "ultra":
      return 16_000;
    default:
      return 800;
  }
}

function contestant(
  providerId: ChessProviderId,
  modelId: string,
  modelName: string,
  reasoningEffort: string
): ChessContestant {
  return {
    id: `${modelId}@${reasoningEffort}`,
    modelId,
    providerId,
    modelName,
    reasoningEffort,
    displayName: reasoningEffort === "default" ? modelName : `${modelName} · ${reasoningEffort}`,
  };
}

interface CodexCatalogModel {
  slug?: unknown;
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  visibility?: unknown;
  supported_reasoning_levels?: unknown;
}

export function codexContestantsFromCatalog(payload: unknown): ChessContestant[] {
  const record = payload as { data?: unknown; models?: unknown } | unknown[] | null;
  const list = (Array.isArray(record) ? record : (record?.models ?? record?.data ?? [])) as CodexCatalogModel[];
  if (!Array.isArray(list)) return [];
  return list.flatMap((model) => {
    const rawId = String(model?.slug ?? model?.id ?? "").trim();
    if (!rawId || model?.visibility === "hide" || !/^[A-Za-z0-9._-]{1,120}$/.test(rawId)) return [];
    const name = String(model.display_name ?? model.name ?? rawId).trim() || rawId;
    const levels = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
      .map((level) => String((level as { effort?: unknown })?.effort ?? level ?? "").trim())
      .filter((level) => /^[a-z]{2,20}$/.test(level));
    const efforts = levels.length > 0 ? [...new Set(levels)] : ["default"];
    return efforts.map((effort) => contestant("codex", `codex/${rawId}`, name, effort));
  });
}

async function loadCodexContestants(): Promise<ChessContestant[]> {
  try {
    const response = await fetch(`${CODEX_LB_BASE_URL}/v1/models`, { signal: AbortSignal.timeout(2_500), headers: await codexAuthHeaders() });
    if (response.ok) {
      const contestants = codexContestantsFromCatalog(await response.json());
      if (contestants.length > 0) return contestants;
    }
  } catch {}
  try {
    return codexContestantsFromCatalog(JSON.parse(await readFile(CODEX_MODELS_CACHE_FILE, "utf8")));
  } catch {
    return [];
  }
}

async function loadOpenRouterContestants(): Promise<ChessContestant[]> {
  const models = await loadOpenRouterBenchmarkModels().catch(() => []);
  return models
    .filter((model) => model.id !== "openrouter/typesafe/jev-1.13")
    .map((model) => contestant("openrouter", model.id, model.displayName, "default"));
}

/** Readiness and catalogs of the SpaceApp CLI runtimes, shared with Chat panes (app.ts). */
export interface ChessCliBridge {
  /** Raw `models` TSV of a CLI runtime (cached and persisted by the caller). */
  listModels(runtimeId: string): Promise<string>;
  /** Whether the runtime can take a turn now: adapter enabled, signed in, quota left. */
  state(runtimeId: string): Promise<{ enabled: boolean; reason: string | null }>;
}

async function openCodeFreeModels(): Promise<ChessCliModel[]> {
  const command = await currentOpenCodeBinary();
  if (!command) throw new Error("OpenCode runtime not found.");
  const catalog = await nativeOpenCodeModelCatalog(command);
  const models = catalog.providers.find((provider) => provider.id === "opencode")?.models ?? {};
  return Object.entries(models)
    .filter(([id, raw]) => {
      const model = raw as { cost?: { input?: number; output?: number }; status?: string };
      return (
        /^[A-Za-z0-9._-]{1,120}$/.test(id) &&
        model.cost?.input === 0 &&
        model.cost?.output === 0 &&
        !model.status?.toLowerCase().includes("deprecated")
      );
    })
    .map(([id]) => ({ id: `opencode/${id}`, name: id, efforts: [] }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function cliContestants(spec: ChessCliProviderSpec, models: ChessCliModel[]): ChessContestant[] {
  const excluded = spec.excludeModelPrefixes ?? [];
  const included = spec.includeModelPrefixes;
  const own = (model: ChessCliModel) =>
    !excluded.some((prefix) => model.id.startsWith(prefix)) && (!included || included.some((prefix) => model.id.startsWith(prefix)));
  return models.filter(own).flatMap((model) => {
    const modelId = spec.catalog === "opencode" ? model.id : `${spec.id}/${model.id}`;
    return cliModelEfforts(spec, model).map((effort) => contestant(spec.id, modelId, model.name, effort));
  });
}

/** The model id a CLI wrapper expects: OpenCode takes `opencode/<id>`, the others their own ids. */
export function cliModelArgument(player: ChessContestant): string {
  return player.providerId === "opencode" ? player.modelId : player.modelId.slice(player.providerId.length + 1);
}

const CLI_CATALOG_DEADLINE_MS = 8_000;
const LAST_GOOD_CATALOG_DIR = "/opt/spaceapp/var";

/** The catalog the CLI models executor last saved (`<key>-models.last-good.json`), if any. */
async function lastGoodCliCatalog(providerId: string, directory: string): Promise<string | null> {
  try {
    const saved = JSON.parse(await readFile(`${directory}/${providerId}-models.last-good.json`, "utf8")) as { models?: unknown };
    return typeof saved.models === "string" && saved.models.trim() ? saved.models : null;
  } catch {
    return null;
  }
}

/**
 * A cold catalog starts the CLI itself (Cursor, Oh My Pi and Hermes take tens of seconds):
 * past the deadline the page gets the last saved catalog while the live one keeps loading.
 */
async function cliCatalogText(
  spec: ChessCliProviderSpec,
  bridge: ChessCliBridge,
  options: { deadlineMs: number; lastGoodDirectory: string }
): Promise<string> {
  const live = bridge.listModels(spec.runtimeId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options.deadlineMs);
  });
  const first = await Promise.race([live.catch(() => null), deadline]);
  clearTimeout(timer);
  if (first) return first;
  return (await lastGoodCliCatalog(spec.id, options.lastGoodDirectory)) ?? live;
}

async function loadCliProvider(
  spec: ChessCliProviderSpec,
  bridge: ChessCliBridge,
  options: { deadlineMs: number; lastGoodDirectory: string }
): Promise<{ summary: ChessProviderSummary; contestants: ChessContestant[] }> {
  const base = { id: spec.id, name: spec.name, requestLimit: PROVIDER_REQUEST_LIMITS[spec.id] ?? 2 };
  const state = await bridge.state(spec.runtimeId).catch(() => ({ enabled: false, reason: "Runtime state is unavailable." }));
  if (!state.enabled) {
    return { summary: { ...base, available: false, count: 0, note: (state.reason ?? "Not available").slice(0, 120) }, contestants: [] };
  }
  try {
    const models = spec.catalog === "opencode" ? await openCodeFreeModels() : parseCliModelCatalog(await cliCatalogText(spec, bridge, options));
    const contestants = cliContestants(spec, models);
    return {
      summary: { ...base, available: contestants.length > 0, count: contestants.length, ...(contestants.length ? {} : { note: "No models" }) },
      contestants,
    };
  } catch (error) {
    const note = error instanceof Error ? error.message.replace(/[^\x20-\x7E]/g, " ").slice(0, 120) : "Model catalog unavailable";
    return { summary: { ...base, available: false, count: 0, note }, contestants: [] };
  }
}

export interface ChessCatalogOptions {
  cli?: ChessCliBridge;
  /** How long a CLI catalog may take before the last saved one is used (tests shorten it). */
  cliCatalogDeadlineMs?: number;
  lastGoodDirectory?: string;
  /** Test seams for the HTTP catalogs. */
  loadCodex?: () => Promise<ChessContestant[]>;
  loadOpenRouter?: () => Promise<ChessContestant[]>;
}

export function createChessCatalog(options: ChessCatalogOptions = {}): (request?: { fresh?: boolean }) => Promise<ChessContestantCatalog> {
  let cache: { expiresAt: number; value: Promise<ChessContestantCatalog> } | null = null;
  return (request = {}) => {
    const now = Date.now();
    if (!request.fresh && cache && cache.expiresAt > now) return cache.value;
    const value = (async () => {
      const cli = options.cli;
      const [codex, openRouter, cliProviders] = await Promise.all([
        (options.loadCodex ?? loadCodexContestants)(),
        (options.loadOpenRouter ?? loadOpenRouterContestants)(),
        cli
          ? Promise.all(
              CHESS_CLI_PROVIDERS.map((spec) =>
                loadCliProvider(spec, cli, {
                  deadlineMs: options.cliCatalogDeadlineMs ?? CLI_CATALOG_DEADLINE_MS,
                  lastGoodDirectory: options.lastGoodDirectory ?? LAST_GOOD_CATALOG_DIR,
                })
              )
            )
          : Promise.resolve([]),
      ]);
      return {
        contestants: [...codex, ...cliProviders.flatMap((provider) => provider.contestants), ...openRouter],
        providers: [
          { id: "codex", name: "Codex", available: codex.length > 0, count: codex.length, requestLimit: PROVIDER_REQUEST_LIMITS.codex! },
          ...cliProviders.map((provider) => provider.summary),
          {
            id: "openrouter",
            name: "OpenRouter",
            available: openRouter.length > 0,
            count: openRouter.length,
            requestLimit: PROVIDER_REQUEST_LIMITS.openrouter!,
          },
        ],
        generatedAt: new Date().toISOString(),
      } satisfies ChessContestantCatalog;
    })();
    cache = { expiresAt: now + CATALOG_CACHE_MS, value };
    value.catch(() => {
      cache = null;
    });
    return value;
  };
}

async function requestCodexMove(request: ChessMoveRequest): Promise<ChessMoveReply> {
  const apiKey = await getCodexApiKey();
  if (!apiKey) throw new Error("The Space Gateway key is unavailable.");
  const { contestant: player } = request;
  const response = await fetch(`${CODEX_LB_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: request.signal,
    body: JSON.stringify({
      model: player.modelId.slice("codex/".length),
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
      ...(player.reasoningEffort === "default" ? {} : { reasoning_effort: player.reasoningEffort }),
      max_tokens: moveTokenBudget(player.reasoningEffort),
    }),
  });
  if (!response.ok) throw new Error(`Space Gateway HTTP ${response.status}`);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { total_tokens?: unknown };
  };
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("Space Gateway returned no text.");
  const tokens = Number(payload.usage?.total_tokens);
  return { text, ...(Number.isFinite(tokens) ? { tokens } : {}) };
}

async function requestOpenRouterMove(request: ChessMoveRequest): Promise<ChessMoveReply> {
  const text = await requestOpenRouterDoctrine({
    modelId: request.contestant.modelId.slice("openrouter/".length),
    system: request.system,
    prompt: request.prompt,
    timeoutMs: 120_000,
    maxTokens: moveTokenBudget(request.contestant.reasoningEffort),
    title: "Space Chess AI Benchmark",
    signal: request.signal,
  });
  if (typeof text !== "string") throw new Error("OpenRouter returned no move.");
  return { text };
}

export interface ChessMoveRequesterOptions {
  /** Claude account profile with the most quota left, or null for the main account. */
  claudeProfile?: () => Promise<string | null>;
  /** Runs a CLI move in the worker; without it CLI providers cannot play. */
  runCliMove?: CliMoveRunner;
}

/** Signed-in Claude account with the most quota left (min of 5 h and weekly), as T3 Code chooses. */
export function pickClaudeProfile(
  accounts: Array<{ id: string; status: string; fiveHourRemainingPercent: number | null; weeklyRemainingPercent: number | null }>
): string | null {
  const best = accounts
    .filter((account) => account.status === "CONNECTED")
    .map((account) => ({ id: account.id, left: Math.min(account.fiveHourRemainingPercent ?? 0, account.weeklyRemainingPercent ?? 0) }))
    .filter((account) => account.left > 0)
    .sort((left, right) => right.left - left.left)[0];
  return best && best.id !== "main" ? best.id : null;
}

export function createChessMoveRequester(options: ChessMoveRequesterOptions = {}): ChessMoveRequester {
  const requestCliMove = async (request: ChessMoveRequest): Promise<ChessMoveReply> => {
    const spec = CHESS_CLI_PROVIDERS.find((provider) => provider.id === request.contestant.providerId)!;
    const effort = request.contestant.reasoningEffort;
    if (!options.runCliMove) throw new Error("CLI moves need the Space worker.");
    const claudeProfile = spec.id === "claude" && options.claudeProfile ? await options.claudeProfile().catch(() => null) : null;
    const text = await options.runCliMove({
      runtimeId: spec.runtimeId,
      model: cliModelArgument(request.contestant),
      effort: effort === "default" ? null : effort,
      claudeProfile,
      // agent-chat has no system channel: the instructions lead the prompt.
      prompt: `${request.system}\n\n${request.prompt}`,
      signal: request.signal,
    });
    return { text };
  };
  return (request) => {
    const providerId = request.contestant.providerId;
    if (providerId === "codex") return requestCodexMove(request);
    if (providerId === "openrouter") return requestOpenRouterMove(request);
    if (isCliProvider(providerId)) return requestCliMove(request);
    return Promise.reject(new Error("Unsupported chess provider."));
  };
}

export const requestChessMove: ChessMoveRequester = createChessMoveRequester();
