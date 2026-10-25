import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBenchmarkRoutes } from "../benchmark-routes.js";
import { naiveCommand, scriptedBaselineCommand } from "../asteroids-arena/protocol.js";
import { ProviderFailure, type AgentRequester } from "../asteroids-arena/providers.js";
import { ArenaBenchmarkRunner, ArenaRunError } from "../asteroids-arena/runner.js";
import { createArenaFileStore, leaderboardView, type ArenaStore } from "../asteroids-arena/store.js";

let dir: string;
let store: ArenaStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-arena-"));
  store = createArenaFileStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fakeModels: AgentRequester = async (request) => {
  await new Promise((resolve) => setTimeout(resolve, 2));
  switch (request.modelId) {
    case "fake/smart":
      return { text: `\`\`\`json\n${JSON.stringify(scriptedBaselineCommand(request.snapshot))}\n\`\`\``, tokens: 120 };
    case "fake/naive":
      return { text: JSON.stringify(naiveCommand(request.snapshot)) };
    case "fake/prose":
      return { text: "I would carefully attack the closest rock." };
    case "fake/quota":
      return { text: "You've hit your session limit · resets 10:30am" };
    case "fake/down":
      throw new ProviderFailure("error", "provider offline");
    default:
      throw new ProviderFailure("error", `unknown model ${request.modelId}`);
  }
};

describe("ArenaBenchmarkRunner", () => {
  it("runs a championship, skips unavailable providers and scores every decision", async () => {
    const runner = new ArenaBenchmarkRunner({ store, requester: fakeModels });
    runner.start({
      mode: "championship",
      rounds: 2,
      pace: false,
      seed: 99,
      origin: "cli",
      contestants: [
        { id: "fake/smart", displayName: "Smart" },
        { id: "fake/naive", displayName: "Naive" },
        { id: "fake/prose", displayName: "Prose" },
        { id: "fake/quota", displayName: "Quota" },
        { id: "fake/down", displayName: "Down" },
        { id: "baseline/scripted-pilot" }
      ]
    });
    const run = await runner.done!;
    expect(run.status).toBe("completed");
    expect(run.skipped.map((entry) => entry.id).sort()).toEqual(["fake/down", "fake/quota"]);
    expect(run.contestants.map((contestant) => contestant.id)).toEqual(["fake/smart", "fake/naive", "fake/prose", "baseline/scripted-pilot"]);
    expect(run.rounds).toHaveLength(2);
    for (const round of run.rounds) {
      const byId = Object.fromEntries(round.results.map((result) => [result.contestantId, result]));
      // Same policy, same seed: the smart model and the baseline fly identical rounds.
      expect(byId["fake/smart"]!.score).toBe(byId["baseline/scripted-pilot"]!.score);
      expect(byId["fake/smart"]!.decisions.ok).toBe(byId["fake/smart"]!.decisions.total);
      expect(byId["fake/smart"]!.tokens).toBeGreaterThan(0);
      expect(byId["fake/prose"]!.decisions.invalid).toBe(byId["fake/prose"]!.decisions.total);
      expect(round.decisions["fake/prose"]![0]).toMatchObject({ outcome: "invalid", reason: "no JSON object in the reply", command: "coast" });
      expect(byId["fake/prose"]!.score).toBeLessThan(byId["fake/naive"]!.score);
      const bestModel = [...round.results].filter((result) => result.contestantId !== "baseline/scripted-pilot").sort((left, right) => left.rank - right.rank)[0]!;
      expect(round.bestModelId).toBe(bestModel.contestantId);
      expect(round.winnerId).toBe(round.results.find((result) => result.rank === 1)!.contestantId);
    }
    const average = (id: string) => run.rounds.reduce((sum, round) => sum + round.results.find((result) => result.contestantId === id)!.score, 0) / run.rounds.length;
    const expectedChampion = ["fake/smart", "fake/naive", "fake/prose"].sort((left, right) => average(right) - average(left))[0];
    expect(run.championId).toBe(expectedChampion);
    const saved = JSON.parse(await readFile(join(dir, "runs", `${run.id}.json`), "utf8"));
    expect(saved.status).toBe("completed");
    const board = leaderboardView(await store.loadLeaderboard("championship"), "championship");
    expect(board.roundsRecorded).toBe(2);
    expect(board.championId).toBe(expectedChampion);
    const smart = board.rows.find((row) => row.id === "fake/smart")!;
    expect(smart.validRate).toBe(100);
    expect(smart.vsBaseline).toBe(0);
    expect(board.rows.find((row) => row.id === "fake/prose")!.validRate).toBe(0);
    expect(board.rows.find((row) => row.id === "baseline/scripted-pilot")!.reference).toBe(true);
    expect(await store.listRuns("championship", 5)).toMatchObject([{ id: run.id, championName: "Smart", roundsPlayed: 2 }]);
  });

  it("streams frames and events for live viewers", async () => {
    const runner = new ArenaBenchmarkRunner({ store, requester: fakeModels });
    runner.start({ mode: "shared_arena", rounds: 1, pace: false, seed: 5, contestants: [{ id: "fake/smart" }, { id: "fake/naive" }, { id: "baseline/scripted-pilot" }] });
    const run = await runner.done!;
    const live = runner.liveSince(-1);
    expect(live.run?.status).toBe("completed");
    expect(live.run?.championId).toBe(run.championId);
    expect(live.frames.length).toBeGreaterThan(0);
    expect(live.frames.at(-1)!.arenas).toHaveLength(1);
    expect(live.frames.at(-1)!.arenas[0]!.s).toHaveLength(3);
    expect(live.events.some((event) => event.kind === "round")).toBe(true);
    expect(runner.liveSince(live.latestSeq).frames).toHaveLength(0);
    const placements = run.rounds[0]!.results.map((result) => result.placement).sort();
    expect(placements).toEqual([1, 2, 3]);
  });

  it("plays the real-time duel without waiting for slow models", async () => {
    const slow: AgentRequester = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, request.modelId === "fake/slow" ? 40 : 1));
      return { text: JSON.stringify(scriptedBaselineCommand(request.snapshot)) };
    };
    const runner = new ArenaBenchmarkRunner({ store, requester: slow, realtimeTickMs: 1 });
    runner.start({ mode: "duel", rounds: 1, contestants: [{ id: "fake/fast" }, { id: "fake/slow" }] });
    const run = await runner.done!;
    const results = Object.fromEntries(run.rounds[0]!.results.map((result) => [result.contestantId, result]));
    expect(run.config.realtime).toBe(true);
    expect(results["fake/fast"]!.decisions.total).toBeGreaterThan(results["fake/slow"]!.decisions.total);
  });

  it("counts a real-time pilot that never answered before its ship was destroyed", async () => {
    const calls = new Map<string, number>();
    // Preflight answers for everyone. "fake/silent" never answers in the round; "fake/stalls" answers once, then hangs.
    const stalled: AgentRequester = (request) => {
      const count = (calls.get(request.modelId) ?? 0) + 1;
      calls.set(request.modelId, count);
      const hang = (request.modelId === "fake/silent" && count > 1) || (request.modelId === "fake/stalls" && count > 2);
      return hang
        ? new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new ProviderFailure("timeout", "aborted"))))
        : Promise.resolve({ text: JSON.stringify(scriptedBaselineCommand(request.snapshot)) });
    };
    const runner = new ArenaBenchmarkRunner({ store, requester: stalled, realtimeTickMs: 1, decisionTimeoutMs: 60_000 });
    runner.start({ mode: "duel", rounds: 1, contestants: [{ id: "fake/silent" }, { id: "fake/stalls" }] });
    const run = await runner.done!;
    const result = (id: string) => run.rounds[0]!.results.find((entry) => entry.contestantId === id)!;
    expect(result("fake/silent").destroyed).toBe(true);
    expect(result("fake/silent").decisions).toMatchObject({ total: 1, timeout: 1 });
    expect(run.rounds[0]!.decisions["fake/silent"]![0]).toMatchObject({ outcome: "timeout", reason: expect.stringContaining("before the ship was destroyed") });
    // An answer cut off by the destruction after earlier commands flew is not a model failure.
    expect(result("fake/stalls").decisions).toMatchObject({ total: 1, ok: 1, timeout: 0 });
  });

  it("flies Claude on the account with the most quota left unless the run names one", async () => {
    const accounts = new Map<string, Set<string>>();
    const recording: AgentRequester = async (request) => {
      const seen = accounts.get(request.modelId) ?? new Set<string>();
      seen.add(request.claudeAccount ?? "none");
      accounts.set(request.modelId, seen);
      return { text: JSON.stringify(scriptedBaselineCommand(request.snapshot)) };
    };
    const runner = new ArenaBenchmarkRunner({ store, requester: recording, claudeProfile: async () => "crew" });
    runner.start({ mode: "championship", rounds: 1, pace: false, contestants: [{ id: "claude/claude-haiku-5-5" }, { id: "codex/gpt-6-astra" }] });
    const auto = await runner.done!;
    expect(auto.config.claudeAccount).toBe("auto");
    expect([...accounts.get("claude/claude-haiku-5-5")!]).toEqual(["crew"]);
    expect([...accounts.get("codex/gpt-6-astra")!]).toEqual(["none"]);
    accounts.clear();
    runner.start({ mode: "championship", rounds: 1, pace: false, claudeAccount: "dev", contestants: [{ id: "claude/claude-haiku-5-5" }, { id: "baseline/scripted-pilot" }] });
    await runner.done;
    expect([...accounts.get("claude/claude-haiku-5-5")!]).toEqual(["dev"]);
  });

  it("flags rounds degraded by provider failures and keeps them off the leaderboard", async () => {
    let calls = 0;
    const flaky: AgentRequester = async (request) => {
      if (request.modelId === "fake/flaky" && ++calls > 1) throw new ProviderFailure("quota", "rate limited");
      return { text: JSON.stringify(scriptedBaselineCommand(request.snapshot)) };
    };
    const runner = new ArenaBenchmarkRunner({ store, requester: flaky });
    runner.start({ mode: "championship", rounds: 1, pace: false, contestants: [{ id: "fake/flaky" }, { id: "fake/steady" }] });
    const run = await runner.done!;
    const flakyResult = run.rounds[0]!.results.find((result) => result.contestantId === "fake/flaky")!;
    expect(flakyResult.degraded).toBe(true);
    expect(flakyResult.decisions.error).toBeGreaterThan(0);
    const board = leaderboardView(await store.loadLeaderboard("championship"), "championship");
    expect(board.rows.map((row) => row.id)).toEqual(["fake/steady"]);
  });

  it("stops on request and validates new runs", async () => {
    const hanging: AgentRequester = (request) =>
      new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new ProviderFailure("timeout", "aborted"))));
    const runner = new ArenaBenchmarkRunner({ store, requester: hanging, preflightTimeoutMs: 50 });
    expect(() => runner.start({ mode: "championship", rounds: 1, contestants: [{ id: "fake/a" }] })).toThrow(ArenaRunError);
    expect(() => runner.start({ mode: "championship", rounds: 1, contestants: [{ id: "baseline/scripted-pilot" }, { id: "baseline/scripted-pilot" }] })).toThrow(/at least two/);
    expect(() => runner.start({ mode: "championship", rounds: 0, contestants: [{ id: "fake/a" }, { id: "fake/b" }] })).toThrow(/Rounds/);
    runner.start({ mode: "championship", rounds: 1, contestants: [{ id: "fake/a" }, { id: "baseline/scripted-pilot" }] });
    expect(() => runner.start({ mode: "championship", rounds: 1, contestants: [{ id: "fake/a" }, { id: "fake/b" }] })).toThrow(/already in progress/);
    const run = await runner.done!;
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/preflight/);

    const blocking: AgentRequester = (request) =>
      new Promise((resolve, reject) => {
        if (request.snapshot.t < 3) resolve({ text: JSON.stringify(scriptedBaselineCommand(request.snapshot)) });
        request.signal.addEventListener("abort", () => reject(new ProviderFailure("timeout", "aborted")));
      });
    const stoppable = new ArenaBenchmarkRunner({ store, requester: blocking });
    stoppable.start({ mode: "championship", rounds: 2, pace: false, contestants: [{ id: "fake/a" }, { id: "baseline/scripted-pilot" }] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stoppable.stop()).toBe(true);
    const stopped = await stoppable.done!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.rounds).toHaveLength(0);
  });
});

describe("Asteroids benchmark routes", () => {
  async function app(role: "ADMIN" | "OPERATOR" | "VIEWER", requester: AgentRequester = fakeModels) {
    const fastify = Fastify();
    fastify.addHook("onRequest", async (request) => {
      (request as unknown as { user: { role: string } }).user = { role };
    });
    const runner = new ArenaBenchmarkRunner({ store, requester });
    registerBenchmarkRoutes(fastify, {}, { store, runner });
    return { fastify, runner };
  }

  it("lets only admins start, stop or reset runs and serves live state to viewers", async () => {
    const viewer = await app("VIEWER");
    const denied = await viewer.fastify.inject({ method: "POST", url: "/api/asteroids/benchmark/runs", payload: { mode: "championship", contestants: ["fake/smart", "baseline/scripted-pilot"], rounds: 1 } });
    expect(denied.statusCode).toBe(403);
    expect((await viewer.fastify.inject({ method: "POST", url: "/api/asteroids/benchmark/championship/reset", payload: { mode: "duel" } })).statusCode).toBe(403);
    const live = await viewer.fastify.inject({ method: "GET", url: "/api/asteroids/benchmark/live?after=-1" });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ run: null, frames: [], events: [] });
    await viewer.fastify.close();

    const admin = await app("ADMIN");
    const invalid = await admin.fastify.inject({ method: "POST", url: "/api/asteroids/benchmark/runs", payload: { mode: "pvp", contestants: ["fake/smart"] } });
    expect(invalid.statusCode).toBe(400);
    const tooFew = await admin.fastify.inject({ method: "POST", url: "/api/asteroids/benchmark/runs", payload: { mode: "championship", contestants: ["fake/smart"], rounds: 1 } });
    expect(tooFew.statusCode).toBe(400);
    const started = await admin.fastify.inject({
      method: "POST",
      url: "/api/asteroids/benchmark/runs",
      payload: { mode: "championship", contestants: [{ id: "fake/smart", displayName: "Smart" }, "baseline/scripted-pilot"], rounds: 1 }
    });
    expect(started.statusCode).toBe(202);
    const runId = started.json().run.id as string;
    const busy = await admin.fastify.inject({ method: "POST", url: "/api/asteroids/benchmark/runs", payload: { mode: "duel", contestants: ["fake/smart", "fake/naive"], rounds: 1 } });
    expect(busy.statusCode).toBe(409);
    expect((await admin.fastify.inject({ method: "POST", url: "/api/asteroids/benchmark/runs/stop" })).json()).toEqual({ stopped: true });
    await admin.runner.done;
    const runs = await admin.fastify.inject({ method: "GET", url: "/api/asteroids/benchmark/runs?mode=championship" });
    expect(runs.json().runs[0]).toMatchObject({ id: runId, status: "stopped" });
    expect((await admin.fastify.inject({ method: "GET", url: `/api/asteroids/benchmark/runs/${runId}` })).json()).toMatchObject({ id: runId, schemaVersion: 2 });
    expect((await admin.fastify.inject({ method: "GET", url: "/api/asteroids/benchmark/runs/..%2Fsecret" })).statusCode).toBe(400);
    expect((await admin.fastify.inject({ method: "GET", url: "/api/asteroids/benchmark/leaderboard?mode=nope" })).statusCode).toBe(400);
    expect((await admin.fastify.inject({ method: "POST", url: "/api/asteroids/benchmark/championship/reset", payload: { mode: "duel" } })).json()).toEqual({ reset: true, mode: "duel" });
    // Browser-submitted scores are gone: results only come from server-run rounds.
    expect((await admin.fastify.inject({ method: "POST", url: "/api/asteroids/benchmark/record-match", payload: {} })).statusCode).toBe(404);
    await admin.fastify.close();
  });

  it("publishes the exact protocol every model receives", async () => {
    const { fastify } = await app("VIEWER");
    const response = await fastify.inject({ method: "GET", url: "/api/asteroids/benchmark/protocol" });
    const protocol = response.json();
    expect(protocol.protocol).toBe("agent-arena/2");
    expect(protocol.decisionIntervalS).toBe(1.5);
    expect(protocol.modes.duel.systemPrompt).toContain("does NOT pause");
    expect(protocol.modes.championship.systemPrompt).toContain('"maneuver":"attack|evade|orbit|hold|collect|brake"');
    expect(protocol.sampleSnapshot.self.hull).toBeGreaterThan(0);
    expect(protocol.providers.claude).toContain("Claude Code");
    await fastify.close();
  });
});
