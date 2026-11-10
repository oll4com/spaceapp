import { describe, expect, it, vi } from "vitest";
import { nousFailureCause, nousFreeRouteAllowed, nousModelLabel, nousModelMatchesProvider, nousSpaceModel } from "@space/contracts";
import { InMemoryNousRepository } from "@space/db";
import { createNousProviderCatalog } from "../src/nous/providers.js";
import { createNousService, type NousRunner } from "../src/nous/service.js";
import { classifySpaceFailure, createSpaceRouter, nearestEffort, refusalResetAt, routeModel, spaceAttempts, SpaceRouteError, type SpaceRoute } from "../src/nous/space-provider.js";
import { turnRunner, withEarlierAttempts } from "../src/nous/wiring.js";

const route = (name: SpaceRoute["route"], provider: SpaceRoute["provider"], prefix: string, models: SpaceRoute["models"], extra: Partial<SpaceRoute> = {}): SpaceRoute =>
  ({ route: name, name, runtime: provider, prefix, provider, enabled: true, available: true, reason: null, models, ...extra });
const claudeModels = [{ id: "claude-fable-5-1", label: "Fable", efforts: ["low", "medium", "high", "xhigh", "max"] }, { id: "claude-opus-5-5", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5-5", label: "Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"] }, { id: "claude-haiku-5-5", label: "Haiku", efforts: ["low", "medium", "high", "xhigh", "max"] }];
const codexModels = [{ id: "gpt-6-astra", label: "Astra", efforts: ["low", "medium", "high", "xhigh"] }, { id: "gpt-6.1-sol", label: "Sol", efforts: ["low", "medium", "high"] }, { id: "gpt-6-luna", label: "Luna", efforts: ["low", "medium"] }];
const argonModels = [{ id: "gemini-4-argon-high", label: "Argon High", efforts: ["none"] }, { id: "gemini-4-argon", label: "Argon", efforts: ["none"] }];
const geminiModels = [{ id: "gemini-3.8-flash-high", label: "Flash High", efforts: ["none"] }, { id: "gemini-3.8-flash-low", label: "Flash Low", efforts: ["none"] }];
const antigravityClaudeModels = ["claude-opus-5-5-low", "claude-opus-5-5-high", "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium"].map((id) => ({ id, label: id, efforts: ["none"] }));
// The operator's order: Claude, Codex, Claude via OpenCode, Gemini Argon, Gemini 3.8 Flash, Claude (Antigravity).
const ROUTES = [route("CLAUDE", "claude", "claude", claudeModels), route("CODEX", "codex", "codex", codexModels),
  route("CLAUDE_OPENCODE", "opencode", "opencode-claude", claudeModels), route("ANTIGRAVITY", "gemini", "gemini", argonModels),
  route("ANTIGRAVITY_FLASH", "gemini", "gemini-flash", geminiModels), route("ANTIGRAVITY_CLAUDE", "gemini", "antigravity-claude", antigravityClaudeModels)];

describe("Space provider: ids, classes and efforts", () => {
  it("reads namespaced and auto ids without touching other providers' slashes", () => {
    expect(nousSpaceModel("codex:gpt-6-astra")).toEqual({ route: "CODEX", model: "gpt-6-astra" });
    expect(nousSpaceModel("gemini:gemini-4-argon")).toEqual({ route: "ANTIGRAVITY", model: "gemini-4-argon" });
    expect(nousSpaceModel("gemini-flash:gemini-3.8-flash-high")).toEqual({ route: "ANTIGRAVITY_FLASH", model: "gemini-3.8-flash-high" });
    expect(nousSpaceModel("antigravity-claude:claude-sonnet-5-5-medium")).toEqual({ route: "ANTIGRAVITY_CLAUDE", model: "claude-sonnet-5-5-medium" });
    expect(nousModelMatchesProvider("antigravity-claude:claude-opus-5-5-high", "space")).toBe(true);
    expect(nousModelMatchesProvider("antigravity-claude:gemini-3.8-flash-high", "space")).toBe(false);
    expect(nousSpaceModel("auto")).toEqual({ auto: 3 });
    expect(nousSpaceModel("qwen/qwen3-coder:free")).toBeNull();
    expect(nousModelMatchesProvider("opencode-claude:claude-opus-5-5", "space")).toBe(true);
    expect(nousModelMatchesProvider("opencode-claude:gpt-6-astra", "space")).toBe(false);
    expect(nousModelMatchesProvider("codex:gpt-6-astra", "codex")).toBe(false);
    expect(nousModelLabel("opencode-claude:claude-opus-5-5")).toBe("Claude Opus 5.5 · Claude via OpenCode");
    expect(nousModelLabel("deepseek/deepseek-v4")).toBe("deepseek/deepseek-v4");
  });

  it("maps a class and an effort onto each route instead of forwarding one provider's model id to another", () => {
    expect(routeModel(claudeModels, 3)?.id).toBe("claude-opus-5-5");
    expect(routeModel(codexModels, 2)?.id).toBe("gpt-6.1-sol");
    expect(routeModel(argonModels, 3)?.id).toBe("gemini-4-argon-high");
    expect(routeModel(geminiModels, 1)?.id).toBe("gemini-3.8-flash-low");
    expect(([3, 2, 1] as const).map((tier) => routeModel(antigravityClaudeModels, tier)?.id)).toEqual(["claude-opus-5-5-high", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-medium"]);
    expect(nearestEffort("max", ["low", "medium", "high", "xhigh"])).toBe("xhigh");
    expect(nearestEffort("high", ["none"])).toBe("none");
    const plan = spaceAttempts({ model: "auto", effort: "max" }, ROUTES);
    expect(plan.explicit).toBe(false);
    expect(plan.attempts.map((attempt) => `${attempt.id}#${attempt.effort}@${attempt.provider}`)).toEqual([
      "claude:claude-opus-5-5#max@claude", "codex:gpt-6-astra#xhigh@codex", "opencode-claude:claude-opus-5-5#max@opencode", "gemini:gemini-4-argon-high#none@gemini", "gemini-flash:gemini-3.8-flash-high#none@gemini",
      "antigravity-claude:claude-opus-5-5-high#none@gemini"]);
  });

  it("takes the free pools after the subscriptions only for background work, with the namespaced id the OpenCode runner needs (nous_msg:d9b67550)", () => {
    const free = route("INCEPTION", "opencode", "inception", [{ id: "mercury-3", label: "mercury-3", efforts: ["low", "medium", "high", "xhigh", "max"] }], { free: true });
    const routes = [...ROUTES, free];
    // The operator's own, a decision's and a goal turn (free not set) never reach a free pool.
    expect(spaceAttempts({ model: "auto", effort: "high" }, routes).attempts.map((attempt) => attempt.route)).toEqual(["CLAUDE", "CODEX", "CLAUDE_OPENCODE", "ANTIGRAVITY", "ANTIGRAVITY_FLASH", "ANTIGRAVITY_CLAUDE"]);
    const background = spaceAttempts({ model: "auto-light", effort: "high", free: true }, routes).attempts;
    expect(background.map((attempt) => attempt.route)).toEqual(["CLAUDE", "CODEX", "CLAUDE_OPENCODE", "ANTIGRAVITY", "ANTIGRAVITY_FLASH", "ANTIGRAVITY_CLAUDE", "INCEPTION"]);
    expect(background.at(-1)).toMatchObject({ id: "inception:mercury-3", provider: "opencode", free: true });
    expect(nousFreeRouteAllowed("INBOX")).toBe(true);
    expect(["OPERATOR", "DECISION", "GOAL"].some(nousFreeRouteAllowed)).toBe(false);
  });

  it("tries the routes of a pool with no room for Nous after those that have room (operator 8/11)", () => {
    expect(spaceAttempts({ model: "auto", effort: "high", noRoom: ["claude", "codex"] }, ROUTES).attempts.map((attempt) => attempt.route))
      .toEqual(["CLAUDE_OPENCODE", "ANTIGRAVITY", "ANTIGRAVITY_FLASH", "ANTIGRAVITY_CLAUDE", "CLAUDE", "CODEX"]);
    // An explicit model keeps its route.
    expect(spaceAttempts({ model: "claude:claude-opus-5-5", effort: "high", noRoom: ["claude"] }, ROUTES).attempts.map((attempt) => attempt.route)).toEqual(["CLAUDE"]);
  });

  it("skips routes that are off or unavailable, and names why", () => {
    const routes = [ROUTES[0]!, { ...ROUTES[1]!, enabled: false }, { ...ROUTES[2]!, available: false, reason: "Today's share of the API budget is used", resetAt: "2026-11-04T00:00:00.000Z", models: [] }, ROUTES[3]!, ROUTES[4]!];
    const plan = spaceAttempts({ model: "auto-balanced", effort: "medium" }, routes);
    expect(plan.attempts.map((attempt) => attempt.id)).toEqual(["claude:claude-sonnet-5-5", "gemini:gemini-4-argon-high", "gemini-flash:gemini-3.8-flash-high"]);
    expect(plan.skipped).toEqual([expect.objectContaining({ route: "CLAUDE_OPENCODE", kind: "skipped", resetAt: "2026-11-04T00:00:00.000Z" })]);
  });

  it("resolves Auto reasoning per route by the model's class (operator 8/11)", () => {
    expect(spaceAttempts({ model: "auto", effort: "auto" }, ROUTES).attempts.map((attempt) => `${attempt.id}#${attempt.effort}`)).toEqual([
      "claude:claude-opus-5-5#xhigh", "codex:gpt-6-astra#xhigh", "opencode-claude:claude-opus-5-5#xhigh", "gemini:gemini-4-argon-high#none", "gemini-flash:gemini-3.8-flash-high#none",
      "antigravity-claude:claude-opus-5-5-high#none"]);
    expect(spaceAttempts({ model: "auto-balanced", effort: "auto" }, ROUTES).attempts[0]).toMatchObject({ id: "claude:claude-sonnet-5-5", effort: "high" });
  });

  it("automatically adds Gemini 3.8 Flash failover when Gemini Argon is selected", () => {
    const plan = spaceAttempts({ model: "gemini:gemini-4-argon-high", effort: "high" }, ROUTES);
    expect(plan.explicit).toBe(false);
    expect(plan.attempts.map((attempt) => attempt.id)).toEqual(["gemini:gemini-4-argon-high", "gemini-flash:gemini-3.8-flash-high"]);

    const codexPlan = spaceAttempts({ model: "codex:gpt-6-astra", effort: "high" }, ROUTES);
    expect(codexPlan.explicit).toBe(true);
    expect(codexPlan.attempts.map((attempt) => attempt.id)).toEqual(["codex:gpt-6-astra"]);
    // An explicit Claude (Antigravity) model runs only on its route.
    expect(spaceAttempts({ model: "antigravity-claude:claude-sonnet-5-5-medium", effort: "none" }, ROUTES).attempts.map((attempt) => attempt.id)).toEqual(["antigravity-claude:claude-sonnet-5-5-medium"]);
  });

  it("tells pool exhaustion, throttles, outages, refused credentials and the turn's own failures apart", () => {
    expect(classifySpaceFailure("All 4 Claude accounts in Space Gateway reached their usage limit. The first one is back in 2h 5m (at 12:40).")).toBe("quota");
    expect(classifySpaceFailure("Claude via OpenCode: quota exhausted (Space Gateway 429: DAILY_ALLOWANCE_REACHED).")).toBe("quota");
    expect(classifySpaceFailure("API Error: 429 rate_limit_error: Too many requests")).toBe("throttle");
    // 4/11 09:42Z: the gateway's fill-first refusal, before and after its text named each account, is a pool without room, not a throttle.
    expect(classifySpaceFailure('API Error: 429 {"error":{"message":"Space Gateway\'s other Claude accounts reached their 5-hour limit; the last one with room is kept '
      + 'for Nous\'s answers to the operator. Try again in a few minutes.","type":"rate_limit_error","code":"usage_limit_reached"}}')).toBe("quota");
    expect(classifySpaceFailure("API Error: 429 rate_limit_error usage_limit_reached")).toBe("quota");
    // The OpenCode runner names the gateway's code: a per-minute key limit is a throttle, a budget stop or spent pool is quota.
    expect(classifySpaceFailure("Claude via OpenCode: rate limited (Space Gateway 429 rate_limit_exceeded: This API key sent too many requests this minute); try again in 12s.")).toBe("throttle");
    expect(classifySpaceFailure("Claude via OpenCode: API budget stop, quota exhausted (Space Gateway 429 DAILY_ALLOWANCE_REACHED: serves again after 00:00 UTC).")).toBe("quota");
    expect(classifySpaceFailure("Claude via OpenCode: quota exhausted (Space Gateway 429 usage_limit_reached: back in 2h 5m).")).toBe("quota");
    expect(classifySpaceFailure("API Error: Connection refused (ECONNREFUSED)")).toBe("unavailable");
    expect(classifySpaceFailure("Gemini could not be reached.")).toBe("unavailable");
    expect(classifySpaceFailure("Gemini could not be reached, or the turn was stopped.")).toBe("unavailable");
    expect(classifySpaceFailure("The Gemini turn was stopped.")).toBe("other");
    expect(classifySpaceFailure("Claude via OpenCode: authentication refused by Space Gateway (401: invalid key).")).toBe("auth");
    expect(classifySpaceFailure("No answer within 20 minutes.")).toBe("other");
    const now = Date.parse("2026-11-03T10:00:00.000Z");
    expect(new Date(refusalResetAt("The first one is back in 2h 5m (at 12:40).", now)!).toISOString()).toBe("2026-11-03T12:05:00.000Z");
    expect(new Date(refusalResetAt("it serves again after 00:00 UTC.", now)!).toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(refusalResetAt("quota exhausted", now)).toBeNull();
  });
});

describe("Space provider router", () => {
  const ok = (attempt: { id: string }) => ({ text: `answered on ${attempt.id}`, isError: false });

  it("runs four routes concurrently: one exhausted pool never blocks the others, and there is no global lock", async () => {
    const router = createSpaceRouter({ routes: async () => ROUTES });
    let running = 0;
    let peak = 0;
    const call = vi.fn(async (attempt: { id: string; route: string }) => {
      running += 1; peak = Math.max(peak, running);
      await new Promise((done) => setTimeout(done, 20));
      running -= 1;
      return attempt.route === "CODEX" ? { text: "Codex: quota exhausted (all accounts used).", isError: true } : ok(attempt);
    });
    const explicit = ["claude:claude-opus-5-5", "codex:gpt-6-astra", "opencode-claude:claude-sonnet-5-5", "gemini:gemini-4-argon-high"];
    const results = await Promise.allSettled(explicit.map((model) => router.run({ model, effort: "high" }, call)));
    expect(peak).toBe(4);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    // The exhausted explicit route is visible, structured and never replaced by another model.
    const refused = (results[1] as PromiseRejectedResult).reason as SpaceRouteError;
    expect(refused).toBeInstanceOf(SpaceRouteError);
    expect(refused.explicit).toBe(true);
    expect(refused.message).toMatch(/explicit model — quota exhausted/);
    expect(refused.failures).toEqual([expect.objectContaining({ route: "CODEX", model: "gpt-6-astra", kind: "quota" })]);
    expect(call).toHaveBeenCalledTimes(4);
    expect(router.cooling("CODEX")?.kind).toBe("quota");
    expect(router.cooling("CLAUDE")).toBeNull();
  });

  it("fails an auto turn over in the Gateway order and reports the route that served it", async () => {
    const router = createSpaceRouter({ routes: async () => ROUTES });
    const seen: string[] = [];
    const call = vi.fn(async (attempt: { id: string; route: string }, extra: string) => {
      seen.push(`${attempt.id}|${extra}`);
      return attempt.route === "CLAUDE" ? { text: "All 4 Claude accounts in Space Gateway reached their usage limit. The first one is back in 1h 10m (at 12:40).", isError: true }
        : attempt.route === "CODEX" ? { text: "API Error: 429 rate_limit_error", isError: true } : ok(attempt);
    });
    const onAttempt = vi.fn(async (_attempt: unknown, index: number) => index ? `earlier ${index}` : "");
    const served = await router.run({ model: "auto", effort: "high" }, call, { onAttempt });
    expect(served.attempt.id).toBe("opencode-claude:claude-opus-5-5");
    expect(served.text).toBe("answered on opencode-claude:claude-opus-5-5");
    expect(served.failures.map((failure) => `${failure.route}:${failure.kind}`)).toEqual(["CLAUDE:quota", "CODEX:throttle"]);
    expect(served.failures[0]!.resetAt).not.toBeNull();
    expect(seen).toEqual(["claude:claude-opus-5-5|", "codex:gpt-6-astra|earlier 1", "opencode-claude:claude-opus-5-5|earlier 2"]);
    // The next auto turn skips the cooling routes at once, without asking them again.
    call.mockClear();
    const next = await router.run({ model: "auto", effort: "high" }, call);
    expect(next.attempt.route).toBe("CLAUDE_OPENCODE");
    expect(call).toHaveBeenCalledTimes(1);
    expect(next.failures.map((failure) => `${failure.route}:${failure.kind}`)).toEqual(["CLAUDE:skipped", "CODEX:skipped"]);
  });

  it("automatically fails over from Gemini Argon to Gemini 3.8 Flash on quota exhaustion and skips cooling Argon next turn", async () => {
    const router = createSpaceRouter({ routes: async () => ROUTES });
    const call = vi.fn(async (attempt: { id: string; route: string }) => {
      if (attempt.route === "ANTIGRAVITY") return { text: "Gemini Argon (Antigravity): Gemini has no available tokens/quota.", isError: true };
      return ok(attempt);
    });
    const served = await router.run({ model: "gemini:gemini-4-argon-high", effort: "high" }, call);
    expect(served.attempt.id).toBe("gemini-flash:gemini-3.8-flash-high");
    expect(served.text).toBe("answered on gemini-flash:gemini-3.8-flash-high");
    expect(served.failures.map((f) => `${f.route}:${f.kind}`)).toEqual(["ANTIGRAVITY:quota"]);
    expect(call).toHaveBeenCalledTimes(2);

    // The next turn skips cooling Argon immediately and runs on Flash without calling Argon
    call.mockClear();
    const next = await router.run({ model: "gemini:gemini-4-argon-high", effort: "high" }, call);
    expect(next.attempt.id).toBe("gemini-flash:gemini-3.8-flash-high");
    expect(next.failures.map((f) => `${f.route}:${f.kind}`)).toEqual(["ANTIGRAVITY:skipped"]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("never fails a pace-held Claude Max over to the paid API-key route, this turn or the next (operator 6/11)", async () => {
    const router = createSpaceRouter({ routes: async () => ROUTES });
    const call = vi.fn(async (attempt: { id: string; route: string }) => attempt.route === "CLAUDE"
      ? { text: "Space Gateway is holding background work: every account used today's share of its week (used today/allowance: 30%/14%).", isError: true }
      : attempt.route === "CODEX" ? { text: "Codex: quota exhausted (all accounts used).", isError: true } : ok(attempt));
    for (let turn = 0; turn < 2; turn += 1) {
      const served = await router.run({ model: "auto", effort: "high" }, call);
      expect(served.attempt.route).toBe("ANTIGRAVITY");
      expect(served.failures.find((failure) => failure.route === "CLAUDE_OPENCODE")).toMatchObject({ kind: "skipped", reason: expect.stringMatching(/pace-held/) });
    }
    expect(call.mock.calls.some(([attempt]) => attempt.route === "CLAUDE_OPENCODE")).toBe(false);
  });

  it("returns from Codex to Claude on changed cached room, without retrying an unchanged refusal", async () => {
    let quota = { ready: true, key: "before-refusal" };
    const router = createSpaceRouter({ routes: async () => [{ ...ROUTES[0]!, quota }, ROUTES[1]!] });
    let recovered = false;
    const calls: string[] = [];
    const call = async (attempt: { route: string; id: string }) => {
      calls.push(attempt.route);
      return attempt.route === "CLAUDE" && !recovered ? { text: "usage limit reached; back in 2h", isError: true } : ok(attempt);
    };
    expect((await router.run({ model: "auto", effort: "high" }, call)).attempt.route).toBe("CODEX");
    expect((await router.run({ model: "auto", effort: "high" }, call)).attempt.route).toBe("CODEX");
    expect(calls).toEqual(["CLAUDE", "CODEX", "CODEX"]);
    recovered = true;
    quota = { ready: true, key: "account-reset" };
    expect((await router.run({ model: "auto", effort: "high" }, call)).attempt.route).toBe("CLAUDE");
    expect(calls.at(-1)).toBe("CLAUDE");
  });

  it("bounds a long quota refusal to a five-minute retry, but preserves throttle backoff", async () => {
    let time = Date.parse("2026-11-04T00:00:00Z");
    const router = createSpaceRouter({ now: () => time, routes: async () => ROUTES.slice(0, 2) });
    let recovered = false;
    const call = async (attempt: { route: string; id: string }) => attempt.route === "CLAUDE" && !recovered
      ? { text: "usage limit reached; back in 2h", isError: true } : ok(attempt);
    await router.run({ model: "auto", effort: "high" }, call);
    recovered = true; time += 300_000;
    expect((await router.run({ model: "auto", effort: "high" }, call)).attempt.route).toBe("CLAUDE");
    expect(router.cooling("CLAUDE")).toBeNull();
  });

  it("keeps transient backoff even when cached room changes", async () => {
    let key = "first";
    const router = createSpaceRouter({ routes: async () => [{ ...ROUTES[0]!, quota: { ready: true, key } }, ROUTES[1]!] });
    const call = vi.fn(async (attempt: { route: string; id: string }) => attempt.route === "CLAUDE"
      ? { text: "429 rate_limit_error: try again in 60s", isError: true } : ok(attempt));
    await router.run({ model: "auto", effort: "high" }, call);
    key = "reset"; call.mockClear();
    expect((await router.run({ model: "auto", effort: "high" }, call)).attempt.route).toBe("CODEX");
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("stops on a refused credential, on the turn's own failure, and on a helper that already acted", async () => {
    const auth = createSpaceRouter({ routes: async () => ROUTES });
    const authCall = vi.fn(async () => ({ text: "authentication refused (401)", isError: true }));
    await expect(auth.run({ model: "auto", effort: "high" }, authCall)).rejects.toThrow(/401/);
    expect(authCall).toHaveBeenCalledTimes(1);
    const acted = createSpaceRouter({ routes: async () => ROUTES });
    const actedCall = vi.fn(async () => ({ text: "quota exhausted", isError: true }));
    await expect(acted.run({ model: "auto", effort: "high" }, actedCall, { mayFailOver: () => false })).rejects.toThrow(/had already acted/);
    expect(actedCall).toHaveBeenCalledTimes(1);
  });

  it("waits cleanly when every enabled route is exhausted: a quota refusal naming each route, never a claim of capacity", async () => {
    const router = createSpaceRouter({ routes: async () => ROUTES });
    const error = await router.run({ model: "auto", effort: "high" }, async () => ({ text: "usage limit reached", isError: true })).catch((caught: unknown) => caught as SpaceRouteError);
    expect(error).toBeInstanceOf(SpaceRouteError);
    expect(error.message).toMatch(/quota exhausted or unavailable on every enabled route/);
    expect(error.failures.map((failure) => failure.route)).toEqual(["CLAUDE", "CODEX", "CLAUDE_OPENCODE", "ANTIGRAVITY", "ANTIGRAVITY_FLASH", "ANTIGRAVITY_CLAUDE"]);
  });

  it("does not put Nous in WAITING_QUOTA when an earlier route lacked quota and the serving route failed for another reason", async () => {
    const owner = "user:operator";
    const repository = new InMemoryNousRepository();
    const router = createSpaceRouter({ routes: async () => [
      { ...ROUTES[1]!, available: false, reason: "Its Space Gateway accounts are paused or out of quota.", resetAt: "2026-11-04T15:35:00.000Z", models: [] },
      { ...ROUTES[2]!, available: false, reason: "Today's share of the API budget is used ($18.27 of $17.13); back after 00:00 UTC.", models: [] },
      ROUTES[0]!, ROUTES[3]!] });
    const raise = vi.fn(async () => ({}) as never);
    let mode: "LOW" | "CRITICAL" = "LOW";
    const service = createNousService({
      repository,
      runner: async (input) => {
        mode = "CRITICAL";
        const served = await router.run({ model: "auto-balanced", effort: "medium" }, async (attempt) => {
          input.onModel?.(attempt.id, attempt.effort);
          return attempt.route === "CLAUDE"
            ? { text: "Claude Code has no available tokens/quota right now: the account quota is exhausted.", isError: true }
            : { text: "Gemini could not be reached, or the turn was stopped.", isError: true };
        });
        return { ...served, model: served.attempt.id, effort: served.attempt.effort };
      },
      tools: { execute: vi.fn(async () => ({ ok: true, display: "ok", result: "ok" })) },
      world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }) as never,
      tokenMode: async () => mode,
      saveSettings: async (_owner, value) => value,
      notifications: { raise, resolve: vi.fn(async () => 0) } as never,
      executeAction: vi.fn(async () => "ok")
    });
    expect(await service.standing(owner, "STANDING", "# Standing orders\n\n## Finished panes")).toBe("STARTED");
    await service.idle(owner);
    const state = await service.state(owner);
    expect(state.status).toBe("IDLE");
    expect(state.lastError).toMatch(/^gemini-4-argon-high · Gemini Argon \(Antigravity\): Gemini could not be reached.*\(earlier: /);
    expect(raise).not.toHaveBeenCalled();
    const [facts] = await repository.listTurnFacts(owner, "2000-01-01T00:00:00.000Z");
    expect(facts?.model).toBe("gemini:gemini-4-argon-high");
    expect(nousFailureCause(facts!)).toBe("other");
  });

  it("keeps the earlier attempt's calls inside the prompt's technical bound", () => {
    expect(withEarlierAttempts("prompt", "")).toBe("prompt");
    expect(withEarlierAttempts("prompt", "earlier")).toBe("prompt\n\nearlier");
    const long = withEarlierAttempts("p".repeat(149_000), "e".repeat(5_000));
    expect(long.length).toBeLessThanOrEqual(150_000);
    expect(long).toContain("cut here to fit");
  });
});

describe("Space provider catalog", () => {
  it("lists every route's models under its route, auto models first, and the routes in the Gateway order", async () => {
    const loader = (models: Array<{ id: string; label: string; efforts: string[] }>) => vi.fn(async () => models);
    const catalog = createNousProviderCatalog({
      listAccounts: async () => ({ data: [{ provider: "CLAUDE", status: "ACTIVE", planType: "max" }, { provider: "CLAUDE", status: "ACTIVE", planType: "api" },
        { provider: "CODEX", status: "QUOTA_EXCEEDED", planType: "pro", primaryWindow: { resetAt: "2999-01-01T00:00:00.000Z" } }, { provider: "ANTIGRAVITY", status: "ACTIVE", planType: "pro" }] }),
      modelLoaders: { claude: loader(claudeModels.slice(1, 2)), codex: loader(codexModels), gemini: loader([...argonModels.slice(0, 1), ...geminiModels.slice(0, 1), ...antigravityClaudeModels.slice(3)]) },
      providerOrder: async () => [{ route: "CLAUDE", enabled: true }, { route: "CODEX", enabled: true }, { route: "CLAUDE_OPENCODE", enabled: true }, { route: "ANTIGRAVITY", enabled: true },
        { route: "ANTIGRAVITY_FLASH", enabled: true }, { route: "ANTIGRAVITY_CLAUDE", enabled: true }]
    });
    const space = (await catalog.list()).find((provider) => provider.id === "space")!;
    expect(space.available).toBe(true);
    expect(space.models.map((model) => model.id)).toEqual(["auto", "auto-balanced", "auto-light", "claude:claude-opus-5-5", "gemini:gemini-4-argon-high", "gemini-flash:gemini-3.8-flash-high",
      "antigravity-claude:claude-sonnet-5-5-medium"]);
    // The Gemini provider itself keeps its Gemini models; Antigravity's Claude models are their own route.
    expect((await catalog.list()).find((provider) => provider.id === "gemini")!.models.map((model) => model.id)).toEqual(["gemini-4-argon-high", "gemini-3.8-flash-high"]);
    expect(space.routes!.map((entry) => `${entry.route}:${entry.enabled}:${entry.available}`)).toEqual(["CLAUDE:true:true", "CODEX:true:false", "CLAUDE_OPENCODE:true:false",
      "ANTIGRAVITY:true:true", "ANTIGRAVITY_FLASH:true:true", "ANTIGRAVITY_CLAUDE:true:true"]);
    expect(space.routes![1]).toMatchObject({ reason: expect.stringContaining("out of quota"), resetAt: "2999-01-01T00:00:00.000Z" });
    await expect(catalog.validate({ provider: "space", model: "auto", effort: "high" })).resolves.toBeUndefined();
    await expect(catalog.validate({ provider: "space", model: "codex:gpt-6-astra", effort: "high" })).rejects.toThrow(/not available/);
  });

  it("reconsiders a quota-limited account at its cached reset, respecting weekly exhaustion and pauses", async () => {
    let time = Date.parse("2026-11-04T00:00:00Z");
    const account = { provider: "CLAUDE", status: "RATE_LIMITED", planType: "max", primaryWindow: { usedPercent: 100, resetAt: "2026-11-04T00:01:00Z" },
      secondaryWindow: { usedPercent: 50, resetAt: "2026-11-07T00:00:00Z" } };
    const loader = vi.fn(async () => claudeModels);
    const catalog = createNousProviderCatalog({ now: () => time, listAccounts: async () => ({ data: [account] }), modelLoaders: { claude: loader } });
    expect((await catalog.routes())[0]!.available).toBe(false);
    time += 60_000;
    expect((await catalog.routes())[0]).toMatchObject({ available: true, quota: { ready: true } });
    expect(loader).toHaveBeenCalledTimes(1);
    account.secondaryWindow.usedPercent = 100;
    expect((await catalog.routes())[0]!.available).toBe(false);
    account.secondaryWindow.usedPercent = 50; account.status = "PAUSED";
    expect((await catalog.routes())[0]!.available).toBe(false);
  });

  it("keeps the Claude via OpenCode route off for Nous even with an active API key (operator decision 8/11)", async () => {
    const claude = vi.fn(async () => claudeModels);
    const catalog = createNousProviderCatalog({
      listAccounts: async () => ({ data: [{ provider: "CLAUDE", status: "ACTIVE", planType: "api" }] }),
      modelLoaders: { claude }
    });
    const routes = await catalog.routes();
    expect(routes.find((entry) => entry.route === "CLAUDE_OPENCODE")).toMatchObject({ available: false, models: [], reason: expect.stringContaining("never spent by Nous") });
    expect(claude).not.toHaveBeenCalled();
  });
});

describe("Space provider failover inside a Nous turn", () => {
  it("never runs a side effect twice: the next route gets the earlier call's answer and its prompt lists it", async () => {
    const owner = "user:operator";
    const repository = new InMemoryNousRepository();
    const execute = vi.fn(async (name: string) => ({ ok: true, display: `did ${name}`, result: `sent to pane Alex` }));
    const seen: Array<{ extra: string; again: { display: string } }> = [];
    const late: { service?: ReturnType<typeof createNousService> } = {};
    const runner: NousRunner = async (input) => {
      const service = late.service!;
      input.onModel?.("codex:gpt-6-astra", "high");
      expect((await service.state(owner)).execution).toMatchObject({ model: "codex:gpt-6-astra", phase: "starting" });
      input.onText?.({ text: "Working" });
      expect((await service.state(owner)).execution).toMatchObject({ phase: "responding" });
      await service.replyNow(owner, input.turnId, "Working on it.");
      await input.onAttempt!({ index: 0, label: "Claude Opus 5.5 · Claude (high) on Claude Code", after: null });
      expect(input.acted!()).toBe(false);
      await service.callTool(owner, input.turnId, "space_send_to_pane", { pane: "Alex", text: "go" }, "toolu_1");
      // The attempt acted, so the turn runner refuses to fail over (Kate E-3); below the service's second guard alone, as if it had.
      expect(input.acted!()).toBe(true);
      const extra = await input.onAttempt!({ index: 1, label: "GPT-6 Astra · Codex (high) on Codex", after: "All Claude accounts reached their usage limit." });
      expect(input.acted!()).toBe(false);
      const again = await service.callTool(owner, input.turnId, "space_send_to_pane", { pane: "Alex", text: "go" }, "toolu_2");
      const fresh = await service.callTool(owner, input.turnId, "space_send_to_pane", { pane: "Alex", text: "and report" }, "toolu_3");
      seen.push({ extra, again });
      expect(fresh.display).toBe("did space_send_to_pane");
      return { text: "Sent.", isError: false, model: "codex:gpt-6-astra", effort: "high" };
    };
    const service = late.service = createNousService({
      repository, runner, tools: { execute },
      world: async () => ({ text: "# The world now", overview: { plans: [], needsHands: [], trains: "", planMap: null } }),
      settings: async () => ({ enabled: true, maxTurnsPerHour: 20 }) as never,
      saveSettings: async (_owner, value) => value,
      notifications: { raise: vi.fn(async () => ({}) as never), resolve: vi.fn(async () => 0) } as never,
      executeAction: vi.fn(async () => "ok")
    });
    await service.send(owner, "Tell Alex to go.", { person: true });
    await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 15_000 });
    await service.idle(owner);
    expect(execute).toHaveBeenCalledTimes(2);
    expect((await service.state(owner)).execution).toMatchObject({ model: "codex:gpt-6-astra", phase: "completed" });
    const answers = (await repository.listMessages(owner, 50, 50)).filter((entry) => entry.kind === "ANSWER");
    expect(answers.length).toBeGreaterThanOrEqual(2);
    expect(answers.every((entry) => entry.meta.model === "codex:gpt-6-astra")).toBe(true);
    expect(seen[0]!.again.display).toContain("done by the earlier attempt; not run again");
    expect(seen[0]!.extra).toContain('space_send_to_pane {"pane":"Alex","text":"go"} → done: sent to pane Alex');
    const steps = (await repository.listMessages(owner, 50, 50)).map((message) => message.content);
    expect(steps).toContain("Provider: Claude Opus 5.5 · Claude (high) on Claude Code");
    expect(steps).toContain("Provider: GPT-6 Astra · Codex (high) on Codex (the earlier route refused: All Claude accounts reached their usage limit.)");
  }, 30_000);
});

describe("R54-a: an operator turn never dies on one pool or on its step limit (3/11 05:51, 05:54, 07:07 and 10:01 UTC)", () => {
  const options = { config: { cliApiBaseUrl: "https://space.example:4911" }, apiBaseUrl: "https://space.example:4911", auth: { sessionSecret: "s".repeat(64) } } as never;
  const turn = (reason: string) => ({ owner: "user:operator", turnId: "nous_turn:0123456789abcdef01234567", reason, system: "You are Nous.", prompt: "Do it.",
    onAttempt: vi.fn(async (attempt: { index: number; label: string; after: string | null }) => `earlier attempts before ${attempt.index}`), acted: () => false }) as never;
  const backendOf = (answers: Array<{ text: string; isError: boolean }>) => {
    const run = vi.fn<(request: { provider: string; model: string; prompt: string }) => Promise<{ text: string; isError: boolean; costUsd: null; tokens: null }>>(
      async () => ({ ...answers.shift()!, costUsd: null, tokens: null }));
    return { run, backend: { run, unavailable: async () => null } as never };
  };
  const router = () => createSpaceRouter({ routes: async () => [{ ...ROUTES[0]!, available: false, reason: "No active Claude subscription account. Claude API credits do not serve Nous." },
    ...ROUTES.slice(1)] });

  it("a direct provider with no account runs the operator's turn once on the next pool with room; other turns keep the hold", async () => {
    const noAccount = async () => { throw new Error("No active Claude subscription account. Claude API credits do not serve Nous."); };
    const { run, backend } = backendOf([{ text: "Answered on Codex.", isError: false }]);
    const operator = turn("OPERATOR");
    const served = await turnRunner(options, backend, noAccount as never, async () => false, async () => false, router())(operator, new AbortController().signal);
    expect(served).toMatchObject({ text: "Answered on Codex.", model: "codex:gpt-6-astra" });
    expect(run.mock.calls[0]![0]).toMatchObject({ provider: "codex", model: "gpt-6-astra" });
    expect((operator as { onAttempt: ReturnType<typeof vi.fn> }).onAttempt).toHaveBeenCalledWith(expect.objectContaining({ index: 0,
      after: "No active Claude subscription account. Claude API credits do not serve Nous." }));
    await expect(turnRunner(options, backendOf([]).backend, noAccount as never, async () => false, async () => false, router())(turn("INBOX"), new AbortController().signal))
      .rejects.toThrow("No active Claude subscription account");
    // A direct provider that refuses for quota while running moves the same way.
    const pick = async () => ({ provider: "claude" as const, model: "claude-opus-5-5", effort: "high", fallbackModel: null });
    const quota = backendOf([{ text: "All Claude accounts reached their usage limit.", isError: true }, { text: "Answered on Codex.", isError: false }]);
    expect(await turnRunner(options, quota.backend, pick as never, async () => false, async () => false, router())(turn("DECISION"), new AbortController().signal))
      .toMatchObject({ text: "Answered on Codex.", model: "codex:gpt-6-astra" });
    // A Space provider explicit model that exhausts quota moves to auto on an operator turn.
    const spacePick = async () => ({ provider: "space" as const, model: "codex:gpt-6-astra", effort: "high", fallbackModel: null });
    const spaceQuota = backendOf([{ text: "Codex: quota exhausted.", isError: true }, { text: "Answered on Claude via OpenCode.", isError: false }]);
    expect(await turnRunner(options, spaceQuota.backend, spacePick as never, async () => false, async () => false, router())(turn("OPERATOR"), new AbortController().signal))
      .toMatchObject({ text: "Answered on Claude via OpenCode.", model: "opencode-claude:claude-opus-5-5" });
  });

  it("an operator turn that used its steps goes on once on the same route with what it did; a standing turn does not", async () => {
    const pick = async () => ({ provider: "codex" as const, model: "gpt-6-astra", effort: "high", fallbackModel: null });
    const { run, backend } = backendOf([{ text: "Codex stopped at the Nous turn limit.", isError: true }, { text: "Finished.", isError: false }]);
    const operator = turn("OPERATOR");
    expect(await turnRunner(options, backend, pick as never, async () => false)(operator, new AbortController().signal)).toMatchObject({ text: "Finished.", isError: false });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toMatchObject({ provider: "codex", model: "gpt-6-astra", prompt: "Do it.\n\nearlier attempts before 1" });
    expect((operator as { onAttempt: ReturnType<typeof vi.fn> }).onAttempt).toHaveBeenCalledWith({ index: 1, label: "GPT-6 Astra (high), continued after its step limit",
      after: "Codex stopped at the Nous turn limit." });
    const standing = backendOf([{ text: "Codex stopped at the Nous turn limit.", isError: true }]);
    expect(await turnRunner(options, standing.backend, pick as never, async () => false)(turn("STANDING"), new AbortController().signal)).toMatchObject({ isError: true });
    expect(standing.run).toHaveBeenCalledTimes(1);
  });

  it("an auto turn that used its steps goes on on the first route with room now (6/11 10:00 UTC: Gemini went on after Claude Max came back)", async () => {
    let claudeBack = false;
    const space = createSpaceRouter({ routes: async () => [claudeBack ? ROUTES[0]! : { ...ROUTES[0]!, available: false, reason: "No active Claude subscription account." },
      { ...ROUTES[1]!, enabled: false }, { ...ROUTES[2]!, enabled: false }, ROUTES[3]!] });
    const pick = async () => ({ provider: "space" as const, model: "auto", effort: "high", fallbackModel: null });
    const run = vi.fn(async (request: { provider: string }) => {
      claudeBack = true;
      return request.provider === "gemini" ? { text: "Gemini Nous reached its turn limit.", isError: true, costUsd: null, tokens: null } : { text: "Finished.", isError: false, costUsd: null, tokens: null };
    });
    const operator = turn("OPERATOR");
    expect(await turnRunner(options, { run, unavailable: async () => null } as never, pick as never, async () => false, async () => false, space)(operator, new AbortController().signal))
      .toMatchObject({ text: "Finished.", model: "claude:claude-opus-5-5" });
    expect(run.mock.calls.map(([request]) => request.provider)).toEqual(["gemini", "claude"]);
    expect((operator as { onAttempt: ReturnType<typeof vi.fn> }).onAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
      label: "Claude Opus 5.5 · Claude (high) on claude, continued after its step limit" }));
  });

  it("a turn the CLI broker could not start runs again on the same Claude route after a short wait; one that acted is not repeated", async () => {
    const pick = async () => ({ provider: "claude" as const, model: "claude-opus-5-5", effort: "xhigh", fallbackModel: null });
    const broker = '{"code":"BROKER_FAILED","message":"The protected CLI VPN operation failed (Error EAGAIN spawn /usr/bin/ip)."}';
    const run = vi.fn().mockRejectedValueOnce(new Error(broker)).mockResolvedValueOnce({ text: "Answered.", isError: false, costUsd: null, tokens: null });
    const started = Date.now();
    expect(await turnRunner(options, { run, unavailable: async () => null } as never, pick as never, async () => false)(turn("INBOX"), new AbortController().signal))
      .toMatchObject({ text: "Answered.", model: "claude:claude-opus-5-5" });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    const actedRun = vi.fn().mockRejectedValue(new Error(broker));
    await expect(turnRunner(options, { run: actedRun, unavailable: async () => null } as never, pick as never, async () => false)(
      { ...(turn("INBOX") as object), acted: () => true } as never, new AbortController().signal)).rejects.toThrow("BROKER_FAILED");
    expect(actedRun).toHaveBeenCalledTimes(1);
  });
});
