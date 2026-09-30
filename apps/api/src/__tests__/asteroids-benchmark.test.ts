import { describe, expect, it } from "vitest";
import { fetchModelTactics } from "../benchmark-routes.js";

describe("fetchModelTactics with Jev AI", () => {
  it("rejects cross-mode and fallback metric writes", async () => {
    const fastify = (await import("fastify")).default();
    const { registerBenchmarkRoutes } = await import("../benchmark-routes.js");
    registerBenchmarkRoutes(fastify, {});

    const invalidMode = await fastify.inject({
      method: "POST",
      url: "/api/asteroids/benchmark/record-match",
      payload: {
        mode: "not-a-mode",
        round: 1,
        totalRounds: 1,
        winnerId: "model-a",
        results: [],
      },
    });
    expect(invalidMode.statusCode).toBe(400);

    const fallbackMetrics = await fastify.inject({
      method: "POST",
      url: "/api/asteroids/benchmark/record-match",
      payload: {
        mode: "duel",
        round: 1,
        totalRounds: 1,
        winnerId: "model-a",
        results: [
          { modelId: "model-a", displayName: "A", providerId: "test", score: 10, kills: 1, accuracy: 50, survival: 1, source: "fallback" },
          { modelId: "model-b", displayName: "B", providerId: "test", score: 5, kills: 0, accuracy: 40, survival: 1, source: "fallback" },
        ],
      },
    });
    expect(fallbackMetrics.statusCode).toBe(400);
    await fastify.close();
  });

  it("computes tactical doctrine for openrouter/typesafe/jev-1.13", async () => {
    const tactic = await fetchModelTactics("openrouter/typesafe/jev-1.13", { rocks: 8, difficulty: 4 });
    expect(tactic).toBeDefined();
    expect(tactic.aggression).toBeGreaterThanOrEqual(0.2);
    expect(tactic.aggression).toBeLessThanOrEqual(1.0);
    expect(tactic.mobility).toBeGreaterThanOrEqual(0.3);
    expect(tactic.mobility).toBeLessThanOrEqual(1.0);
    expect(tactic.precision).toBeGreaterThanOrEqual(0.3);
    expect(tactic.precision).toBeLessThanOrEqual(1.0);
    expect(tactic.leadAiming).toBeGreaterThanOrEqual(0.0);
    expect(tactic.leadAiming).toBeLessThanOrEqual(1.0);
    expect(["nearest", "threat", "rocks", "enemies"]).toContain(tactic.targetPreference);
    expect(typeof tactic.tactic).toBe("string");
    expect(tactic.tactic.length).toBeGreaterThan(0);
    // Source should be "model" when live token is present or "fallback" if degraded
    expect(["model", "fallback"]).toContain(tactic.source);
    expect(tactic.latencyMs).toBeGreaterThanOrEqual(0);
  }, 15000);

  it("computes real-time live directive for openrouter/typesafe/jev-1.13", async () => {
    const { fetchModelLiveDirective } = await import("../benchmark-routes.js");
    const directive = await fetchModelLiveDirective("openrouter/typesafe/jev-1.13", {
      distanceToClosestHazard: 85,
      hazardType: "rock",
      hazardAngleDelta: 0.3,
      rocksCount: 8,
      enemiesCount: 2,
      hullHp: 3,
      shieldCharges: 0,
      bombsAvailable: 1,
      isImmune: false,
      speed: 120,
      elapsedSeconds: 10,
    });
    expect(directive).toBeDefined();
    expect(["emergency_dash", "tactical_bomb", "lock_and_fire", "strafe_circle", "breakaway", "full_assault"]).toContain(directive.action);
    expect(typeof directive.radioCallout).toBe("string");
    expect(directive.radioCallout.length).toBeGreaterThan(0);
    expect(directive.latencyMs).toBeGreaterThanOrEqual(0);
  }, 15000);

  it("computes tactical doctrine for codex/gpt-5.6-sol", async () => {
    const tactic = await fetchModelTactics("codex/gpt-5.6-sol", { rocks: 8, difficulty: 4 });
    expect(tactic).toBeDefined();
    expect(tactic.aggression).toBeGreaterThanOrEqual(0.2);
    expect(tactic.aggression).toBeLessThanOrEqual(1.0);
    expect(tactic.mobility).toBeGreaterThanOrEqual(0.3);
    expect(tactic.mobility).toBeLessThanOrEqual(1.0);
    expect(tactic.precision).toBeGreaterThanOrEqual(0.3);
    expect(tactic.precision).toBeLessThanOrEqual(1.0);
    expect(["nearest", "threat", "rocks", "enemies"]).toContain(tactic.targetPreference);
    expect(typeof tactic.tactic).toBe("string");
    expect(tactic.tactic.length).toBeGreaterThan(0);
    expect(["model", "fallback"]).toContain(tactic.source);
  }, 15000);

  it("computes real-time live directive for codex/gpt-5.6-sol", async () => {
    const { fetchModelLiveDirective } = await import("../benchmark-routes.js");
    const directive = await fetchModelLiveDirective("codex/gpt-5.6-sol", {
      distanceToClosestHazard: 75,
      hazardType: "enemy",
      hazardAngleDelta: 0.5,
      rocksCount: 6,
      enemiesCount: 3,
      hullHp: 4,
      shieldCharges: 0,
      bombsAvailable: 1,
      isImmune: false,
      speed: 150,
      elapsedSeconds: 15,
    });
    expect(directive).toBeDefined();
    expect(["emergency_dash", "tactical_bomb", "lock_and_fire", "strafe_circle", "breakaway", "full_assault"]).toContain(directive.action);
    expect(directive.radioCallout).toContain("CODEX");
    expect(directive.latencyMs).toBeGreaterThanOrEqual(0);
  }, 15000);

  it("registers and serves codex models in /api/asteroids/benchmark/models", async () => {
    const fastify = (await import("fastify")).default();
    const { registerBenchmarkRoutes } = await import("../benchmark-routes.js");
    registerBenchmarkRoutes(fastify, {});
    const res = await fastify.inject({ method: "GET", url: "/api/asteroids/benchmark/models" });
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.payload);
    expect(json.models).toBeDefined();
    const codexModels = json.models.filter((m: any) => m.providerId === "codex");
    expect(codexModels.length).toBeGreaterThan(0);
    expect(codexModels.map((m: any) => m.id)).toContain("codex/gpt-5.6-sol");
  });
});
