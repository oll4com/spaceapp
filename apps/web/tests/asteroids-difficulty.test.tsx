import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import SpaceappAsteroids from "../src/features/asteroids/SpaceappAsteroids.js";
import { AsteroidsEngine, emptyControls } from "../src/features/asteroids/engine.js";

vi.mock("../src/features/asteroids/audio.js", () => ({ ArcadeAudio: class { enable = async () => true; pause() {} tick() {} cue() {} dispose() {} } }));
vi.mock("../src/features/asteroids/render.js", () => ({ createRenderer: () => ({ resize: () => {}, draw: () => {}, setPalette: () => {} }) }));
import { emptyDirector, scaleModifierForDifficulty, updateDirector } from "../src/features/asteroids/director.js";
import {
  DIFFICULTY_ORDER,
  LEVEL_MAX,
  LEVEL_MIN,
  difficultyById,
  isInfernoFire,
  normalizeDifficultyId,
  stepDifficulty,
} from "../src/features/asteroids/difficulty.js";
import { aiThrottleMs, fetchAIModifier, resetAIDirectorForTests } from "../src/features/asteroids/ai-director.js";

describe("difficulty ladder", () => {
  it("orders 10 levels from easiest to insane", () => {
    expect(DIFFICULTY_ORDER.map((d) => d.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(DIFFICULTY_ORDER[0]!.spawn).toBeLessThan(DIFFICULTY_ORDER[9]!.spawn);
    expect(DIFFICULTY_ORDER[0]!.enemyFire).toBeGreaterThan(DIFFICULTY_ORDER[9]!.enemyFire);
    expect(DIFFICULTY_ORDER[0]!.elite).toBe(0);
    expect(DIFFICULTY_ORDER[9]!.spawn).toBe(4);
    expect(DIFFICULTY_ORDER[9]!.enemySpeed).toBe(1.9);
    expect(DIFFICULTY_ORDER[9]!.enemyFire).toBe(0.25);
    expect(DIFFICULTY_ORDER[9]!.elite).toBe(0.6);
    expect(DIFFICULTY_ORDER[9]!.scoreMul).toBe(8);
    expect(DIFFICULTY_ORDER[8]!.spawn).toBe(3);
    expect(DIFFICULTY_ORDER[7]!.scoreMul).toBe(3);
  });
  it("steps and clamps at the ends", () => {
    expect(stepDifficulty(1, -1).id).toBe(1);
    expect(stepDifficulty(1, 1).id).toBe(2);
    expect(stepDifficulty(9, 1).id).toBe(10);
    expect(stepDifficulty(10, 1).id).toBe(10);
    expect(stepDifficulty(4, -1).id).toBe(3);
  });
  it("migrates legacy named ids and normalizes storage values", () => {
    expect(normalizeDifficultyId("inferno")).toBe(10);
    expect(normalizeDifficultyId("drift")).toBe(1);
    expect(normalizeDifficultyId("pilot")).toBe(4);
    expect(normalizeDifficultyId("veteran")).toBe(6);
    expect(normalizeDifficultyId("elite")).toBe(8);
    expect(normalizeDifficultyId("7")).toBe(7);
    expect(normalizeDifficultyId(3)).toBe(3);
    expect(normalizeDifficultyId("nope")).toBe(4);
    expect(normalizeDifficultyId(null)).toBe(4);
    expect(normalizeDifficultyId(99)).toBe(LEVEL_MAX);
    expect(normalizeDifficultyId(0)).toBe(LEVEL_MIN);
    expect(difficultyById(10).label).toBe("LEVEL 10");
  });
  it("enables overdrive fire only on level 10 + adaptive AI", () => {
    expect(isInfernoFire(10, "adaptive")).toBe(true);
    expect(isInfernoFire(10, "local")).toBe(false);
    expect(isInfernoFire(9, "adaptive")).toBe(false);
  });
});

describe("difficulty scaling in engine", () => {
  it("scales director output live without resetting mission or score", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    const score = 1234;
    g.score = score;
    const sector = g.sector;
    g.setDifficulty(1);
    g.applyDirector({ spawnRate: 1, enemySpeed: 1, fireCooldown: 1, eliteChance: 0.08, pickupRate: 1, zone: "tense" });
    const easySpawn = g.spawnMul;
    g.setDifficulty(10);
    expect(g.spawnMul).toBeGreaterThan(easySpawn);
    expect(g.enemyFireMul).toBeLessThan(1);
    expect(g.eliteChance).toBeGreaterThan(0.3);
    expect(g.score).toBe(score);
    expect(g.sector).toBe(sector);
    expect(g.phase).toBe("playing");
  });
  it("applies score multiplier per difficulty", () => {
    const easy = new AsteroidsEngine(800, 600, () => 0.5);
    easy.start();
    easy.setDifficulty(1);
    const hard = new AsteroidsEngine(800, 600, () => 0.5);
    hard.start();
    hard.setDifficulty(10);
    easy.destroyRock(easy.rocks[0]!);
    hard.destroyRock(hard.rocks[0]!);
    expect(hard.score).toBeGreaterThan(easy.score);
  });
  it("locks overdrive floor when fire mode is active", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.setDifficulty(10);
    g.setInfernoFire(true);
    g.applyDirector({ spawnRate: 0.7, enemySpeed: 0.85, fireCooldown: 1.3, eliteChance: 0.03, pickupRate: 1.6, zone: "calm" });
    expect(g.aiZone).toBe("inferno");
    expect(g.spawnMul).toBeGreaterThanOrEqual(1.6);
    expect(g.enemyFireMul).toBeLessThanOrEqual(0.6);
    expect(g.eliteChance).toBeGreaterThanOrEqual(0.32);
    g.setInfernoFire(false);
    expect(g.infernoFire).toBe(false);
  });
  it("toughens enemies and bosses at level 10", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.setDifficulty(10);
    g.spawnEnemy("gunship");
    expect(g.enemies[0]!.hp).toBeGreaterThan(2);
    const bossHp = 28 + Math.floor(g.sector / 5) * 12;
    g.spawnRock(5, g.ship.x + 200, g.ship.y, true, "sentinel");
    const boss = g.rocks.find((r) => r.boss)!;
    expect(boss.hp).toBeGreaterThan(bossHp);
  });
  it("keeps bounds over long level-10 combat", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.setDifficulty(10);
    g.setInfernoFire(true);
    g.ship.immunity = 10000;
    const controls = { ...emptyControls(), fire: true, thrust: true };
    for (let i = 0; i < 1200; i++) {
      g.step(1 / 60, controls);
    }
    expect(Number.isFinite(g.ship.x)).toBe(true);
  });
});

describe("shield track", () => {
  it("scales charges, immunity and hull with shield level", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    expect(g.maxShieldCharges()).toBe(2);
    expect(g.maxHull()).toBe(5);
    expect(g.shieldImmunity()).toBeCloseTo(1.5, 5);
    g.shieldLevel = 5;
    expect(g.maxShieldCharges()).toBe(7);
    expect(g.maxHull()).toBe(6);
    expect(g.shieldImmunity()).toBeCloseTo(2.5, 5);
  });
  it("absorbs hits with level-scaled immunity", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.shieldLevel = 2; g.shield = 4; g.ship.immunity = 0;
    g.hurt();
    expect(g.shield).toBe(3);
    expect(g.lives).toBe(3);
    expect(g.ship.immunity).toBeCloseTo(1.9, 5);
  });
  it("regrows hull at Lv3+", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.shieldLevel = 3; g.lives = 2; g.ship.immunity = 10000;
    g.regenTimer = 0.01;
    g.step(1 / 60, emptyControls());
    expect(g.lives).toBe(3);
  });
  it("caps shield pickups at the level max", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.shieldLevel = 1; g.shield = 3; g.ship.immunity = 10000;
    g.pickups.push({ x: g.ship.x, y: g.ship.y, vx: 0, vy: 0, life: 12, kind: "shield", angle: 0 });
    g.step(1 / 60, emptyControls());
    expect(g.shield).toBe(3);
  });
  it("balances all three tracks in auto-upgrade", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.weaponLevel = 2; g.engineLevel = 2; g.shieldLevel = 0;
    expect(g.autoUpgrade()).toBe("shield");
    expect(g.shieldLevel).toBe(1);
  });
});

describe("sustained pressure waves", () => {
  it("trickles waves while budget remains", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.setDifficulty(10);
    g.beginSector();
    expect(g.waveBudget).toBeGreaterThan(0);
    expect(g.waveInterval).toBe(1.5);
    while (g.rocks.length) g.destroyRock(g.rocks[0]!);
    while (g.enemies.length) g.destroyEnemy(g.enemies[0]!);
    const budget = g.waveBudget;
    g.waveTimer = 0;
    g.step(1 / 60, emptyControls());
    expect(g.enemies.length).toBeGreaterThan(0);
    expect(g.waveBudget).toBe(budget - 1);
  });
  it("skips waves at the enemy cap without consuming budget", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.setDifficulty(10);
    g.beginSector();
    while (g.enemies.length < 60) g.spawnEnemy("weaver");
    const budget = g.waveBudget;
    g.waveTimer = 0;
    g.step(1 / 60, emptyControls());
    expect(g.waveBudget).toBe(budget);
  });
  it("grants survival bonuses on sector advance at high difficulty", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5);
    g.start();
    g.setDifficulty(10);
    g.beginSector();
    g.bombs = 1; g.shieldLevel = 2; g.shield = 1; g.lives = 3;
    while (g.rocks.length) g.destroyRock(g.rocks[0]!);
    while (g.enemies.length) g.destroyEnemy(g.enemies[0]!);
    g.waveBudget = 0;
    for (let i = 0; i < 80; i++) g.step(1 / 60, emptyControls());
    expect(g.sector).toBe(2);
    expect(g.bombs).toBe(2);
    expect(g.shield).toBe(g.maxShieldCharges());
    expect(g.lives).toBe(4);
  });
});

describe("director + AI difficulty hooks", () => {
  it("scales calm/brutal zones by difficulty", () => {
    const d = emptyDirector();
    const calm = updateDirector(d, { accuracy: 0.2, deaths: 2, combo: 0, clearTime: 60, dashUses: 0, score: 0, sector: 2 });
    const scaled = scaleModifierForDifficulty(calm, difficultyById(10));
    expect(scaled.spawnRate).toBeGreaterThan(calm.spawnRate);
    expect(scaled.fireCooldown).toBeLessThan(calm.fireCooldown);
  });
  it("uses faster AI throttle in overdrive fire", () => {
    expect(aiThrottleMs(true)).toBe(10_000);
    expect(aiThrottleMs(false)).toBe(25_000);
  });
  it("fetches AI modifiers without throwing", async () => {
    resetAIDirectorForTests();
    const ok = vi.fn(async () => new Response(JSON.stringify({ event: "ambush", threat: 0.8, spawnRate: 1.2, taunt: "Hold the line." }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const mod = await fetchAIModifier({ score: 10, sector: 1, accuracy: 0.9, deaths: 0, combo: 9, playstyle: "aggressive" }, ok as unknown as typeof fetch, { infernoFire: true });
    expect(mod?.event).toBe("ambush");
  });
});

describe("difficulty keyboard contract", () => {
  beforeEach(() => localStorage.clear());
  it("maps bracket codes to difficulty steps", () => {
    // Contract: BracketLeft = easier (-1), BracketRight = harder (+1).
    const codes: Record<string, 1 | -1> = { BracketLeft: -1, BracketRight: 1 };
    expect(stepDifficulty(6, codes.BracketLeft!).id).toBe(5);
    expect(stepDifficulty(6, codes.BracketRight!).id).toBe(7);
  });
});

describe("difficulty shortcuts in UI", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    localStorage.clear();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it("picks the starting level before launch and persists it", () => {
    render(<SpaceappAsteroids onClose={() => {}} />);
    const game = screen.getByLabelText("Spaceapp Asteroids game");
    expect(game.getAttribute("data-difficulty")).toBe("4");
    fireEvent.click(screen.getByLabelText("Start at level 10"));
    expect(localStorage.getItem("space.asteroids.difficulty.v1")).toBe("10");
    expect(game.getAttribute("data-difficulty")).toBe("10");
    expect(screen.getByText("10 ×8")).toBeTruthy();
    fireEvent.click(screen.getByText("Launch mission"));
    expect(screen.getByLabelText("Spaceapp Asteroids game").getAttribute("data-difficulty")).toBe("10");
  });
  it("[ / ] changes difficulty live and persists it", () => {
    render(<SpaceappAsteroids onClose={() => {}} />);
    fireEvent.click(screen.getByText("Launch mission"));
    const game = screen.getByLabelText("Spaceapp Asteroids game");
    expect(game.getAttribute("data-difficulty")).toBe("4");
    fireEvent.keyDown(game, { code: "BracketRight", key: "]" });
    expect(screen.getByText("5 ×1.25")).toBeTruthy();
    expect(localStorage.getItem("space.asteroids.difficulty.v1")).toBe("5");
    fireEvent.keyDown(game, { code: "BracketLeft", key: "[" });
    expect(screen.getByText("4 ×1")).toBeTruthy();
  });
});
