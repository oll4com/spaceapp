import { NOUS_EFFORTS, NOUS_GATEWAY_UNREACHABLE, NOUS_QUOTA_EXHAUSTED, NOUS_SPACE_ROUTES, nousAutoEffort, nousModelLabel, nousModelTier, nousRouteModel, nousSpaceModel,
  type GatewayProviderRoute, type NousProviderModel, type NousRunProvider, type NousSpaceRouteState } from "@space/contracts";

/**
 * Nous's "Space" provider (operator 3/11 15:03 BKK and nous_msg:6814c9eae, plan clipboard:52W5YTibb65k): every Space Gateway route in the
 * Gateway's provider order. An explicit model ("codex:gpt-6-astra") runs on its route only: when that route has no room the caller gets a
 * structured refusal (route, model, why, reset when known), never another model. An auto model tries the enabled routes in order, each with its
 * own model of the same class, and says which route served. Account exhaustion stays inside the Gateway (fill-first moves to the next account);
 * what reaches Nous is a pool refusal, a transient throttle or outage, or a refused credential, and each route cools down on its own: no lock
 * of one route ever holds another, so concurrent turns and helpers on different routes run side by side.
 */
export interface SpaceRoute extends NousSpaceRouteState { prefix: string; provider: NousRunProvider; models: NousProviderModel[]; quota?: { ready: boolean; key: string };
  /** A free or granted pool (NOUS_FREE_ROUTE_MODELS): OpenCode runs its namespaced id on Space Gateway's `/pools/space`; only non-code work may use it. */
  free?: boolean }
export interface SpaceAttempt { route: GatewayProviderRoute; name: string; runtime: string; provider: NousRunProvider; model: string; effort: string; free?: boolean;
  /** The namespaced id the turn's facts keep: the route and model that served. */
  id: string }
/** quota: the pool or its budget is used up; throttle: rate limited for now; unavailable: an outage; auth: a refused credential; other: the turn's own failure. */
export type SpaceFailureKind = "quota" | "throttle" | "unavailable" | "auth" | "other";
export interface SpaceRouteFailure { route: GatewayProviderRoute; name: string; model: string | null; kind: SpaceFailureKind | "skipped"; reason: string; resetAt: string | null }

/**
 * The one exception to "no free or granted pool on any Nous turn" (operator decision ab7b76db 15/11, plan clipboard:f5TgJ4IIJF1m):
 * the Nous app's Live voice call, in this order, on Space Gateway's `/pools/<slug>` under the `nous-live` key. Only `nous/live/*`
 * may import it (guard: nous-space-provider.test.ts); every turn reason and HELPER keep refusing free routes.
 */
export const NOUS_LIVE_POOLS = [
  { slug: "gemini", model: "gemini-3-flash-preview" }, { slug: "gemini", model: "gemini-3.5-flash-lite" },
  { slug: "groq", model: "openai/gpt-oss-120b" }, { slug: "inception", model: "mercury-3" },
  // 16/11: Cloudflare scout answered in 0.5-1.2 s and handed real work off 3/3 while Gemini and groq were rate limited (probes.md).
  { slug: "cloudflare", model: "@cf/meta/llama-4-scout-17b-16e-instruct" }
] as const;

export { nousModelTier } from "@space/contracts";
/** Space Gateway's pace hold of background work (plan clipboard:DotwYXVD2N3n): today's share of every account's week is used. */
export const NOUS_GATEWAY_PACE_HOLD = /Space Gateway is holding background work|\bPACE_CAP\b/;
/** A route's model for a class (shared with Gateway /pools/space). */
export const routeModel = (models: NousProviderModel[], tier: 1 | 2 | 3): NousProviderModel | null => nousRouteModel(models, tier);

/** The effort itself when the model takes it, else the nearest it takes (the lower on a tie). */
export function nearestEffort(effort: string, efforts: string[]): string {
  if (efforts.includes(effort)) return effort;
  const at = NOUS_EFFORTS.indexOf(effort as typeof NOUS_EFFORTS[number]);
  return [...efforts].sort((a, b) => {
    const [x, y] = [NOUS_EFFORTS.indexOf(a as typeof NOUS_EFFORTS[number]), NOUS_EFFORTS.indexOf(b as typeof NOUS_EFFORTS[number])];
    return Math.abs(x - at) - Math.abs(y - at) || x - y;
  })[0] ?? effort;
}

const attemptOf = (route: SpaceRoute, model: NousProviderModel, effort: string): SpaceAttempt => ({ route: route.route, name: route.name, runtime: route.runtime,
  provider: route.provider, model: model.id, effort: nearestEffort(effort === "auto" ? nousAutoEffort(model.id) : effort, model.efforts), id: `${route.prefix}:${model.id}`, ...(route.free ? { free: true } : {}) });
/** What a choice may use: `free: false` (the operator's, a decision's or a goal turn) leaves the free pools out of auto. */
export type SpaceChoice = { model: string; effort: string; free?: boolean;
  /** The subscription pools with no room for Nous now (NousTokens.noRoom): an auto model tries their routes after the routes that have room. */
  noRoom?: string[];
  /** The operator's turn: a cooling route is tried last, never skipped (Response time 18/11 #4: Argon cooled while it served an inbox turn). */
  lastResort?: boolean };

/** What a choice tries: an explicit model its route only; an auto model each enabled, available route in order. */
export function spaceAttempts(choice: SpaceChoice, routes: SpaceRoute[]): { explicit: boolean; attempts: SpaceAttempt[]; skipped: SpaceRouteFailure[] } {
  const parsed = nousSpaceModel(choice.model);
  if (!parsed) return { explicit: true, attempts: [], skipped: [] };
  if (!("auto" in parsed)) {
    const route = routes.find((entry) => entry.route === parsed.route);
    // An unavailable route lists its models for Settings only; it is skipped with its reason, never tried.
    const served = route?.available ? route.models : [];
    const model = served.find((entry) => entry.id === parsed.model);
    const attempts: SpaceAttempt[] = [];
    const skipped: SpaceRouteFailure[] = [];
    if (route && model) attempts.push(attemptOf(route, model, choice.effort));
    else skipped.push({ route: parsed.route, name: NOUS_SPACE_ROUTES[parsed.route].name, model: parsed.model, kind: "skipped",
      reason: route?.reason ?? "This model is not in the route's catalog now.", resetAt: route?.resetAt ?? null });
    // Gemini Argon automatically fails over to Hydrogen, then to Gemini 3.8 Flash when Argon has no quota
    if (parsed.route === "ANTIGRAVITY") {
      if (parsed.model.includes("argon") || parsed.model.includes("neon")) {
        // 22/11 c74c7453: Argon (or Neon) fails over to Neon, then Hydrogen, before Flash.
        for (const next of [served.find((entry) => /^gemini-\d+-neon\b/.test(entry.id)), served.find((entry) => entry.id.includes("hydrogen"))]) {
          if (route && next && next.id !== model?.id) attempts.push(attemptOf(route, next, choice.effort));
        }
      }
      const flashRoute = routes.find((entry) => entry.route === "ANTIGRAVITY_FLASH" && entry.enabled && entry.available);
      const flashModel = flashRoute ? routeModel(flashRoute.models, nousModelTier(parsed.model)) : null;
      if (flashRoute && flashModel) attempts.push(attemptOf(flashRoute, flashModel, choice.effort));
    }
    const hasFailover = parsed.route === "ANTIGRAVITY" && attempts.length > 1;
    return { explicit: !hasFailover, attempts, skipped };
  }
  const attempts: SpaceAttempt[] = [];
  const skipped: SpaceRouteFailure[] = [];
  for (const route of routes) {
    if (!route.enabled || (route.free && choice.free !== true)) continue;
    const model = route.available ? routeModel(route.models, parsed.auto) : null;
    if (model) attempts.push(attemptOf(route, model, choice.effort));
    else skipped.push({ route: route.route, name: route.name, model: null, kind: "skipped", reason: route.reason ?? "No model for this turn.", resetAt: route.resetAt ?? null });
  }
  // Operator 8/11 (ops's 5-hour window at 4%, Nous still on Opus): a pool past Nous's reserve serves only after the routes that have room.
  const held = (attempt: SpaceAttempt) => choice.noRoom?.includes(attempt.provider) ? 1 : 0;
  return { explicit: false, attempts: attempts.sort((left, right) => held(left) - held(right)), skipped };
}

// A turn that used its time, its steps (wiring.ts NOUS_STEP_LIMIT) or was stopped is not the route's fault.
const TURN_OWN_FAILURE = /no answer within|exceeded the nous turn timeout|(?<!could not be reached, or )the turn was stopped|turn limit|max(?:imum)?[ _-]?turns/i;
export function classifySpaceFailure(message: string): SpaceFailureKind {
  if (TURN_OWN_FAILURE.test(message)) return "other";
  // Daily Nous errors 18/11 (Gemini Flash on Antigravity HTTP 403): that route's refusal, which the next route's own credential does not share.
  // 22/11 (Gemini needs a new sign-in ×26): Antigravity token refresh failure on one route fails over to another route instead of failing the turn.
  if (/returned HTTP 403\b|Gemini needs a new sign-in|The Gemini sign-in file is unavailable|Gemini sign-in could not be refreshed/i.test(message)) return "unavailable";
  if (/\b40[13]\b|unauthori[sz]ed|authentication|invalid (?:x-)?api.?key|forbidden|sign in again|reauth/i.test(message)) return "auth";
  if (NOUS_QUOTA_EXHAUSTED.test(message) || /quota|allowance|budget|insufficient_quota|\b402\b|out of credits/i.test(message)) return "quota";
  if (/rate.?limit|\b429\b|too many requests|overloaded|\b529\b/i.test(message)) return "throttle";
  if (NOUS_GATEWAY_UNREACHABLE.test(message) || /\b50[0234]\b|unavailable|could not be reached|response was interrupted|ECONNRESET|socket hang up|not support this model|selected vpn|handshake_failed|vpn_not_ready/i.test(message)) return "unavailable";
  // Daily Nous errors 18/11 (Claude on Antigravity HTTP 400 ×4, an empty Gemini answer, OpenCode asking for a tool outside Nous): the route's
  // own fault, which the next route does not share, fails over instead of ending the turn.
  if (/returned HTTP 40[04]\b|returned an empty answer|returned no answer content|requested a tool outside Nous/i.test(message)) return "unavailable";
  return "other";
}

/** When a refusal says the route is back, if it says: "back in 2h 13m", "after 00:00 UTC", "next month", "try again in 30s" or a timestamp. */
export function refusalResetAt(message: string, now: number): number | null {
  const back = /back in (?:(\d+)h)? ?(?:(\d+)m)?/i.exec(message);
  if (back && (back[1] || back[2])) return now + (Number(back[1] ?? 0) * 60 + Number(back[2] ?? 0)) * 60_000;
  const again = /try again in (\d+) ?(s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(message);
  if (again) return now + Number(again[1]) * (/^h/i.test(again[2]!) ? 3_600_000 : /^m/i.test(again[2]!) ? 60_000 : 1_000);
  const date = new Date(now);
  if (/after 00:00 UTC/i.test(message)) return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  if (/next month/i.test(message)) return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const stamp = /\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?Z/.exec(message);
  const at = stamp ? Date.parse(stamp[0]) : NaN;
  return Number.isFinite(at) && at > now ? at : null;
}

// Without a reset in the refusal, a pool refusal is probed again after 5 minutes (the Gateway's cached quota may be stale), a throttle or outage after 1.
const QUOTA_PROBE_MS = 5 * 60_000;
const TRANSIENT_MS = 60_000;

/** A route that refused: what, why, and when it is expected back. */
export class SpaceRouteError extends Error {
  constructor(message: string, readonly failures: SpaceRouteFailure[], readonly explicit: boolean) { super(message); }
}

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const describe = (failure: SpaceRouteFailure) => `${failure.model ? nousModelLabel(`${NOUS_SPACE_ROUTES[failure.route].prefix}:${failure.model}`) : failure.name}: `
  + `${clip(failure.reason, 240)}${failure.resetAt ? ` (back about ${failure.resetAt.slice(0, 16).replace("T", " ")} UTC)` : ""}`;

export interface SpaceRunResult { text: string; isError: boolean; costUsd?: number | null; tokens?: Record<string, unknown> | null }
export interface SpaceRunHooks {
  /** Before each attempt: the route about to run and, after a failover, why; returns text to add to the prompt (earlier attempts' tool results). */
  onAttempt?(attempt: SpaceAttempt, index: number, after: SpaceRouteFailure | null): Promise<string> | string;
  /** False when the failed attempt already acted and nothing guards a repeat (a helper's tool calls): then its failure is the answer. */
  mayFailOver?(): boolean;
  signal?: AbortSignal;
}

export function createSpaceRouter(deps: { routes(): Promise<SpaceRoute[]>; now?: () => number }) {
  const now = deps.now ?? Date.now;
  // Per route, never one lock for all: a route cooling down only skips itself.
  const cooling = new Map<GatewayProviderRoute, { until: number; kind: SpaceFailureKind; reason: string; quotaKey?: string }>();
  const coolingOf = (route: GatewayProviderRoute) => {
    const entry = cooling.get(route);
    if (entry && entry.until <= now()) cooling.delete(route);
    return cooling.get(route) ?? null;
  };
  function failed(attempt: SpaceAttempt, text: string, route?: SpaceRoute): SpaceRouteFailure {
    const kind = classifySpaceFailure(text);
    const reset = refusalResetAt(text, now());
    if (kind === "quota" || kind === "throttle" || kind === "unavailable") {
      cooling.set(attempt.route, { until: kind === "quota" ? Math.min(reset ?? Infinity, now() + QUOTA_PROBE_MS) : reset ?? now() + TRANSIENT_MS, kind, reason: text, quotaKey: route?.quota?.key });
    }
    return { route: attempt.route, name: attempt.name, model: attempt.model, kind, reason: text, resetAt: reset === null ? null : new Date(reset).toISOString() };
  }
  const paceHeldApiKey = (attempt: SpaceAttempt) => attempt.route === "CLAUDE_OPENCODE" && NOUS_GATEWAY_PACE_HOLD.test(coolingOf("CLAUDE")?.reason ?? "");
  return {
    /** The first route an auto model may run on now (on, with room, not cooling); null for an explicit model or when none may. */
    async first(choice: SpaceChoice): Promise<SpaceAttempt | null> {
      const plan = spaceAttempts(choice, await deps.routes());
      return plan.explicit ? null : plan.attempts.find((attempt) => !coolingOf(attempt.route) && !paceHeldApiKey(attempt)) ?? null;
    },
    /** A route's cool-down, for the catalog's reasons. */
    cooling: (route: GatewayProviderRoute) => { const entry = coolingOf(route); return entry ? { until: new Date(entry.until).toISOString(), kind: entry.kind, reason: entry.reason } : null; },
    async run<T extends SpaceRunResult>(choice: SpaceChoice, call: (attempt: SpaceAttempt, extraPrompt: string) => Promise<T>, hooks: SpaceRunHooks = {}): Promise<T & { attempt: SpaceAttempt; failures: SpaceRouteFailure[] }> {
      const routes = await deps.routes();
      // Every new turn starts at the configured first route. A fresh cached quota recovery cancels only quota cooldowns,
      // never auth/outage/rate backoff. Unchanged stale "room" cannot repeatedly override a real refusal.
      for (const route of routes) {
        const cool = coolingOf(route.route);
        if (cool?.kind === "quota" && route.quota?.ready && route.quota.key !== cool.quotaKey) cooling.delete(route.route);
      }
      const plan = spaceAttempts(choice, routes);
      const failures: SpaceRouteFailure[] = [...plan.skipped];
      let last: SpaceRouteFailure | null = null;
      const deferred = new Set<SpaceAttempt>();
      // The loop also reaches the attempts it defers to its end.
      for (const [index, attempt] of plan.attempts.entries()) {
        // Operator 6/11 14:10 BKK (step 6): a pace hold is no shortage, so the paid Claude API key never takes Claude Max's held work.
        if (!plan.explicit && paceHeldApiKey(attempt)) {
          failures.push({ route: attempt.route, name: attempt.name, model: attempt.model, kind: "skipped", reason: "Claude Max is only pace-held (its week and 5-hour window have room): the paid Claude API key does not take its work", resetAt: null });
          continue;
        }
        const cool = plan.explicit || deferred.has(attempt) ? null : coolingOf(attempt.route);
        // Argon's own quota/model outage leaves Neon/Hydrogen free; a dead Antigravity sign-in is shared by every model on the route.
        if (cool && !(attempt.route === "ANTIGRAVITY" && /hydrogen|neon/.test(attempt.model) && /argon/i.test(cool.reason) && !/sign-in/i.test(cool.reason))) {
          if (choice.lastResort) { deferred.add(attempt); plan.attempts.push(attempt); continue; }
          failures.push({ route: attempt.route, name: attempt.name, model: attempt.model, kind: "skipped", reason: `cooling down after: ${clip(cool.reason, 200)}`, resetAt: new Date(cool.until).toISOString() });
          continue;
        }
        const extra = await hooks.onAttempt?.(attempt, index, last) ?? "";
        let result: T;
        try {
          result = await call(attempt, extra);
        } catch (error) {
          if (hooks.signal?.aborted) throw error;
          result = { text: error instanceof Error ? error.message : String(error), isError: true } as T;
        }
        if (!result.isError) {
          cooling.delete(attempt.route);
          return { ...result, attempt, failures };
        }
        let text = result.text || "The provider stopped.";
        // 13/11 18:07 UTC (Codex at its usage limit; its CLI said only "exceeded retry limit, last status: 429"): a throttle after which the
        // Gateway shows the route's pool out of quota is that quota.
        if (classifySpaceFailure(text) === "throttle") {
          const after = (await deps.routes().catch(() => [])).find((route) => route.route === attempt.route);
          if (after && !after.available && classifySpaceFailure(after.reason ?? "") === "quota") text = `${text} — ${after.reason}`;
        }
        last = failed(attempt, text, routes.find((route) => route.route === attempt.route));
        failures.push(last);
        // An explicit model is never replaced; the turn's own failure, a refused credential or an attempt that acted unguarded stop here.
        // Stable 13/11 14:31 BKK (Azure gpt-5-mini 401 failed every background turn): a free/granted pool's failure of any kind goes on to the next route.
        // Response time 17/11 and 22/11 (8 operator waits of 9-33 min): a route's unlisted refusal (Argon 404, a lost Gemini sign-in) ended
        // each operator turn before Claude, which served; an operator turn goes on past any route's own refusal and stops only on its own failure.
        const stops = choice.lastResort ? TURN_OWN_FAILURE.test(text) : !attempt.free && (last.kind === "auth" || last.kind === "other");
        if (plan.explicit || stops || hooks.mayFailOver?.() === false) break;
      }
      const kinds = new Set(failures.map((failure) => failure.kind));
      const list = failures.map(describe).join("; ");
      if (plan.explicit) {
        const failure = failures[0];
        const what = failure?.kind === "quota" || failure?.kind === "skipped" ? "quota exhausted or unavailable" : failure?.kind === "auth" ? "credential refused" : "failed";
        throw new SpaceRouteError(`Space provider, explicit model — ${what}: ${list || "no such route"}. An explicit model is never switched; choose an Auto model in Settings → Nous to fail over.`, failures, true);
      }
      // Only routes that ran and failed: a route skipped (off for Nous, no model, cooling down) is no failure of this turn.
      const tried = failures.slice(0, -1).filter((failure) => failure.kind !== "skipped");
      const earlier = tried.length ? ` (earlier: ${tried.map(describe).join("; ")})` : "";
      if (last && (last.kind === "auth" || last.kind === "other")) throw new SpaceRouteError(`${describe(last)}${earlier}`, failures, false);
      if (last && hooks.mayFailOver?.() === false) throw new SpaceRouteError(`${describe(last)} — not retried on another route: this run had already acted.${earlier}`, failures, false);
      if (last && !failures.every((failure) => failure.kind === "quota" || failure.kind === "skipped")) throw new SpaceRouteError(`${describe(last)}${earlier}`, failures, false);
      throw new SpaceRouteError(`Space provider: quota exhausted or unavailable on every enabled route${kinds.size ? "" : " (none is on)"}: ${list || "no route is on in Space Gateway → Settings → Routing"}.`, failures, false);
    }
  };
}
export type SpaceRouter = ReturnType<typeof createSpaceRouter>;
