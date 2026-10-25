import { describe, expect, it } from "vitest";
import {
  AgentArena,
  DECISION_INTERVAL_TICKS,
  ROUND_TICKS,
  generateScenario,
  hashSeed,
  type ArenaMode
} from "../asteroids-arena/sim.js";
import {
  applyCommand,
  buildCombinedPrompt,
  buildSensorSnapshot,
  computeControls,
  createExecutorState,
  idleCommand,
  naiveCommand,
  parsePilotCommand,
  scriptedBaselineCommand,
  type PilotCommand,
  type SensorSnapshot
} from "../asteroids-arena/protocol.js";
import { AGENT_CHAT_PROMPT_LIMIT, providerForModel, providerNoticeKind } from "../asteroids-arena/providers.js";

type Policy = (snapshot: SensorSnapshot) => PilotCommand;

function playSolo(policy: Policy, seed: number, mode: ArenaMode = "championship") {
  const arena = new AgentArena({ key: "solo", mode, scenario: generateScenario(seed, mode), pilots: ["pilot"] });
  const exec = createExecutorState();
  let decision = 0;
  while (!arena.over) {
    if (arena.tick % DECISION_INTERVAL_TICKS === 0) {
      applyCommand(exec, policy(buildSensorSnapshot(arena, 0, { decisionIndex: decision, decisionsTotal: 30 })));
      decision += 1;
    }
    arena.step([computeControls(arena, 0, exec)]);
  }
  return arena.ships[0]!;
}

function seededPolicy(seed: number): Policy {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const maneuvers = ["attack", "evade", "orbit", "hold", "collect", "brake"] as const;
  return (snapshot) => ({
    maneuver: maneuvers[Math.floor(next() * maneuvers.length)]!,
    target: snapshot.contacts[Math.floor(next() * Math.max(1, snapshot.contacts.length))]?.id ?? null,
    fire: next() > 0.3,
    dash: next() > 0.8,
    bomb: next() > 0.95,
    note: ""
  });
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

describe("Asteroids Agent Arena simulation", () => {
  it("replays a round exactly from the same seed and the same commands", () => {
    const first = playSolo(scriptedBaselineCommand, 4242);
    const second = playSolo(scriptedBaselineCommand, 4242);
    expect(second.stats).toEqual(first.stats);
    expect(playSolo(scriptedBaselineCommand, 4243).stats).not.toEqual(first.stats);
  });

  it("gives every split-arena pilot the identical scenario", () => {
    expect(generateScenario(77, "championship")).toEqual(generateScenario(77, "championship"));
    expect(generateScenario(77, "duel")).toEqual(generateScenario(77, "duel"));
    expect(generateScenario(77, "championship")).not.toEqual(generateScenario(78, "championship"));
  });

  it("separates good decisions from bad ones (benchmark validity)", () => {
    const seeds = [1, 2, 3, 4, 5, 6].map((index) => hashSeed(`validity-${index}`));
    const baseline = average(seeds.map((seed) => playSolo(scriptedBaselineCommand, seed).stats.score));
    const naive = average(seeds.map((seed) => playSolo(naiveCommand, seed).stats.score));
    const random = average(seeds.map((seed, index) => playSolo(seededPolicy(index + 1), seed).stats.score));
    const idle = average(seeds.map((seed) => playSolo(() => idleCommand(), seed).stats.score));
    expect(baseline).toBeGreaterThan(naive * 1.3);
    expect(naive).toBeGreaterThan(random);
    expect(random).toBeGreaterThan(idle);
    expect(idle).toBeLessThan(0);
  });

  it("separates policies in the shared arena too", () => {
    const totals = { baseline: 0, random: 0, idle: 0 };
    for (let index = 1; index <= 4; index += 1) {
      const lineup = index % 2 === 0 ? (["baseline", "random", "idle"] as const) : (["idle", "baseline", "random"] as const);
      const policies: Record<string, Policy> = { baseline: scriptedBaselineCommand, random: seededPolicy(index), idle: () => idleCommand() };
      const arena = new AgentArena({ key: "shared", mode: "shared_arena", scenario: generateScenario(hashSeed(`shared-${index}`), "shared_arena"), pilots: [...lineup] });
      const execs = lineup.map(() => createExecutorState());
      let decision = 0;
      while (!arena.over) {
        if (arena.tick % DECISION_INTERVAL_TICKS === 0) {
          arena.ships.forEach((ship, slot) => {
            if (ship.alive) applyCommand(execs[slot]!, policies[lineup[slot]!]!(buildSensorSnapshot(arena, slot, { decisionIndex: decision, decisionsTotal: 30 })));
          });
          decision += 1;
        }
        arena.step(arena.ships.map((_, slot) => computeControls(arena, slot, execs[slot]!)));
      }
      arena.ships.forEach((ship) => {
        totals[ship.pilotId as keyof typeof totals] += ship.stats.score;
      });
      expect(arena.tick).toBeLessThanOrEqual(ROUND_TICKS);
    }
    expect(totals.baseline).toBeGreaterThan(totals.random);
    expect(totals.random).toBeGreaterThan(totals.idle);
  });

  it("charges hull damage and awards survival exactly as documented", () => {
    const ship = playSolo(() => idleCommand(), hashSeed("idle-scoring"));
    const breakdown = ship.stats.breakdown;
    expect(breakdown.damage).toBe(-150 * ship.stats.hullLost);
    expect(breakdown.survival).toBe(10 * Math.floor(ship.stats.aliveTicks / 30));
    expect(ship.stats.score).toBe(Object.values(breakdown).reduce((sum, value) => sum + value, 0));
  });
});

describe("Asteroids Agent Arena protocol", () => {
  it("accepts a fenced JSON command and normalises it", () => {
    const parsed = parsePilotCommand('Sure!\n```json\n{"maneuver":"Attack","target":"r12","fire":true,"note":"locking on"}\n```');
    expect(parsed).toEqual({ ok: true, command: { maneuver: "attack", target: "R12", fire: true, dash: false, bomb: false, note: "locking on" } });
  });

  it("rejects replies that break the command contract", () => {
    expect(parsePilotCommand("I will attack the nearest rock.")).toEqual({ ok: false, reason: "no JSON object in the reply" });
    expect(parsePilotCommand('{"maneuver":"charge"}')).toMatchObject({ ok: false });
    expect(parsePilotCommand('{"maneuver":"attack","target":"rock-1"}')).toMatchObject({ ok: false });
    expect(parsePilotCommand('{"maneuver":"attack","fire":"yes"}')).toEqual({ ok: false, reason: "fire must be true or false" });
    expect(parsePilotCommand('{"maneuver":"brake", "note":"}"} trailing')).toMatchObject({ ok: true });
  });

  it("reports bearing, closest approach and impact predictions from the pilot's point of view", () => {
    const arena = new AgentArena({ key: "geo", mode: "championship", scenario: { ...generateScenario(1, "championship"), initialRocks: [], events: [], refills: [] }, pilots: ["pilot"] });
    const ship = arena.ships[0]!;
    ship.angle = 0;
    arena.rocks.push({ id: 900, x: ship.x, y: ship.y + 200, vx: 0, vy: -80, size: 2, radius: 22, angle: 0, spin: 0 });
    const snapshot = buildSensorSnapshot(arena, 0, { decisionIndex: 0, decisionsTotal: 30 });
    const rock = snapshot.contacts[0]!;
    expect(rock.id).toBe("R900");
    expect(rock.bearing).toBe(90);
    expect(rock.closing).toBe(80);
    expect(rock.tca).toBe(2.5);
    expect(rock.miss).toBeLessThan(0);
  });

  it("executes orders without taking decisions of its own", () => {
    const arena = new AgentArena({ key: "exec", mode: "championship", scenario: { ...generateScenario(1, "championship"), initialRocks: [], events: [], refills: [] }, pilots: ["pilot"] });
    const ship = arena.ships[0]!;
    ship.angle = 0;
    arena.rocks.push({ id: 5, x: ship.x, y: ship.y - 150, vx: 0, vy: 0, size: 3, radius: 38, angle: 0, spin: 0 });
    const exec = createExecutorState();
    expect(computeControls(arena, 0, exec)).toEqual({ turn: 0, thrust: false, fire: false, dash: false, bomb: false });
    applyCommand(exec, { maneuver: "attack", target: "R5", fire: false, dash: false, bomb: true, note: "" });
    const first = computeControls(arena, 0, exec);
    expect(first.turn).toBe(-1);
    expect(first.fire).toBe(false);
    expect(first.bomb).toBe(true);
    expect(computeControls(arena, 0, exec).bomb).toBe(false);
    applyCommand(exec, { maneuver: "evade", target: "R5", fire: false, dash: false, bomb: false, note: "" });
    expect(computeControls(arena, 0, exec).turn).toBe(1);
  });

  it("keeps the CLI prompt under the agent-chat limit", () => {
    const arena = new AgentArena({ key: "size", mode: "shared_arena", scenario: generateScenario(9, "shared_arena"), pilots: ["a", "b", "c", "d", "e", "f", "g", "h"] });
    for (let tick = 0; tick < 900; tick += 1) arena.step([]);
    const prompt = buildCombinedPrompt("shared_arena", buildSensorSnapshot(arena, 0, { decisionIndex: 20, decisionsTotal: 30 }));
    expect(prompt.length).toBeLessThan(AGENT_CHAT_PROMPT_LIMIT);
  });

  it("classifies provider notices separately from model answers", () => {
    expect(providerNoticeKind("You've hit your session limit · resets 10:30am")).toBe("quota");
    expect(providerNoticeKind("RESOURCE_EXHAUSTED (code 429): Individual quota reached.")).toBe("quota");
    expect(providerNoticeKind('{"maneuver":"attack","note":"quota is fine"}')).toBeNull();
    expect(providerNoticeKind("I would attack the rock")).toBeNull();
  });

  it("routes every model family to its provider path", () => {
    expect(providerForModel("claude/claude-opus-5-5")).toBe("claude");
    expect(providerForModel("codex/gpt-6-astra")).toBe("codex");
    expect(providerForModel("antigravity/gemini-3.8-flash-low")).toBe("antigravity");
    expect(providerForModel("openrouter/typesafe/jev-1.13")).toBe("jev");
    expect(providerForModel("openrouter/acme/model:free")).toBe("openrouter");
    expect(providerForModel("github/auto")).toBe("github");
    expect(providerForModel("baseline/scripted-pilot")).toBe("baseline");
    expect(providerForModel("opencode/big-pickle")).toBe("opencode");
  });
});
