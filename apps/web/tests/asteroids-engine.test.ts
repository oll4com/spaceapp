import { describe, expect, it } from "vitest";
import { AsteroidsEngine, emptyControls, LIMITS } from "../src/features/asteroids/engine.js";
import { canPlayAsteroids } from "../src/features/asteroids/eligibility.js";

describe("hidden arcade eligibility", () => {
  const pane = { roomId: "room:proof", isMinimized: true, categoryColor: "teal" };
  const valid = { selectedRoomId: pane.roomId, displayedRoomId: pane.roomId, preparingRoomId: null, loaded: true, category: null, panes: [pane] };
  it("requires every pane minimized, loaded and in the displayed room", () => {
    expect(canPlayAsteroids(valid)).toBe(true);
    for (const change of [
      { panes: [] }, { panes: [pane, { ...pane, isMinimized: false }] }, { loaded: false },
      { selectedRoomId: null }, { preparingRoomId: "room:next" }, { displayedRoomId: "room:old" },
      { panes: [{ ...pane, roomId: "room:stale" }] }, { category: "red" },
    ]) expect(canPlayAsteroids({ ...valid, ...change })).toBe(false);
    expect(canPlayAsteroids({ ...valid, category: "teal" })).toBe(true);
  });
});

describe("Asteroids simulation", () => {
  it("launches forward with visible thrust, then hands full propulsion to the pilot", () => {
    const game = new AsteroidsEngine(900, 900, () => .2); game.start();
    const startY = game.ship.y;
    expect(game.ship.vy).toBeLessThan(0); expect(game.launchThrust).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) game.step(1 / 60, emptyControls());
    expect(game.ship.y).toBeLessThan(startY - 50);
    for (let i = 0; i < 40; i++) game.step(1 / 60, emptyControls());
    expect(game.launchThrust).toBe(0); expect(game.manualThrustTime).toBe(0);
    game.step(1 / 60, { ...emptyControls(), thrust: true });
    expect(game.manualThrustTime).toBeGreaterThan(0);
  });
  it("splits rocks, builds combo, auto-upgrades into the next sector without stopping", () => {
    const game = new AsteroidsEngine(900, 600, () => .2); game.start();
    const first = game.rocks[0]!; const count = game.rocks.length; game.destroyRock(first);
    expect(game.rocks.length).toBe(count + 1); expect(game.score).toBe(60);
    while (game.rocks.length) game.destroyRock(game.rocks[0]!);
    expect(game.multiplier).toBeGreaterThan(1);
    for (let i = 0; i < 80; i++) game.step(1 / 60, emptyControls());
    expect(game.phase).toBe("playing"); expect(game.sector).toBe(2);
    expect(game.rocks.length).toBeGreaterThan(0);
    expect(game.autoUpgradeText).toBe("OVERCLOCK"); expect(game.weaponLevel).toBe(1);
  });
  it("auto-picks shield when the hull is hurt", () => {
    const game = new AsteroidsEngine(900, 600, () => .2); game.start();
    game.lives = 2; game.ship.immunity = 0;
    expect(game.autoUpgrade()).toBe("shield");
    expect(game.lives).toBe(3); expect(game.shield).toBe(3); expect(game.shieldLevel).toBe(1);
  });
  it("handles immunity, shield, game over and a clean restart", () => {
    const game = new AsteroidsEngine(500, 500); game.start();
    game.hurt(); expect(game.lives).toBe(3);
    game.ship.immunity = 0; game.shield = 1; game.hurt(); expect(game.shield).toBe(0); expect(game.lives).toBe(3);
    for (let i = 0; i < 3; i++) { game.ship.immunity = 0; game.hurt(); }
    expect(game.phase).toBe("over");
    game.start(); expect(game.phase).toBe("playing"); expect(game.lives).toBe(3); expect(game.score).toBe(0); expect(game.sector).toBe(1);
  });
  it("bounds long running combat and paused-tab deltas", () => {
    const game = new AsteroidsEngine(800, 600); game.start(); game.ship.immunity = 10000;
    const controls = { ...emptyControls(), fire: true, thrust: true, right: true, dash: true };
    for (let i = 0; i < 18000; i++) {
      game.step(1 / 60, controls);
      expect(game.rocks.length).toBeLessThanOrEqual(LIMITS.rocks);
      expect(game.shots.length).toBeLessThanOrEqual(LIMITS.shots);
      expect(game.particles.length).toBeLessThanOrEqual(LIMITS.particles);
      expect(game.pickups.length).toBeLessThanOrEqual(LIMITS.pickups);
    }
    const before = game.elapsed; game.step(60, controls); expect(game.elapsed - before).toBeLessThanOrEqual(.035);
    expect(Number.isFinite(game.ship.x)).toBe(true); expect(game.ship.x).toBeGreaterThanOrEqual(0); expect(game.ship.x).toBeLessThan(game.width);
  });
  it("spawns a firing Sentinel every fifth sector and wraps collisions across edges", () => {
    let seed = 424;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const game = new AsteroidsEngine(800, 600, random); game.start(); game.sector = 5; game.beginSector();
    expect(game.rocks.filter(r => r.boss)).toHaveLength(1);
    // A shot can hit the ship before the last frame; verify that the boss fired.
    let fired = false;
    for (let i = 0; i < 140; i++) { game.step(1 / 60, emptyControls()); fired ||= game.shots.some(s => s.enemy); }
    expect(fired).toBe(true);
    expect(game.distance({ x: 2, y: 40 }, { x: 798, y: 40 })).toBe(4);
    game.resize(400, 300); expect(game.ship.x).toBeLessThan(400); expect(game.ship.y).toBeLessThan(300);
  });
});
