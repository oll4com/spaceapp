import { z } from "zod";
import { nousPaneBoardSettingsSchema } from "./nous-pane-board.js";
import { planWaitsOnKindSchema } from "./plan-map.js";
import { nousGoalsSettingsSchema } from "./nous-goals.js";
import { groupPatchSchema, patchSchema } from "./partial-update.js";
import { orderedRange } from "./range-rules.js";
import type { GatewayProviderRoute } from "./gateway.js";

/** Nous reads the owner's saved provider, model and effort for every turn (operator request 2026-10-29). */
export const NOUS_MODEL_ID = "gpt-6-astra";
export const NOUS_EFFORT = "high";
/**
 * Technical bound on a Nous turn's system text (persona and shell note), checked by the worker and both runners: Claude Code takes it as
 * one --append-system-prompt argument and Linux caps one argument at 131,072 bytes (Greek takes two a character). Stable 31/10 13:10 UTC:
 * the persona grew past the old 20,000 and every turn failed "Invalid system prompt."
 */
export const NOUS_SYSTEM_MAX_CHARS = 60_000;
/**
 * Technical bound on a Nous turn's prompt (model context), checked by the worker: Claude's 200,000-token window less the persona and
 * tool schemas (about 30,000 tokens) must leave the larger half to the turn's tool answers, so the prompt gets about 50,000 tokens:
 * 150,000 characters (English about 4 a token, Greek about 2). The API first selects named sections whole within this bound
 * (NOUS_PROMPT_BUDGET_CHARS, retrieval.ts), then fits what can never leave to it at line boundaries (prompt-budget.ts), every cut named
 * with how to read the rest. The worker and every runner (space-codex-, space-chat-, space-gemini-nous-turn.mjs) check the same number. Stable 1/11: 34 operator turns failed "Invalid prompt." at 05:45-07:33 UTC, then 59 of 68 at 09:33-10:00 UTC
 * past the old 400,000 bound; the day before cost $1,124 over 569 turns on that size.
 */
export const NOUS_PROMPT_MAX_CHARS = 150_000;
// "space" (operator 3/11 15:03 BKK, plan clipboard:52W5YTibb65k): every Space Gateway provider in one, in the Gateway's provider order.
export const NOUS_PROVIDERS = ["space", "codex", "claude", "gemini"] as const;
export type NousProvider = typeof NOUS_PROVIDERS[number];
/** What a worker turn runs on: a single provider, or "opencode" (Claude on the API-key account, run by OpenCode). */
export type NousRunProvider = Exclude<NousProvider, "space"> | "opencode";
/** The Space Gateway pool each Nous provider runs on; every Nous turn goes through Space Gateway ("SPACE": all of them, by the order). */
export const NOUS_PROVIDER_GATEWAY: Record<NousProvider, string> = {
  space: "SPACE", codex: "CODEX", claude: "CLAUDE", gemini: "ANTIGRAVITY"
};
export const NOUS_PROVIDER_NAMES: Record<NousProvider, string> = {
  space: "Space (all providers)", codex: "Codex (OpenAI)", claude: "Claude (Anthropic)", gemini: "Gemini (Antigravity)"
};
/**
 * The Space provider's routes: the prefix of their namespaced model ids ("codex:gpt-6-astra"; a colon,
 * as provider ids such as OpenRouter's carry slashes), the provider and runtime that run them.
 * A namespaced model is explicit: it runs on its route only and an exhausted route is reported, never silently replaced. The "auto" models
 * follow the Gateway's provider order and say which route served the turn.
 */
/** `provider` null: a Space Gateway route Nous has no runner for (the free key pools); Nous's Space provider leaves it out. */
export const NOUS_SPACE_ROUTES: Record<GatewayProviderRoute, { prefix: string; provider: NousRunProvider | null; name: string; runtime: string }> = {
  CLAUDE: { prefix: "claude", provider: "claude", name: "Claude", runtime: "Claude Code" },
  CODEX: { prefix: "codex", provider: "codex", name: "Codex", runtime: "Codex" },
  CLAUDE_OPENCODE: { prefix: "opencode-claude", provider: "opencode", name: "Claude via OpenCode", runtime: "OpenCode" },
  ANTIGRAVITY: { prefix: "gemini", provider: "gemini", name: "Gemini Argon (Antigravity)", runtime: "Gemini (native)" },
  ANTIGRAVITY_FLASH: { prefix: "gemini-flash", provider: "gemini", name: "Gemini 3.8 Flash (Antigravity)", runtime: "Gemini (native)" },
  // The Claude models Antigravity serves (its "Claude · GPT" quota group), run by the same native Gemini runner (operator 8/11).
  ANTIGRAVITY_CLAUDE: { prefix: "antigravity-claude", provider: "gemini", name: "Claude (Antigravity)", runtime: "Gemini (native)" },
  BEDROCK: { prefix: "bedrock", provider: null, name: "Claude on Amazon Bedrock (AWS credits)", runtime: "Space Gateway only" },
  VERTEX: { prefix: "vertex", provider: null, name: "Claude on Google Vertex AI (Google Cloud credits)", runtime: "Space Gateway only" }
};
/**
 * Free-pool routes for Nous (operator 8/11: all free pools and pay-per-token pools removed from Space routes).
 */
export const NOUS_FREE_ROUTE_MODELS: Partial<Record<GatewayProviderRoute, string>> = {};
/** The Space Gateway account provider behind a free route (OpenRouter's free models are its one key pool). */
export const nousFreeRouteProvider = (route: GatewayProviderRoute): string => route;
/** Auto models of the Space provider and the tier each asks every route for (3: Opus/Astra class, 2: Sonnet/Sol class, 1: Haiku/Luna class). */
export const NOUS_SPACE_AUTO: Record<string, { tier: 1 | 2 | 3; label: string }> = {
  auto: { tier: 3, label: "Auto: best model, Gateway order" },
  "auto-balanced": { tier: 2, label: "Auto: balanced model, Gateway order" },
  "auto-light": { tier: 1, label: "Auto: light model, Gateway order" }
};
/** A Space model id read: an auto tier, or a route and that route's own model id; null for anything else. */
export function nousSpaceModel(model: string): { auto: 1 | 2 | 3 } | { route: GatewayProviderRoute; model: string } | null {
  const auto = NOUS_SPACE_AUTO[model];
  if (auto) return { auto: auto.tier };
  const colon = model.indexOf(":");
  if (colon < 0 || colon >= model.length - 1) return null;
  const prefix = model.slice(0, colon);
  const target = model.slice(colon + 1);
  if (prefix === "gemini" && /flash/i.test(target)) {
    return { route: "ANTIGRAVITY_FLASH", model: target };
  }
  const route = (Object.keys(NOUS_SPACE_ROUTES) as GatewayProviderRoute[]).find((key) => NOUS_SPACE_ROUTES[key].prefix === prefix);
  return route ? { route, model: target } : null;
}
/** Model class: 3 Opus/Fable/Astra/Argon, 1 Haiku/Luna/Flash-low and other light models, 2 the rest (Nous's Space provider and Gateway /pools/space). */
export function nousModelTier(model: string): 1 | 2 | 3 {
  if (/opus|fable|astra|argon/i.test(model)) return 3;
  // "mini" only as its own part of the id: "gemini" holds it too.
  if (/haiku|luna|flash-low|(?:^|[-_/])(?:mini|nano|lite)(?:$|[-_.:])|[:/]free\b/i.test(model)) return 1;
  return 2;
}
// Antigravity's Claude ids carry their effort (claude-opus-5-5-high): the top class takes high, the others Sonnet medium.
const SPACE_PREFERRED = ["claude-opus-5-5", "gpt-6-astra", "gemini-4-argon-high", "claude-opus-5-5-high", "claude-sonnet-5-5", "gpt-6.1-sol", "gemini-4-argon", "claude-sonnet-5-5-medium",
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "claude-haiku-5-5", "gpt-6-luna", "gemini-3.8-flash-low"];
/** A route's model for a class: the same class first, else the nearest below, else the nearest above; the known flagship of a class first. */
export function nousRouteModel<T extends { id: string }>(models: T[], tier: 1 | 2 | 3): T | null {
  const rank = (model: T) => {
    const own = nousModelTier(model.id);
    const preferred = SPACE_PREFERRED.indexOf(model.id);
    return [Math.abs(own - tier) * 2 + (own > tier ? 1 : 0), preferred < 0 ? SPACE_PREFERRED.length : preferred];
  };
  return [...models].sort((a, b) => { const [x, y] = [rank(a), rank(b)]; return x[0]! - y[0]! || x[1]! - y[1]!; })[0] ?? null;
}
/** API-key pools: no quota windows, billed per token by the provider. */
export const nousKeyPoolProvider = (provider?: string): boolean => Boolean(provider && false);
export const NOUS_CLAUDE_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const NOUS_CODEX_MODELS = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"] as const;
/** Known choices for defaults only; the live catalog supplies the selectable models. */
export const NOUS_MODELS = [...NOUS_CODEX_MODELS, ...NOUS_CLAUDE_MODELS] as const;
const nousModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/);
export interface NousProviderModel { id: string; label: string; efforts: string[] }
/** One route of the Space provider as Settings shows it: on or off in the Gateway's order, and why it cannot serve now. */
export interface NousSpaceRouteState { route: GatewayProviderRoute; name: string; runtime: string; enabled: boolean; available: boolean; reason: string | null;
  /** When an exhausted or cooling route is expected back, only when known. */
  resetAt?: string | null }
export interface NousProviderOption { id: string; name: string; available: boolean; reason: string | null; models: NousProviderModel[];
  /** The Space provider only: its routes in the Gateway's provider order. */
  routes?: NousSpaceRouteState[]; /** What the provider has left (Nous's provider advice), e.g. "62% left now, 54% at the weekly reset". */ room?: string;
  /** Subscription pools: the share free at the last weekly reset at this pace (the pickers' "54% free at Tue 10:00"); null: no current weekly window. */
  atReset?: { percent: number; resetAt: string; /** Codex weekly reset credits (quotaResetCredits). */ resetCredits?: { credits: number; accounts: number; weekPercent: number } } | null }
/** Old settings have no provider: their saved Claude model remains authoritative. */
export function nousProvider(settings: { provider?: NousProvider; models?: { operator?: { model: string } } }): NousProvider {
  return settings.provider ?? (settings.models?.operator ? nousModelProvider(settings.models.operator.model) : "codex");
}
export const nousModelProvider = (model: string): NousProvider => model.startsWith("claude-") ? "claude" : model.startsWith("gemini-") ? "gemini" : "codex";
export function isGeminiModel(model: string): boolean {
  if (model.startsWith("gemini-") || model.startsWith("gemini:") || model.startsWith("gemini-flash:")) return true;
  const parsed = nousSpaceModel(model);
  return Boolean(parsed && !("auto" in parsed) && NOUS_SPACE_ROUTES[parsed.route]?.provider === "gemini");
}
export function normalizeModelChoice(choice: NousModelChoice): NousModelChoice {
  return isGeminiModel(choice.model) ? { ...choice, effort: "none" } : choice;
}
export function normalizeCriticalModelChoice<T extends { model: string; effort: "low" | "medium" | "none" }>(choice: T): T {
  return isGeminiModel(choice.model) ? { ...choice, effort: "none" } : choice;
}
export function nousModelMatchesProvider(model: string, provider: NousProvider): boolean {
  if (provider === "space") {
    const parsed = nousSpaceModel(model);
    if (!parsed || "auto" in parsed) return parsed !== null;
    const runs = NOUS_SPACE_ROUTES[parsed.route].provider;
    if (!runs) return false;
    return runs === "opencode" || parsed.route === "ANTIGRAVITY_CLAUDE" ? parsed.model.startsWith("claude-") : nousModelMatchesProvider(parsed.model, runs);
  }
  return provider === "codex" ? /^(?:gpt-|o[1-9])/.test(model) : nousModelProvider(model) === provider;
}
export function nousCheaperModel(provider: NousProvider, critical = false): NousModelChoice {
  if (provider === "space") return { model: critical ? "auto-light" : "auto-balanced", effort: "medium" };
  if (provider === "claude") return { model: critical ? "claude-haiku-5-5" : "claude-sonnet-5-5", effort: "medium" };
  if (provider === "gemini") return { model: critical ? "gemini-3.8-flash-low" : "gemini-3.8-flash-medium", effort: "none" };
  return { model: critical ? "gpt-6-luna" : "gpt-6.1-sol", effort: "medium" };
}
export function nousModelLabel(model: string): string {
  const space = nousSpaceModel(model);
  if (space) return "auto" in space ? NOUS_SPACE_AUTO[model]!.label : `${baseModelLabel(space.model)} · ${NOUS_SPACE_ROUTES[space.route].name}`;
  return baseModelLabel(model);
}
function baseModelLabel(model: string): string {
  return model.startsWith("claude-") ? model.replace(/^claude-(\w)/, (_, first: string) => `Claude ${first.toUpperCase()}`).replace(/-(\d)-(\d)$/, " $1.$2")
    : model.replace(/^gpt-/, "GPT-").replace(/-(astra|sol|terra|luna)$/, (_, name: string) => ` ${name.charAt(0).toUpperCase()}${name.slice(1)}`);
}
/** "auto" (operator 8/11): each Space route picks the effort by its model's class (`nousAutoEffort`); last, so low-spend's "at most high" caps it. */
export const NOUS_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
/** Auto reasoning: Opus/Astra class xhigh (the operator's Opus 5.5 default, 2026-10-21), Sonnet/Sol high, Haiku/Luna medium. */
export const nousAutoEffort = (model: string): string => ({ 3: "xhigh", 2: "high", 1: "medium" } as const)[nousModelTier(model)];
export const nousModelChoiceSchema = z.object({
  model: nousModelIdSchema.default(NOUS_MODEL_ID),
  effort: z.enum(NOUS_EFFORTS).default(NOUS_EFFORT)
}).strict();
export type NousModelChoice = z.infer<typeof nousModelChoiceSchema>;
/** Why a turn runs: the operator wrote, the inbox, a decision answer, the Away round (HEARTBEAT), Space's standing orders, the daily self-review (REVIEW, 2026-10-24), or the goal loop (GOAL, 2026-10-27). */
/**
 * NOTHING_NEW is a background turn's signal to Space that it has nothing to tell; it is never text for the operator. Stable 2/11: 110 answers
 * began with it and one was only it, all shown in the operator's chat. An answer without it is posted; an answer that was only it is not.
 */
export const withoutNothingNew = (text: string): string => text.replace(/^[ \t*_`]*NOTHING_NEW[.!…*_` \t]*$/gm, "").trim();

export const NOUS_TURN_REASONS = ["OPERATOR", "INBOX", "DECISION", "HEARTBEAT", "STANDING", "REVIEW", "GOAL"] as const;
export const nousTurnReasonSchema = z.enum(NOUS_TURN_REASONS);
export type NousTurnReason = z.infer<typeof nousTurnReasonSchema>;
/** The turn kinds the operator sets a model for; HEARTBEAT (the Away round) runs as a standing turn; goal turns' "auto" runs the balanced class (operator 8/11, nousTokenModel). */
export const NOUS_TURN_KINDS = ["operator", "decision", "inbox", "standing", "helper", "goal"] as const;
export type NousTurnKind = typeof NOUS_TURN_KINDS[number];
/** Astra high for each normal turn kind (operator request 2026-10-29). */
export const NOUS_EFFORT_BY_KIND: Record<NousTurnKind, typeof NOUS_EFFORTS[number]> = { operator: "high", decision: "high", inbox: "high", standing: "high", helper: "high", goal: "high" };
export const nousDefaultModel = (kind: NousTurnKind): NousModelChoice => ({ model: NOUS_MODEL_ID, effort: NOUS_EFFORT_BY_KIND[kind] });
const choice = (kind: NousTurnKind) => nousModelChoiceSchema.default(() => nousDefaultModel(kind));
export const nousModelsSettingsSchema = z.object({
  operator: choice("operator"), decision: choice("decision"), inbox: choice("inbox"), standing: choice("standing"), helper: choice("helper"),
  /** The goal loop's turns (2026-10-27); "auto" runs the balanced class (operator 8/11), never downgraded further in low-spend mode. */
  goal: choice("goal")
}).strict();
export type NousModelsSettings = z.infer<typeof nousModelsSettingsSchema>;
/** The turn kind of a reason: HEARTBEAT (the Away round) and REVIEW (the daily self-review) run as standing turns. */
export function nousTurnKindOf(reason: NousTurnReason | "HELPER"): NousTurnKind {
  return reason === "OPERATOR" ? "operator" : reason === "DECISION" ? "decision" : reason === "INBOX" ? "inbox" : reason === "HELPER" ? "helper" : reason === "GOAL" ? "goal" : "standing";
}
/** The model and effort of a turn by its reason; without saved models (older settings, tests) the kind's default. */
export function nousModelFor(models: Partial<NousModelsSettings> | null | undefined, reason: NousTurnReason | "HELPER"): NousModelChoice {
  const kind = nousTurnKindOf(reason);
  return models?.[kind] ?? nousDefaultModel(kind);
}
export const nousSpendModeSchema = z.enum(["NORMAL", "LOW", "CRITICAL"]);
export type NousSpendMode = z.infer<typeof nousSpendModeSchema>;
export const NOUS_LOW_SPEND_KINDS = ["inbox", "standing", "helper"] as const;
export const nousLowSpendModel = (): NousModelChoice => ({ model: "claude-sonnet-5-5", effort: "medium" });
const lowChoice = nousModelChoiceSchema.default(nousLowSpendModel);
export const NOUS_CRITICAL_SPEND_EFFORTS = ["none", "low", "medium"] as const;
export const nousCriticalSpendModel = () => ({ model: "claude-haiku-5-5" as const, effort: "medium" as const });
const criticalChoice = z.object({
  model: nousModelIdSchema.default("claude-haiku-5-5"),
  effort: z.enum(NOUS_CRITICAL_SPEND_EFFORTS).default("medium")
}).strict().default(nousCriticalSpendModel);
/** The default Load target of every spend mode (the Load tab below; operator 31/10 17:22 BKK). */
export const NOUS_LOAD_TARGET = 90;
const loadTarget = z.number().int().min(0).max(100).default(NOUS_LOAD_TARGET);
export const nousLowSpendSettingsSchema = z.object({
  mode: z.enum(["AUTO", "ON", "OFF"]).default("AUTO"),
  /** Runtime-only automatic turn override, per kind and mode; normal models remain stored. */
  cheaperModel: z.boolean().default(true),
  minMaxAccountsWithRoom: z.number().int().min(1).max(100).default(2),
  roomRemainingPercent: z.number().min(1).max(100).default(10),
  lowBudgetRemainingPercent: z.number().min(0).max(100).default(40),
  criticalBudgetRemainingPercent: z.number().min(0).max(100).default(20),
  maxTurnsPerHour: z.number().int().min(1).max(120).default(6),
  models: z.object({ inbox: lowChoice, standing: lowChoice, helper: lowChoice }).strict().default(() => ({ inbox: nousLowSpendModel(), standing: nousLowSpendModel(), helper: nousLowSpendModel() })),
  criticalModels: z.object({ inbox: criticalChoice, standing: criticalChoice, helper: criticalChoice }).strict().default(() => ({ inbox: nousCriticalSpendModel(), standing: nousCriticalSpendModel(), helper: nousCriticalSpendModel() })),
  /** The Load target per spend mode (operator 13/11 07:30 BKK, nous_msg:de65e4c2, plan 20261113-nous-load-setting); 0 never pushes. */
  loadTargets: z.object({ NORMAL: loadTarget, LOW: loadTarget, CRITICAL: loadTarget }).strict()
    .default(() => ({ NORMAL: NOUS_LOAD_TARGET, LOW: NOUS_LOAD_TARGET, CRITICAL: NOUS_LOAD_TARGET }))
}).strict().refine(...orderedRange("criticalBudgetRemainingPercent", "lowBudgetRemainingPercent",
  { message: "The critical budget threshold must not exceed the low budget threshold.", path: ["criticalBudgetRemainingPercent"] }));
export type NousLowSpendSettings = z.infer<typeof nousLowSpendSettingsSchema>;
/** The fallback Claude Code moves a turn to when the main model is overloaded or unavailable; "none" by default (operator decision 2026-10-21). */
export const NOUS_FALLBACK_MODELS = ["none", ...NOUS_CLAUDE_MODELS] as const;
/**
 * Standing orders (operator orders 2026-10-21): Space itself, every tick, finds the finished CLI panes (done or idle this long,
 * nothing waiting on them) and the stalled plans, and brings them to Nous in a turn of their own until each one is handled.
 */
export const nousStandingOrdersSettingsSchema = z.object({
  closeFinishedPanes: z.boolean().default(true),
  /** The operator's own panes (OPERATOR_TEST) too, once their task is done (operator order 2026-10-24, on by default). */
  closeOperatorPanes: z.boolean().default(true),
  finishedAfterMinutes: z.number().int().min(5).max(720).default(30),
  stalledAfterHours: z.number().min(1).max(72).default(3),
  tickMinutes: z.number().int().min(2).max(60).default(10),
  /** The daily self-review turn (operator decision 2026-10-24, replacing the scheduled task in a pane): once a day at this hour in the operator's zone. */
  dailyReview: z.boolean().default(true),
  dailyReviewHour: z.number().int().min(0).max(23).default(3),
  /** R13-9 (goal ab5f85bd): the times of day (operator's zone) Space brings Nous the list of what waits for the operator; empty = off. */
  pendingsHours: z.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)).max(12).default(["09:50", "12:50", "15:50", "18:50", "21:50"])
}).strict();
export type NousStandingOrdersSettings = z.infer<typeof nousStandingOrdersSettingsSchema>;
/** How long one inbox message runs before a batch is split into several (a reading size, not a cap: nothing is cut, 31/10). */
export const NOUS_MESSAGE_MAX_CHARS = 20_000;
// No length cap on a stored message or the operator's own (operator 31/10 «Βγάλε όλα τα όρια»: until then 20,000 and 8,000);
// the API's request body limit is the technical bound.

const isoDateTime = z.string().datetime({ offset: true });
export const nousMessageIdSchema = z.string().regex(/^nous_msg:[A-Za-z0-9_-]{6,80}$/);
export const nousDecisionIdSchema = z.string().regex(/^nous_decision:[A-Za-z0-9_-]{6,80}$/);

/** OPERATOR: the operator wrote it; INBOX: what the monitor and the notifications brought; ANSWER: Nous's reply. */
export const nousMessageKindSchema = z.enum(["OPERATOR", "INBOX", "ANSWER", "TOOL", "DECISION", "ERROR"]);
export type NousMessageKind = z.infer<typeof nousMessageKindSchema>;
export const nousMessageStatusSchema = z.enum(["RUNNING", "DONE", "FAILED", "REFUSED"]);
export type NousMessageStatus = z.infer<typeof nousMessageStatusSchema>;

export const nousMessageSchema = z.object({
  id: nousMessageIdSchema,
  ownerUserId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(120).nullable(),
  kind: nousMessageKindSchema,
  status: nousMessageStatusSchema,
  content: z.string(),
  meta: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type NousMessage = z.infer<typeof nousMessageSchema>;

/**
 * How one of the operator's requests ended, as Nous reports it (space_nous_outcome): SELF with its own tools, HELPER when a
 * pane had to do it because Nous lacked a tool (`missing` names it), OPERATOR when it is the operator's decision, PENDING.
 */
export const nousRequestOutcomeSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  outcome: z.enum(["SELF", "HELPER", "OPERATOR", "PENDING"]),
  missing: z.string().trim().min(1).max(300).optional(),
  /** The operator said Nous was wrong or repeated a request Nous reported done (not a new request, a card answer or a repeat while pending). */
  correction: z.boolean().optional()
}).strict();
export type NousRequestOutcome = z.infer<typeof nousRequestOutcomeSchema>;
/**
 * A reported outcome as the turn's facts keep it (operator 31/10 09:55 BKK, plan clipboard:2NOOFNJDUIMO): the operator messages it
 * covers, written by the server from the id Nous gave or the messages the turn answered, its plan, and a question only answered.
 */
export const nousTurnOutcomeSchema = nousRequestOutcomeSchema.extend({
  messageIds: z.array(nousMessageIdSchema).max(20).optional(),
  plan: z.string().max(160).regex(/^clipboard:[A-Za-z0-9_-]+$/).optional(),
  answerOnly: z.boolean().optional()
}).strict();
export type NousTurnOutcome = z.infer<typeof nousTurnOutcomeSchema>;

/** The Requests tab: each operator message and how it ended (GET /api/nous/requests). */
// NOT_DONE (operator 6/11 nous_msg:2c610048 «an answer does NOT mean completion»): answered, but no Done record, no DROPPED close and not only a question.
export const nousRequestStatusSchema = z.enum(["DONE", "ANSWERED", "IN_PROGRESS", "WAITS_FOR_YOU", "NOT_DONE", "NOT_ANSWERED"]);
export type NousRequestStatus = z.infer<typeof nousRequestStatusSchema>;
export interface NousOperatorRequest {
  messageId: string; createdAt: string; text: string; status: NousRequestStatus;
  /** DONE: the Done record's summary, where it is live and its merge-queue tickets. */
  doneSummary?: string; where?: "stable" | "dev" | "no code"; tickets?: string[];
  /** The plan it is linked to and its progress. */
  planId?: string; planPercent?: number;
  /** The first answer of Nous that covered it, and its Done record's time and id (one record can cover several messages: a plan's). */
  answeredAt?: string; doneAt?: string; doneId?: string;
  /** The first reply that reached the chat for it: an operator turn's space_reply_now, else its answer (the Score's first answer). */
  repliedAt?: string;
  /** Of the time to its Done, how long it waited on the operator alone (their own test or answer): the Score leaves it out. */
  operatorWaitMs?: number;
}

/**
 * The Load tab (operator 31/10 13:58 BKK, plan clipboard:f4SH36t3fJ6c): the share of the server's capacity and of the token pools Nous and
 * its agents use now (GET /api/nous/load), its series over a range and its averages, whose goal is to rise toward the target
 * (90 % since operator 31/10 17:22 BKK: «θελω 90% τουλαχιστον»; per spend mode in `lowSpend.loadTargets` since 13/11).
 */
export const nousLoadRangeSchema = z.enum(["1h", "24h", "7d", "30d"]);
export type NousLoadRange = z.infer<typeof nousLoadRangeSchema>;
export type NousLoadPartKey = "cpu" | "memory" | "load" | "pressure" | "tokens" | "panes" | "helpers";
export interface NousLoadPart { key: NousLoadPartKey; label: string; percent: number | null; detail: string }
/** An average and the one of the period before it (the trend); null without samples. */
export interface NousLoadAverage { value: number | null; previous: number | null }
export interface NousLoad {
  /** The newest sample; null before the first one. */
  at: string | null; overall: number | null; target: number;
  /** The spend mode whose Load target is in force (Settings → Nous → Low-spend mode). */
  targetMode?: NousSpendMode | null;
  level: "CALM" | "BUSY" | "OVERLOADED" | null;
  /** The hard limit that holds the overall at 100 (OVERLOADED, Nous's pool with no room). */
  limit: string | null;
  /** The physical host's swap as its source reads it, with the reading's age ("pve swap 44.13% (12 s old)"); the parts are this VM's. */
  host?: string | null;
  parts: NousLoadPart[];
  range: NousLoadRange;
  series: Array<{ at: string; value: number }>;
  averages: { hour: NousLoadAverage; today: NousLoadAverage; week: NousLoadAverage; month: NousLoadAverage; bestDay: { day: string; value: number } | null };
}

/**
 * Score (operator 3/11 23:11 BKK, plan clipboard:1NF6u6gcCwtj): Nous's performance as points that can go negative; open plans and operator
 * requests cost points while they stay open, finished work and the scorecard give them. GET /api/nous/score and /api/nous/score/history.
 */
export const nousScoreRangeSchema = z.enum(["24h", "7d", "30d"]);
export type NousScoreRange = z.infer<typeof nousScoreRangeSchema>;
export type NousScoreTileKey = "plans" | "panes" | "goals" | "projects" | "dailyTasks" | "response" | "dailyErrors" | "requests" | "completed" | "done" | "utilization"
  | "corrections" | "couldHaveDecided" | "scorecard" | "marketing" | "lostTokens" | "browsers" | "idlePanes" | "approvedNotDone" | "parked" | "reset";
/** One thing that gives or costs points (a plan, a request, a dimension); `id` is a plan, message or decision id when there is one. */
export interface NousScoreItem { id: string | null; label: string; points: number; detail: string }
export interface NousScoreTile { key: NousScoreTileKey; label: string; points: number; detail: string; items: NousScoreItem[] }
export interface NousScore {
  at: string; score: number;
  /** Against the snapshot of 24 hours and 7 days ago; null when there is none yet. */
  change24h: number | null; change7d: number | null;
  tiles: NousScoreTile[];
  /** Every costing tile and each big project on its own, most negative first; share is its % of all the points lost. */
  breakdown: Array<{ label: string; points: number; share: number; detail: string }>;
  /** The owner's score reset (POST /api/nous/score/reset): only what happened after it counts; null or absent when never reset. */
  resetAt?: string | null;
}
export interface NousScoreHistory { range: NousScoreRange; points: Array<{ at: string; value: number }> }

/** One turn's facts (migration 0212), kept when the conversation is cleared: the source of Nous's scorecard. */
export const nousTurnFactsSchema = z.object({
  turnId: z.string().min(1).max(120),
  ownerUserId: z.string().min(1).max(200),
  reason: nousTurnReasonSchema,
  status: z.enum(["DONE", "FAILED", "STOPPED", "TIMEOUT"]),
  /** Per tool name: calls, failures, the failures that were a gate holding back (not mistakes), and the turn's mistakes' texts: `error` the first
   * (2/11 REVIEW, rows before 8/11), `errors` up to 3 (8/11, brief tool-error-samples). */
  tools: z.record(z.string(), z.object({ calls: z.number().int().min(0), failed: z.number().int().min(0), refused: z.number().int().min(0), error: z.string().max(300).optional(),
    errors: z.array(z.string().max(300)).optional() }).strict()),
  /** Plan progress points the turn recorded (space_plan_update, increases only). */
  planPoints: z.number().int().min(0),
  outcomes: z.array(nousTurnOutcomeSchema),
  startedAt: isoDateTime,
  endedAt: isoDateTime,
  /** The model and effort the turn ran on, and what Claude Code reported it cost (total_cost_usd, modelUsage); null before 2026-10-21. */
  model: z.string().max(80).nullable().default(null),
  effort: z.string().max(16).nullable().default(null),
  costUsd: z.number().min(0).nullable().default(null),
  tokens: z.record(z.string(), z.unknown()).nullable().default(null),
  /** The goal a GOAL turn worked (2026-10-27), so the Goals view and space_nous_turn_costs show the cost per goal. */
  goalId: z.string().max(120).nullable().default(null),
  /** R11-1: a failed or timed-out turn's error, short (migration 0261), so failures are counted by cause. */
  error: z.string().max(300).nullable().default(null)
}).strict();
export type NousTurnFacts = z.infer<typeof nousTurnFactsSchema>;

/**
 * R11-1 (Space Gateway down 28/10 23:22 → 29/10 01:16 UTC: about 70 turns failed "API Error: Connection refused (ECONNREFUSED)", a doomed
 * turn every 2-3 minutes): a turn's error that says the model's gateway did not answer at all.
 */
// R24-1 (7 days to 1/11: 2 turns failed "The provider model catalog is unavailable."): the gateway's catalog not answering is an outage too.
export const NOUS_GATEWAY_UNREACHABLE = /ECONNREFUSED|connection refused|gateway[^.]{0,40}unreachable|unable to connect to (?:the )?API|ENOTFOUND|EHOSTUNREACH|provider model catalog is unavailable/i;
/**
 * R17-2 (48 h to 30/10: 10 turns failed "Claude Code has no available tokens/quota"): a turn's error that says its accounts have no quota left.
 * R24-1 (7 days to 1/11: 28 turns failed "No active Claude subscription account. …", read as "other"): no account with room is the same thing.
 * 4/11 09:42Z: Space Gateway's fill-first refusal (code usage_limit_reached, "reached their 5-hour limit") read as a 429 throttle and paused Nous.
 */
export const NOUS_QUOTA_EXHAUSTED = /no available tokens|quota (?:is )?exhausted|usage[ _]limit|5-hour limit|session limit|hit your \w+ limit|no active claude subscription account/i;
/**
 * R24-1 (31/10 13:10-13:2x UTC: 35 turns failed "Invalid system prompt." until NOUS_SYSTEM_MAX_CHARS): one incident cause, so a recurrence shows at once.
 * R38-1 (1/11 05:00-08:59 UTC: 42 operator turns failed "Invalid prompt." until NOUS_PROMPT_MAX_CHARS, read as "other"): the worker's prompt check is the same cause.
 */
export const NOUS_SYSTEM_PROMPT_REFUSED = /invalid (?:system )?prompt/i;
/** R38-1 (28/10 22:00 → 29/10 01:59 UTC: 80 FAILED turns kept no error, so no cause): a FAILED turn thrown with no message is stored with this reason. */
export const NOUS_TURN_FAILED_NO_ERROR = "The turn failed with no error message.";
/** The error a turn's facts store: a FAILED turn's never empty. */
export const nousTurnFactsError = (turn: Pick<NousTurnFacts, "status" | "error">) => turn.status === "FAILED" && !turn.error?.trim() ? NOUS_TURN_FAILED_NO_ERROR : turn.error;
/** A turn failure's cause: the gateway did not answer, no account had quota, the system prompt was refused, the turn ran out of time, or anything else (null: no failure). */
export function nousFailureCause(turn: Pick<NousTurnFacts, "status" | "error">): "gateway" | "quota" | "system_prompt" | "timeout" | "other" | null {
  if (turn.status === "TIMEOUT") return "timeout";
  if (turn.status !== "FAILED") return null;
  const error = turn.error ? turn.error.replace(/ \(earlier: [\s\S]*$/, "") : "";
  return !error ? "other" : NOUS_GATEWAY_UNREACHABLE.test(error) ? "gateway" : NOUS_QUOTA_EXHAUSTED.test(error) ? "quota"
    : NOUS_SYSTEM_PROMPT_REFUSED.test(error) ? "system_prompt" : "other";
}

/** The operator's four kinds of critical decisions (2026-10-17). */
export const nousDecisionCategorySchema = z.enum(["RELEASE", "DESTRUCTIVE", "EXTERNAL", "DIRECTION"]);
export type NousDecisionCategory = z.infer<typeof nousDecisionCategorySchema>;
export const nousDecisionStatusSchema = z.enum(["OPEN", "APPROVED", "DECLINED", "ANSWERED", "CANCELLED"]);
export type NousDecisionStatus = z.infer<typeof nousDecisionStatusSchema>;

const refId = z.string().min(1).max(200);
export const nousCopilotSchema = z.enum(["MAIL", "MARKETING", "FREELANCE", "JOB", "DESIGN", "APP_STUDIO", "VIDEO", "SECURITY", "MONITORING"]);
export type NousCopilot = z.infer<typeof nousCopilotSchema>;

/**
 * What the server runs on the operator's yes. The model proposes it with the question; after the yes the server runs
 * exactly this, so a critical action never depends on what the model says later.
 */
export const nousDecisionActionSchema = z.discriminatedUnion("type", [
  /** Text typed into one pane: a prompt answer or an instruction the guardrails held back. */
  z.object({
    type: z.literal("PANE_TEXT"), roomId: refId, paneId: refId, text: z.string().max(4_000), mode: z.enum(["PROMPT", "ANSWER"]),
    /** ANSWER only: the prompt the operator saw; a changed prompt is not answered. */
    fingerprint: z.string().max(200).optional()
  }).strict(),
  /** A copilot's review, rule, campaign or lead decision, as the operator. */
  z.object({
    type: z.literal("COPILOT"), copilot: nousCopilotSchema, item: z.enum(["REVIEW", "RULE", "CAMPAIGN", "LEAD"]), itemId: refId,
    paneId: refId.nullable(), decision: z.string().min(1).max(40), text: z.string().max(20_000).optional(), note: z.string().max(2_000).optional(),
    /** A Marketing review's new time: a stale post (marketingPostStale) goes out again only with one. */
    scheduledAt: z.string().datetime({ offset: true }).optional()
  }).strict(),
  /** Approves the product's release train at its current candidate commit. */
  z.object({ type: z.literal("RELEASE_APPROVE"), product: z.string().min(1).max(80) }).strict(),
  /** A Space Control batch (space_execute) in one of the owner's rooms that Nous may not run itself: deletes, publishing, settings. */
  z.object({ type: z.literal("SPACE_CONTROL"), roomId: refId, actions: z.array(z.record(z.string(), z.unknown())).min(1).max(20) }).strict(),
  /** Rebuilds the Vault broker from stable's committed code and restarts it, as root (scripts/space-vault-broker-reinstall.mjs). */
  z.object({ type: z.literal("VAULT_BROKER_REINSTALL") }).strict()
]);
export type NousDecisionAction = z.infer<typeof nousDecisionActionSchema>;

/**
 * R27-1: a test VM or CT (vmid) on a host, or one of its snapshots, that an agent pane created and recorded when it made it
 * (scripts/space-test-resource.mjs); "May delete what Nous created" covers deleting it.
 */
export const nousTestTargetSchema = z.object({
  host: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/),
  vmid: z.number().int().min(100).max(999_999_999),
  snapshot: z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/).optional()
}).strict();
export type NousTestTarget = z.infer<typeof nousTestTargetSchema>;

export const nousDecisionRefsSchema = z.object({
  roomId: refId.optional(), paneId: refId.optional(), planId: refId.optional(), notificationId: refId.optional(),
  // Operator request 2026-10-21: the operator reads every text a decision sends before approving it ("Show everything").
  files: z.array(z.string().trim().min(1).max(400)).max(10).optional()
    .describe("The files holding every text the action sends, word for word (emails, posts, messages): agent-workspace paths or Agent Files/Media artifact ids."),
  /** Queue item 27 (27/10 Temu/Will: a second reply started): an approved send holds itself when the thread got a reply after it was asked. */
  mailThread: z.object({ account: z.string().trim().email().max(320), threadId: z.string().trim().min(1).max(200) }).strict().optional()
    .describe("A send that answers a mail thread: its account and threadId; if a reply goes out there after you ask, the approved action holds instead of sending twice."),
  /** "May send to third parties" (2026-10-28): what kind of send this is and who receives it, so a learned kind can run on the allowance. */
  // R70 (2/11 07:44 "marketing-hacker_news" refused, nothing asked): capitals, underscores and spaces are read as the hyphenated kind.
  sendKind: z.preprocess((kind) => typeof kind === "string" ? kind.trim().toLowerCase().replace(/[_\s]+/g, "-") : kind, z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/)).optional()
    .describe("An EXTERNAL send's kind in lower-case words with hyphens (pilot-offer, mail-reply, job-followup); the same kind every time for the same kind of send."),
  recipients: z.array(z.string().trim().email().max(320)).max(50).optional()
    .describe("Every address an EXTERNAL send reaches."),
  /** R13-12: the site an EXTERNAL ask is about; Space puts its Vault logins and its mail on the card. */
  site: z.string().trim().min(3).max(200).optional().describe("The site an EXTERNAL ask is about (e.g. upwork.com): Space adds its Vault logins and its mail of 30 days to the card."),
  /** R10-18 (operator rule d5ee2808: an e-mail is approved as its exact text): written by the server at ask time, re-checked on the yes. */
  fileHashes: z.array(z.object({ ref: z.string().trim().min(1).max(400), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().min(0) }).strict()).max(10).optional()
    .describe("Written by the server when you ask; never set it."),
  /** Goal 84ba917a (6/11: 8 marketing decisions named their post only in a title or file name): the copilot item the send decides. */
  copilotItem: refId.optional().describe("Written by the server when you ask: the copilot item (mktpost:…, flmsg:…, a review id) this send decides; never set it."),
  /** R12-11 (goal 7365014c criterion 3): the prediction the ledger scores, written by the server from the ask's `prediction` or its «Πρόβλεψη» line. */
  prediction: z.object({ answer: z.string().trim().min(1).max(200), confidence: z.number().int().min(0).max(100).nullable(),
    // A written answer the operator is expected to type (no options), scored by its words.
    written: z.literal(true).optional() }).strict().optional()
    .describe("Written by the server when you ask; give space_ask_operator's `prediction` instead."),
  testDeletes: z.array(nousTestTargetSchema).min(1).max(50).optional()
    .describe("A DESTRUCTIVE PANE_TEXT that removes test VMs/CTs or their snapshots: every target it removes ({host, vmid} for a whole VM or CT, "
      + "{host, vmid, snapshot} for one snapshot). Under \"May delete what Nous created\" it runs at once when each target has the creation record "
      + "the pane made with space-test-resource and the text removes nothing else.")
}).strict();

export const nousDecisionSchema = z.object({
  id: nousDecisionIdSchema,
  ownerUserId: z.string().min(1).max(200),
  category: nousDecisionCategorySchema,
  title: z.string().min(1).max(200),
  body: z.string().max(4_000),
  options: z.array(z.string().min(1).max(200)).max(6),
  recommendation: z.string().max(2_000).nullable(),
  refs: nousDecisionRefsSchema,
  action: nousDecisionActionSchema.nullable(),
  status: nousDecisionStatusSchema,
  answer: z.string().max(2_000).nullable(),
  /** What the server did on the answer ("Approved the review", "Failed: …"). */
  outcome: z.string().max(2_000).nullable(),
  createdAt: isoDateTime,
  answeredAt: isoDateTime.nullable(),
  /** The operator's feedback after answering: Nous could have decided this itself (migration 0213). */
  couldHaveDecided: z.boolean().optional(),
  /** Served only (never stored): what an allowance-held decision waits for before it runs by itself (`nousDecisionRunsWhen`). */
  runsWhen: z.string().max(2_000).optional()
}).strict();
export type NousDecision = z.infer<typeof nousDecisionSchema>;

/** Account facts (sign-ins, connected Google accounts, Vault logins): Nous's, never the operator's (operator 2/11 09:49 BKK, 30/10 08:44 BKK). */
const ACCOUNT_FACT_LINE = /^(?:[-•]\s*)?(?:Vault: \d+ logins? for |Sign-ins for |Connected Google accounts: |Space's account facts:\s*$)/;
/** R10-17's "Mail from/with <domain> in N days: <mailbox>: …" without the operator's mailbox: Nous keeps it, the operator reads its kind. */
const MAIL_LINE_MAILBOX = /^((?:- )?Mail (?:from|with) \S+ in \d+ days: )[^\s:@]+@[^\s:]+: (\d+\+? threads?)/;
export const mailLineForOperator = (line: string): string => line.replace(MAIL_LINE_MAILBOX, "$1$2 in a connected mailbox");
/** A decision or card body without the account-fact lines and mailboxes Space wrote into it before 2/11, so a stored record reads clean everywhere. */
export function withoutAccountFacts(body: string): string {
  const lines = body.split("\n");
  const kept = lines.filter((line) => !ACCOUNT_FACT_LINE.test(line)).map(mailLineForOperator);
  return kept.length === lines.length && kept.every((line, index) => line === lines[index]) ? body : kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The first body line only the server writes on a decision an allowance holds: a send of the old maySend hold, a guarded host restart. */
export const NOUS_SEND_HOLD_LINE = "Approved by allowance maySend: goes out at";
export const NOUS_RESTART_HOLD_LINE = "Held for \"May run guarded host restarts\":";

/**
 * Operator 31/10 17:00 BKK («You are asking me for approve AGAIN!!!»): a decision an allowance holds runs by itself, so it is no ask: no
 * buttons, card, count, push or pendings line. Its answer is what it waits for (the dock and the Nous app show "Runs by itself when
 * this clears: …"); null for a decision that asks, or one the server already gave back to the operator (an outcome was written).
 */
export function nousDecisionRunsWhen(decision: Pick<NousDecision, "status" | "body" | "outcome">): string | null {
  if (decision.status !== "OPEN" || decision.outcome) return null;
  if (decision.body.startsWith(NOUS_RESTART_HOLD_LINE)) return /once this clears: (.+?)\.?$/m.exec(decision.body)?.[1] ?? "its preconditions clear";
  return decision.body.startsWith(NOUS_SEND_HOLD_LINE) ? "Space's next minute check sends it (May send to third parties)" : null;
}

/**
 * A decision's kind for "Always approve" (operator request 2026-10-18): what its action does without its target, so the next
 * decision of that kind runs on its own. Null for what stays the operator's every time: releases, irreversible actions, text for
 * a pane (its words carry the risk) and questions without an action.
 */
export function nousDecisionKind(decision: Pick<NousDecision, "category" | "action">): { key: string; label: string } | null {
  const action = decision.action;
  if (!action || decision.category === "RELEASE" || decision.category === "DESTRUCTIVE") return null;
  // A held Security or Monitoring Copilot change (a reboot, a delete, a restart on a host) is decided by a person every time.
  // A mail campaign reaches customers: every one is the operator's own yes (plan clipboard:IJ2ovfLg1Lbw).
  if (action.type === "COPILOT" && (action.copilot === "SECURITY" || action.copilot === "MONITORING" || (action.copilot === "MAIL" && action.item === "CAMPAIGN"))) return null;
  if (action.type === "COPILOT") {
    return { key: `COPILOT:${action.copilot}:${action.item}:${action.decision}`, label: `${action.decision} the ${action.copilot.toLowerCase()} copilot's ${action.item.toLowerCase()}s` };
  }
  if (action.type !== "SPACE_CONTROL") return null;
  const ops = [...new Set(action.actions.map((entry) => [entry.kind, entry.operation].filter((part) => typeof part === "string").join(" ")))].sort();
  return { key: `SPACE_CONTROL:${ops.join(",")}`, label: `run in Space Control: ${ops.join(", ")}` };
}
export const nousStandingApprovalSchema = z.object({ key: z.string().min(1).max(2_000), label: z.string().min(1).max(2_000), at: isoDateTime }).strict();
export type NousStandingApproval = z.infer<typeof nousStandingApprovalSchema>;

/** Saved in the owner's user settings (`nous`); off until the operator turns it on. */
export const nousSettingsSchema = z.object({
  /** Missing tabs stay on. Conversation is always visible and cannot be switched off. */
  dockTabs: z.object({
    needs: z.boolean().optional(), done: z.boolean().optional(), updates: z.boolean().optional(), decisions: z.boolean().optional(), overview: z.boolean().optional(),
    panes: z.boolean().optional(), plans: z.boolean().optional(), goals: z.boolean().optional(), startup: z.boolean().optional(), affiliate: z.boolean().optional(), funding: z.boolean().optional(), jobs: z.boolean().optional(), crypto: z.boolean().optional(), marketing: z.boolean().optional(), quotas: z.boolean().optional(), shared: z.boolean().optional(), requests: z.boolean().optional(),
    load: z.boolean().optional(), score: z.boolean().optional(), taskRuns: z.boolean().optional(),
    // The Nous app's own tabs (nous_msg:b4fb69589b394a6aa4679dc2, app 0.2.34): its Settings › Tabs saves them here; the web dock has neither tab.
    appointments: z.boolean().optional(), signature: z.boolean().optional()
  }).strict().optional(),
  enabled: z.boolean().default(false),
  maxTurnsPerHour: z.number().int().min(1).max(120).default(20),
  /** Deprecated JSON field from the first dev slice; lowSpend.mode now controls the policy. */
  lowTokenAutomatic: z.boolean().default(true),
  lowSpend: nousLowSpendSettingsSchema.default(() => nousLowSpendSettingsSchema.parse({})),
  /** The operator lets Nous promote dev to stable without asking, batched (operator decision 2026-10-17, off by default). */
  mayPromote: z.boolean().default(false),
  /** The operator lets Nous approve changes to the protected Warm code (operator decision 2026-10-17, off by default). */
  mayApproveWarm: z.boolean().default(false),
  /** The operator lets Nous approve the Security Copilot's stable hotfix tickets (operator decision 2026-10-24, off by default). */
  maySecurityHotfix: z.boolean().default(false),
  /**
   * R16-7 (operator rule f360b58c 29/10 16:07 BKK «Τέτοια τύπου approve μην με ρωτάς τα προχωράς άμεσα»): the Security and Monitoring Copilots run
   * changes on the operator's own hosts (upgrades, restarts, config, WAF, containers, guest starts, cache clears) with a backup and a rollback
   * without asking; on, they ask as before. Off by default; a person only.
   */
  askOwnHostChanges: z.boolean().default(false),
  /**
   * Space spends a Codex weekly reset credit by itself when an account is used up, its own reset is over 6 hours away and Codex work
   * waits (operator 2/11 15:38 BKK, brief 20261102-codex-reset-credits). On unless false; false stops it, a person only on stable.
   */
  autoResetCredits: z.boolean().optional(),
  /** The operator lets the server approve Nous's learned sends to third parties after a 10-minute hold (operator decision 2026-10-28, off by default). */
  maySend: z.boolean().default(false),
  /** The operator lets the server delete Agent Files Nous made itself, a copy kept first (operator decision 2026-10-28, off by default). */
  mayDeleteOwn: z.boolean().default(false),
  /** The operator lets the server approve a release train candidate whose captain recorded a green lab proof (operator decision 2026-10-28, off by default). */
  mayPublish: z.boolean().default(false),
  /** R16-1: the operator lets the server approve a guarded Browser Host or pane host restart whose facts all hold (off by default, a person only). */
  mayRestartHosts: z.boolean().default(false),
  /**
   * Operator 2/11 BKK: on, Nous has no right to refuse, narrow or question any task the operator asks; they took every responsibility and the
   * decision is theirs. Security matters are the exception and keep every rule; Space's own gates are unchanged. Off by default; a person only turns it on.
   */
  neverRefuse: z.boolean().default(false),
  /** Bash in Nous's own turns, like a CLI pane but never with sudo (operator order 2026-10-24, on by default); helpers have none. */
  shell: z.boolean().default(true),
  /** Kinds of decisions the operator approved with "Always approve" in the dock; a PATCH can only remove them. */
  // Every kind the operator chose (until 31/10 the newest 50 kept, older choices dropped).
  alwaysApprove: z.array(nousStandingApprovalSchema).default([]),
  /** The pane board's summaries (plan clipboard:Y9cgKVHFaHrr); a function default so a PATCH without it keeps the saved one. */
  paneBoard: nousPaneBoardSettingsSchema.default(() => nousPaneBoardSettingsSchema.parse({})),
  /** Space's standing orders (operator orders 2026-10-21): finished panes and stalled plans brought to Nous every tick. */
  standingOrders: nousStandingOrdersSettingsSchema.default(() => nousStandingOrdersSettingsSchema.parse({})),
  /** The provider selected in Settings. Absent on legacy settings: inferred from their stored operator model. */
  provider: z.enum(NOUS_PROVIDERS).optional(),
  /** Saved choices always win over the new-account defaults. */
  models: nousModelsSettingsSchema.default(() => nousModelsSettingsSchema.parse({})),
  /** Claude Code's --fallback-model for every turn; off by default (operator decision 2026-10-21, kept 2026-10-24). */
  fallbackModel: nousModelIdSchema.default("none"),
  /** The operator talks to Nous from the paired Telegram chat and answers its decisions there (2026-10-24); off until a person turns it on. */
  telegramInbound: z.boolean().default(false),
  /** A copilot's question waits up to an hour for Nous before it reaches the operator (Ask Last step 7, 2026-10-27); on by default. */
  copilotQuestionsNousFirst: z.boolean().default(true),
  /** The goal loop (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1); a function default so a PATCH without it keeps the saved one. */
  goals: nousGoalsSettingsSchema.default(() => nousGoalsSettingsSchema.parse({}))
}).strict();
export type NousSettings = z.infer<typeof nousSettingsSchema>;
/** Legacy low-spend defaults belong to Claude; never let them move a Codex turn to another provider. */
export function nousSettingsWithProvider(settings: NousSettings): NousSettings {
  const provider = nousProvider(settings);
  const models = { ...settings.models };
  for (const kind of NOUS_TURN_KINDS) {
    if (models[kind]) models[kind] = normalizeModelChoice(models[kind]);
  }
  const lowSpend = { ...settings.lowSpend, models: { ...settings.lowSpend.models }, criticalModels: { ...settings.lowSpend.criticalModels } };
  for (const kind of NOUS_LOW_SPEND_KINDS) {
    if (!nousModelMatchesProvider(lowSpend.models[kind].model, provider)) {
      lowSpend.models[kind] = nousCheaperModel(provider);
    } else {
      lowSpend.models[kind] = normalizeModelChoice(lowSpend.models[kind]);
    }
    if (!nousModelMatchesProvider(lowSpend.criticalModels[kind].model, provider)) {
      const choice = nousCheaperModel(provider, true);
      lowSpend.criticalModels[kind] = { model: choice.model, effort: choice.effort === "none" ? "none" : "medium" };
    } else {
      lowSpend.criticalModels[kind] = normalizeCriticalModelChoice(lowSpend.criticalModels[kind]);
    }
  }
  return { ...settings, provider, models, lowSpend };
}

/**
 * Nous on a self-hosted install (operator decision 2026-10-27, B+C3): the owner's own Claude plan pays for every turn, so the
 * defaults are lean (Sonnet 5.5; batched inbox; a goal turn every 15 minutes at most; no shell, finished-pane sweeps, daily
 * review or pane board). Every value stays a setting, and a stored value always wins.
 */
const sonnet = (effort: "medium" | "low") => ({ model: "claude-sonnet-5-5", effort });
export const NOUS_PUBLIC_DEFAULTS = {
  maxTurnsPerHour: 6,
  shell: false,
  paneBoard: { enabled: false, language: "en" },
  standingOrders: { closeFinishedPanes: false, dailyReview: false },
  goals: { gapSeconds: 900 },
  models: { operator: sonnet("medium"), decision: sonnet("medium"), inbox: sonnet("low"), standing: sonnet("low"), helper: sonnet("low"), goal: sonnet("low") },
  // The maintainer's own business pages (operator 5/11, plan clipboard:NtXOwLkXVN1x): off until the owner turns them on in Dock tabs.
  dockTabs: { startup: false, funding: false, crypto: false }
} as const;
/** Stored Nous settings with the self-hosted defaults under them, one level deep for the grouped settings. */
export function withNousPublicDefaults(stored: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...NOUS_PUBLIC_DEFAULTS, ...stored };
  for (const key of ["paneBoard", "standingOrders", "goals", "models", "dockTabs"] as const) {
    const own = stored[key];
    merged[key] = { ...NOUS_PUBLIC_DEFAULTS[key], ...(own && typeof own === "object" ? own : {}) };
  }
  return merged;
}

/**
 * Nous Away mode (operator request 2026-10-17, plan clipboard:B7eTUHTJYg3X): what the operator's away grant lets Nous decide
 * alone. PROMOTE: promote dev to stable, only right after live:verify:dev passed; TEST_PANES: restart or close the operator's own
 * test panes. Never under any grant: npm or GitHub publishing, payments, deletes, sends to third parties, Warm code, pane-host or
 * browser-host restarts.
 */
export const nousAwayGrantSchema = z.enum(["PROMOTE", "TEST_PANES"]);
export type NousAwayGrant = z.infer<typeof nousAwayGrantSchema>;
export const nousAwaySchema = z.object({
  id: z.string().min(1).max(120),
  startedAt: isoDateTime,
  until: isoDateTime.nullable(),
  reason: z.string().max(500),
  mandate: z.string().max(2_000),
  grant: z.array(nousAwayGrantSchema)
}).strict();
export type NousAway = z.infer<typeof nousAwaySchema>;
/** Settings → Assistants & AI → Nous: the operator starts or ends Away, and widens or narrows its grant. */
export const nousAwayInputSchema = z.object({
  away: z.boolean(),
  grant: z.array(nousAwayGrantSchema).max(2).optional(),
  until: isoDateTime.optional()
}).strict();

/**
 * OFF: not turned on; PAUSED_MODEL: the model failed and Nous waits (the other notifications go out again meanwhile);
 * WAITING_QUOTA: no account of its provider has room for automatic turns; they wait, the operator's messages still run (4/11);
 * UNAVAILABLE: no turn can run here now (`unavailable` says why: dev, or a public install whose Claude Code is not signed in).
 */
export const nousStatusSchema = z.enum(["OFF", "IDLE", "THINKING", "PAUSED_MODEL", "WAITING_QUOTA", "UNAVAILABLE"]);
export type NousStatus = z.infer<typeof nousStatusSchema>;

export const nousExecutionSchema = z.object({
  turnId: z.string(), model: z.string(), effort: z.string().nullable(),
  phase: z.enum(["starting", "responding", "completed"])
});
export type NousExecution = z.infer<typeof nousExecutionSchema>;

export const nousStateSchema = z.object({
  status: nousStatusSchema,
  settings: nousSettingsSchema,
  execution: nousExecutionSchema.nullable().optional(),
  model: z.string(),
  effort: z.string(),
  /** `draft`: the answer as it is written (streamed, operator request 2026-10-24); the dock shows it with "Nous is writing…". */
  running: z.object({ turnId: z.string(), startedAt: isoDateTime, reason: nousTurnReasonSchema, draft: z.string().nullable().optional() }).nullable(),
  turnsThisHour: z.number().int().min(0),
  lastError: z.string().max(1_000).nullable(),
  unavailable: z.string().max(300).nullable().optional(),
  openDecisions: z.number().int().min(0),
  inbox: z.number().int().min(0),
  /** The open away session; absent or null while the operator is here. */
  away: nousAwaySchema.nullable().optional(),
  /** The goals (2026-10-27): how many are ACTIVE (the composer's Goals badge) and whether a goal turn is due or held. */
  goals: z.object({ active: z.number().int().min(0), nextAt: isoDateTime.nullable(), held: z.string().max(200).nullable() }).strict().optional()
}).strict();
export type NousState = z.infer<typeof nousStateSchema>;

/**
 * A file the operator sends Nous with a message (plan clipboard:hQg9iKGYDqx7): an image it looks at, a document it reads
 * as extracted text, a video it gets as a reference with sampled frames, or another file it knows by name and size.
 */
export const nousAttachmentIdSchema = z.string().regex(/^nous_file:[A-Za-z0-9_-]{6,80}$/);
export const nousAttachmentKindSchema = z.enum(["IMAGE", "DOCUMENT", "VIDEO", "FILE"]);
export type NousAttachmentKind = z.infer<typeof nousAttachmentKindSchema>;
/** The server appends the files' block (for Nous's turn) to the operator's message after this line; the dock hides it. */
export const NOUS_ATTACHMENTS_MARKER = "[[Attachments:";
export const nousAttachmentSchema = z.object({
  id: nousAttachmentIdSchema,
  messageId: nousMessageIdSchema.nullable(),
  kind: nousAttachmentKindSchema,
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200),
  byteSize: z.number().int().min(1),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  durationSeconds: z.number().min(0).nullable(),
  /** How much of a document Nous can read, e.g. "FULL" or "PARTIAL: first 40 of 120 pages". */
  readable: z.string().max(300).nullable(),
  createdAt: isoDateTime
}).strict();
export type NousAttachment = z.infer<typeof nousAttachmentSchema>;

export const nousSendInputSchema = z.object({
  content: z.string().trim().default(""),
  // Any number of files a message (until 31/10 at most 10); each file's size stays bounded by its kind.
  attachmentIds: z.array(nousAttachmentIdSchema).optional(),
  // The Nous app's outbox id (nous_msg:acccb43f): a retry of a message SpaceApp already stored answers that message, never a second one.
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional()
}).strict().refine((input) => input.content.length > 0 || Boolean(input.attachmentIds?.length), { message: "Write a message or attach a file." });

/**
 * A PATCH names only what it changes, inside a group too (run-spaceapp 1.2.0 lab 4/11: `{"paneBoard":{"enabled":true}}` filled the
 * group's other fields with their defaults, so a public install stored the pane board language el and its lines turned Greek).
 */
export const nousSettingsInputSchema = patchSchema(nousSettingsSchema).extend({
  lowSpend: groupPatchSchema(nousLowSpendSettingsSchema).optional(),
  paneBoard: groupPatchSchema(nousPaneBoardSettingsSchema).optional(),
  standingOrders: groupPatchSchema(nousStandingOrdersSettingsSchema).optional(),
  models: groupPatchSchema(nousModelsSettingsSchema).optional(),
  goals: groupPatchSchema(nousGoalsSettingsSchema).optional()
}).strict();
export type NousSettingsInput = z.infer<typeof nousSettingsInputSchema>;
const NOUS_SETTINGS_GROUPS = ["dockTabs", "lowSpend", "paneBoard", "standingOrders", "models", "goals"] as const;
/** The saved settings with a PATCH on them: a group the PATCH names keeps the fields it does not name. */
export function mergeNousSettings(before: NousSettings, patch: NousSettingsInput): NousSettings {
  const merged: Record<string, unknown> = { ...before, ...patch };
  for (const key of NOUS_SETTINGS_GROUPS) if (patch[key]) merged[key] = { ...before[key], ...patch[key] };
  return nousSettingsWithProvider(nousSettingsSchema.parse(merged));
}

export const nousDecisionAnswerInputSchema = z.object({
  answer: z.enum(["APPROVE", "DECLINE", "ANSWER"]),
  text: z.string().trim().min(1).max(2_000).optional(),
  /** APPROVE only: approve this kind of decision from now on too. */
  always: z.boolean().optional()
}).strict().refine((input) => input.answer !== "ANSWER" || Boolean(input.text), { message: "An answer needs text.", path: ["text"] })
  .refine((input) => !input.always || input.answer === "APPROVE", { message: "Only an approval can be always.", path: ["always"] });
export type NousDecisionAnswerInput = z.infer<typeof nousDecisionAnswerInputSchema>;

const YES_WORDS = "ναι|ναί|οκ|οκέι|οκει|εντάξει|ενταξει|εγκρίνω|εγκρινω|προχώρα|προχωρα|προχώρησε|προχωρησε|κάν(?:['’] ?|ε )?το|καντο|συμφωνώ|συμφωνω|ωραία|ωραια|τέλεια|τελεια|σωστά|σωστα|βεβαίως|βεβαιως|φυσικά|φυσικα|σίγουρα|σιγουρα"
  + "|yes|yep|yeah|ok|okay|approve|approved|go|go ahead|do it|proceed|sure|confirm|confirmed|great|fine|perfect|sounds good";
const ANSWER_YES = new RegExp(`^(?:${YES_WORDS})(?:\\s+(?:παρακαλώ|παρακαλω|ευχαριστώ|ευχαριστω|please|thanks))?$`, "iu");
/** A yes word with a short note after a plain space: «ωραια την διαγραφεις», «οκ προχώρα». */
const ANSWER_YES_NOTE = new RegExp(`^(${YES_WORDS})\\s+([\\s\\S]+)$`, "iu");
/** A short imperative that carries the action out is a yes on its own (operator answers 26/10 «να φυγει τωρα», 27/10 «διάγραψε»). */
const ACTION_WORDS = "διάγραψε|διαγραψε|διαγράφεις|διαγραφεις|σβήσε|σβησε|στείλε|στειλε|στείλ['’ ]?το|στειλ['’ ]?το|να φύγει|να φυγει|να φύγουν|να φυγουν|τρέξε|τρεξε|κάνε|κανε|κάν['’] ?το|καντο|φτιάξε|φτιαξε|αφαίρεσε|αφαιρεσε|delete it|send it|run it|do it";
const ANSWER_ACTION = new RegExp(`^(?:${ACTION_WORDS})(?:\\s+(?:το|τα|τον|την|τη))?(?:\\s+(?:τώρα|τωρα|now))?$`, "iu");
/**
 * "Do it now" anywhere makes the answer a yes even when it brushes a later date aside (operator 27/10 14:37: «ασε τα αυριο κανε το
 * τωρα!!!»): sooner is no condition. A real condition (if, only, unless, when, don't, after the X) still leaves it to Nous.
 */
const ANSWER_ACTION_NOW = new RegExp(`(?<=^|[\\s,.;:!«"'(-])(?:${ACTION_WORDS})(?:\\s+(?:το|τα|τον|την|τη))?\\s+(?:τώρα|τωρα|now)(?=$|[\\s,.;:!…»"')])`, "iu");
const ANSWER_HARD_CONDITION = /(?<=^|[\s,.;:!?…«»"'()-])(?:αλλά|αλλα|αν|εάν|εαν|εφόσον|εφοσον|όταν|οταν|μόνο|μονο|εκτός|εκτος|μην|μη|if|unless|only|except|when|but|don'?t|μετά\s+(?:το|τη|την|τον|τα|τις|από)|μετα\s+(?:το|τη|την|τον|τα|τις|απο)|after\s+(?:the|it|that|this))(?=\s|$|[,.;:!?…»"')])/iu;
const ANSWER_NO = /^(?:όχι|οχι|μην|μη|απορρίπτω|απορριπτω|άκυρο|ακυρο|no|nope|decline|declined|don'?t|do not|stop|cancel|reject|rejected)(?:\s+(?:παρακαλώ|παρακαλω|ευχαριστώ|ευχαριστω|please|thanks))?$/iu;
/** A note that makes the yes conditional: "yes, but tomorrow", "ναι, μόνο αν…". */
const ANSWER_CONDITION = /^(?:αλλά|αλλα|όμως|ομως|μόνο|μονο|εκτός|εκτος|αν|εάν|εαν|εφόσον|εφοσον|αφού|αφου|μετά|μετα|πρώτα|πρωτα|όχι|οχι|μην|μη|but|only|except|if|unless|after|first|when|once|instead|not|no|don'?t)(?=\s|$|[,.;:!?])/iu;
/** A condition or deferral anywhere in the note ("μετά"/"after" only lead one: "πες μου μετά" is no condition). */
const ANSWER_CONDITION_ANYWHERE = /(?<=^|[\s,.;:!?…«»"'()-])(?:αλλά|αλλα|όμως|ομως|μόνο|μονο|εκτός|εκτος|αν|εάν|εαν|εφόσον|εφοσον|όταν|οταν|πρώτα|πρωτα|αύριο|αυριο|αργότερα|αργοτερα|but|only|except|if|unless|when|first|tomorrow|later)(?=\s|$|[,.;:!?…»"')])/iu;
const conditional = (note: string) => ANSWER_CONDITION.test(note) || ANSWER_CONDITION_ANYWHERE.test(note);
/** Safety: a longer reply stays ANSWERED for Nous to read; it never runs the decision as a plain yes. */
export const NOUS_ANSWER_NOTE_MAX_CHARS = 200;

/**
 * What an answer in words means for a decision with an action (operator gap 2026-10-24: a typed "ναι" closed the card as answered
 * with its action unrun, and Nous asked again). A yes or no decides, with at most a short unconditional note after a comma, dash,
 * line break or (for a yes) a plain space; a short imperative of the action ("διάγραψε", "να φύγει τώρα") is a yes. Conditions,
 * questions and anything longer stay for Nous to read (null).
 */
export function nousAnswerIntent(text: string): "APPROVE" | "DECLINE" | null {
  const trimmed = text.trim();
  if (/[?;\u037e]$/u.test(trimmed)) return null;
  if (trimmed.length <= NOUS_ANSWER_NOTE_MAX_CHARS && ANSWER_ACTION_NOW.test(trimmed) && !ANSWER_HARD_CONDITION.test(trimmed)) return "APPROVE";
  const match = /^([^,;:\n—–-]+?)\s*(?:[,;:—–-]|\n)\s*([\s\S]*)$/u.exec(trimmed);
  const head = (match ? match[1]! : trimmed).trim().replace(/[.!…]+$/u, "").trim();
  const note = match ? match[2]!.trim() : "";
  if (note.length > NOUS_ANSWER_NOTE_MAX_CHARS || conditional(note)) return null;
  if (ANSWER_YES.test(head) || ANSWER_ACTION.test(head)) return "APPROVE";
  if (ANSWER_NO.test(head)) return "DECLINE";
  const [, word, spaced] = ANSWER_YES_NOTE.exec(head) ?? [];
  // "ναι ναι" stays Nous's to read, as before.
  if (spaced && spaced.toLowerCase() !== word!.toLowerCase() && spaced.length + note.length <= NOUS_ANSWER_NOTE_MAX_CHARS && !conditional(spaced) && !ANSWER_NO.test(spaced)) return "APPROVE";
  return null;
}

/** "You could have decided this" on an answered decision, from the operator in the Nous dock. */
export const nousDecisionFeedbackInputSchema = z.object({ couldHaveDecided: z.boolean() }).strict();
export type NousDecisionFeedbackInput = z.infer<typeof nousDecisionFeedbackInputSchema>;

/** Plan map (operator request 2026-10-25): a server-wide condition that holds every plan until it clears. */
export const nousGlobalHoldSchema = z.object({
  kind: z.enum(["NOUS_OFF", "MODEL_PAUSED", "LOW_SPEND", "QUEUE_PAUSED", "QUEUE_DOWN", "PLAN_CONTROLLER_OFF", "OVERLOADED"]),
  text: z.string(), since: z.string().nullable()
}).strict();
export type NousGlobalHold = z.infer<typeof nousGlobalHoldSchema>;
/** What one plan waits on now and where Space learned it: the plan's own `waitsOn`, an unfinished dependency, its managed execution, its pane's board line, its pane's report, or a server-wide hold. */
export const nousPlanHoldSchema = z.object({
  kind: planWaitsOnKindSchema, what: z.string(), until: z.string().nullable(),
  source: z.enum(["PLAN", "DEPENDENCY", "EXECUTION", "PANE", "REPORT", "SERVER"])
}).strict();
export type NousPlanHold = z.infer<typeof nousPlanHoldSchema>;
export const nousPlanHoldsSchema = z.object({
  holds: z.array(nousGlobalHoldSchema),
  /**
   * What to do first (2026-10-25): the server-wide holds (no plan ids: they hold every plan), then each blocker someone can act on
   * (you, a third party, a promote, Nous), merged when plans wait on the same thing, then plans others depend on (FINISH).
   * A wait for a date or for another plan is not a blocker: the date passes, the other plan is listed itself.
   */
  unblockFirst: z.array(z.object({
    kind: z.union([planWaitsOnKindSchema, z.literal("FINISH")]), what: z.string(), planIds: z.array(z.string()), unsticks: z.number().int().min(0)
  }).strict()),
  /** The dates: each plan's due date (DUE) and the time a plan waiting for a date resumes (RESUMES), soonest first; overdue = passed. */
  dates: z.array(z.object({ planId: z.string(), title: z.string(), at: z.string(), kind: z.enum(["DUE", "RESUMES"]), overdue: z.boolean() }).strict())
}).strict();
export type NousPlanHolds = z.infer<typeof nousPlanHoldsSchema>;

/** The dock's overview: every open plan, what needs the operator's hands, the release trains and Nous's plan map. */
export const nousOverviewSchema = z.object({
  plans: z.array(z.object({
    id: z.string(), title: z.string(), progress: z.number().int().min(0).max(100), status: z.string(),
    /** `pane` names the plan's pane only while it is open; `paneClosed`: its pane was closed or deleted (operator request 2026-10-26). */
    room: z.string().nullable(), pane: z.string().nullable(), paneClosed: z.boolean().optional(), nextStep: z.string().nullable(),
    /** The open pane's id (plan clipboard:PHmjUTRmWM6C: Needs you ties a pane's cards to its plan). */
    paneId: z.string().nullable().optional(),
    /** Its pane is working now (the state the Live view's Running tile counts; plan clipboard:RXqSSUQSdwJK). */
    active: z.boolean().optional(),
    /** The plan map (2026-10-25): dependency depth (0 = depends on no open plan), the open plans it depends on, its date and hold. */
    level: z.number().int().min(0).optional(), dependsOn: z.array(z.string()).optional(), dueAt: z.string().nullable().optional(),
    overdue: z.boolean().optional(), hold: nousPlanHoldSchema.nullable().optional(),
    /** Parked now (plan clipboard:7S_jA46vDkU9): why, and how many resume conditions are met. */
    parked: z.object({ reason: z.string(), met: z.number().int().min(0), total: z.number().int().min(0) }).strict().optional()
  }).strict()),
  needsHands: z.array(z.object({ id: z.string(), source: z.string(), title: z.string(), room: z.string().nullable() }).strict()),
  trains: z.string(),
  planMap: z.string().nullable(),
  planHolds: nousPlanHoldsSchema.optional(),
  /** The dock's live stats (plan clipboard:wr9yNPJwkDrp): the owner's rooms and their CLI panes by state, from the world's activity samples. */
  live: z.object({
    rooms: z.number().int().min(0),
    agents: z.object({ running: z.number().int().min(0), waiting: z.number().int().min(0), idle: z.number().int().min(0), total: z.number().int().min(0) }).strict()
  }).strict().optional(),
  /** The dock's Panes cards (plan clipboard:MAongwnxq9Ro): every open pane with Nous's last check, verdict and next check. */
  panes: z.array(z.object({
    paneId: z.string(), roomId: z.string(), room: z.string(), pane: z.string(), state: z.string().nullable(),
    checkedAt: z.string().nullable(), verdict: z.enum(["OK_WORKING", "WAITING_OPERATOR", "WAITING_DATE", "NEEDS_ACTION", "BLOCKED", "OPERATOR_TEST", "KEEP_OPEN"]).nullable(),
    note: z.string().nullable(), nextCheckAt: z.string().nullable(), dueAt: z.string(), overdue: z.boolean(),
    /** The pane's newest report (plan clipboard:ot6-jLKOWDNC); its summary is the pane's own words. */
    report: z.object({ at: z.string(), status: z.string(), source: z.enum(["AGENT", "AUTO"]), summary: z.string() }).strict().nullable().optional()
  }).strict()).optional()
}).strict();
export type NousOverview = z.infer<typeof nousOverviewSchema>;
