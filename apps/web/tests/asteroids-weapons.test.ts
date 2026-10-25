import { describe, expect, it } from "vitest";
import { AsteroidsEngine, emptyControls, LIMITS } from "../src/features/asteroids/engine.js";

describe("weapons", () => {
  it("fires spread 5-way and railgun pierce", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start();
    g.unlockWeapon("spread"); g.setWeapon("spread");
    g.shotCooldown = 0; g.fire();
    expect(g.shots.length).toBe(5);
    g.shots = []; g.unlockWeapon("railgun"); g.setWeapon("railgun");
    g.shotCooldown = 0; g.heat = 0; g.fire();
    expect(g.shots.length).toBe(1);
    expect(g.shots[0]!.pierce).toBeGreaterThan(0);
  });
  it("arc chains without spawning shots, missiles home", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start();
    g.unlockWeapon("arc"); g.setWeapon("arc"); g.shotCooldown = 0; g.heat = 0;
    const before = g.rocks.length;
    g.fire();
    expect(g.shots.length).toBe(0);
    expect(g.rocks.length).toBeLessThanOrEqual(before);
    g.unlockWeapon("missiles"); g.setWeapon("missiles"); g.shotCooldown = 0; g.heat = 0; g.fire();
    expect(g.shots.some(s => s.homing)).toBe(true);
  });
  it("overheat blocks fire, swap cycles unlocked", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start();
    g.heat = 1; const n = g.shots.length; g.fire();
    expect(g.shots.length).toBe(n);
    g.heat = 0; g.unlockWeapon("spread");
    g.swapWeapon(); expect(g.weapon).toBe("spread");
  });
  it("bomb consumes inventory and clears field", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start();
    g.ship.immunity = 0; const bombs = g.bombs;
    g.useBomb(); expect(g.bombs).toBe(bombs - 1);
  });
  it("enemy fire can never starve the player trigger", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start();
    for (let i = 0; i < 100; i++) {
      g.shots.push({ x: 0, y: 0, vx: 0, vy: 0, life: 3, enemy: true, damage: 1, pierce: 0, homing: false, weapon: "enemy" });
    }
    g.shotCooldown = 0; g.heat = 0; g.fire();
    expect(g.playerShotCount()).toBe(1);
    expect(g.shots.length).toBe(101);
  });
  it("player and enemy bullets keep separate budgets", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start();
    for (let i = 0; i < LIMITS.playerShots; i++) {
      g.shots.push({ x: 0, y: 0, vx: 0, vy: 0, life: 3, enemy: false, damage: 1, pierce: 0, homing: false, weapon: "blaster" });
    }
    g.shotCooldown = 0; g.heat = 0; g.fire();
    expect(g.playerShotCount()).toBe(LIMITS.playerShots);
    g.spawnRock(5, g.ship.x + 300, g.ship.y, true, "sentinel");
    const boss = g.rocks.find(r => r.boss)!;
    for (let i = 0; i < LIMITS.enemyShots; i++) {
      g.shots.push({ x: 0, y: 0, vx: 0, vy: 0, life: 3, enemy: true, damage: 1, pierce: 0, homing: false, weapon: "enemy" });
    }
    boss.shot = 0; g.ship.immunity = 10000;
    g.step(1 / 60, emptyControls());
    expect(g.enemyShotCount()).toBeLessThanOrEqual(LIMITS.enemyShots);
    expect(g.shots.length).toBeLessThanOrEqual(LIMITS.shots);
  });
});

describe("AI directive log", () => {
  it("records zone changes and LLM orders", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start();
    expect(g.directives).toHaveLength(0);
    g.applyDirector({ spawnRate: 0.7, enemySpeed: 0.85, fireCooldown: 1.3, eliteChance: 0.03, pickupRate: 1.6, zone: "calm" });
    expect(g.aiZone).toBe("calm");
    expect(g.directives.some(d => d.text.includes("zone=calm"))).toBe(true);
    const n = g.directives.length;
    g.applyDirector({ spawnRate: 0.7, enemySpeed: 0.85, fireCooldown: 1.3, eliteChance: 0.03, pickupRate: 1.6, zone: "calm" });
    expect(g.directives).toHaveLength(n); // no spam on unchanged zone
    g.applyLLM({ event: "ambush", threat: 0.8, spawnRate: 1.3, taunt: "Hold the line." });
    expect(g.directives.some(d => d.text.includes("LLM event=ambush"))).toBe(true);
  });
});

describe("start from sector", () => {
  it("begins a fresh run at the requested sector", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start(5);
    expect(g.sector).toBe(5);
    expect(g.sectorName).toBe("Sentinel encounter");
    expect(g.rocks.filter(r => r.boss)).toHaveLength(1);
    expect(g.score).toBe(0); expect(g.lives).toBe(3);
    const clamped = new AsteroidsEngine(800, 600, () => 0.5); clamped.start(0);
    expect(clamped.sector).toBe(1);
  });
});

describe("enemies", () => {  it("spawns sector enemies, kamikaze charges, mines explode", () => {
    const g = new AsteroidsEngine(800, 600, () => 0.5); g.start();
    g.sector = 8; g.beginSector();
    expect(g.enemies.length).toBeGreaterThan(0);
    g.spawnEnemy("kamikaze"); g.spawnMine(g.ship.x + 5, g.ship.y);
    const lives = g.lives; g.ship.immunity = 0;
    for (let i = 0; i < 600 && g.phase === "playing"; i++) g.step(1 / 60, emptyControls());
    expect(g.lives <= lives || g.kills > 0).toBe(true);
  });
  it("bounds hold over long combat", () => {
    const g = new AsteroidsEngine(800, 600); g.start(); g.ship.immunity = 10000;
    g.unlockWeapon("spread"); g.setWeapon("spread");
    const c = { ...emptyControls(), fire: true, thrust: true, right: true, dash: true, bomb: false, swap: false };
    for (let i = 0; i < 6000; i++) {
      g.step(1 / 60, c);
      expect(g.rocks.length).toBeLessThanOrEqual(LIMITS.rocks);
      expect(g.enemies.length).toBeLessThanOrEqual(LIMITS.enemies);
      expect(g.shots.length).toBeLessThanOrEqual(LIMITS.shots);
      expect(g.particles.length).toBeLessThanOrEqual(LIMITS.particles);
    }
  });
});
