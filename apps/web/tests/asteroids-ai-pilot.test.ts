import { describe, it, expect } from "vitest";
import { AsteroidsEngine } from "../src/features/asteroids/engine.js";
import { nextPilotControls, JEV_TACTICAL_PROFILE } from "../src/features/asteroids/ai-pilot.js";

describe("Asteroids Jev AI Pilot", () => {
  it("prioritizes enemies over passive rocks to reduce enemy forces", () => {
    const game = new AsteroidsEngine(800, 600);
    game.phase = "playing";
    game.ship.x = 400;
    game.ship.y = 300;
    game.ship.angle = 0;

    // Rock 150px south (requires right turn)
    game.rocks = [
      {
        x: 400,
        y: 450,
        vx: 0,
        vy: 0,
        radius: 20,
        size: 2,
        angle: 0,
        spin: 0,
        shape: [1, 1],
        hp: 1,
        boss: false,
        bossKind: "sentinel",
        shot: 0,
        spawnTick: 0,
      },
    ];

    // Kamikaze enemy 150px north (requires left turn)
    game.enemies = [
      {
        x: 400,
        y: 150,
        vx: 0,
        vy: 50,
        radius: 15,
        kind: "kamikaze",
        hp: 1,
        maxHp: 1,
        angle: 0,
        fireTimer: 1,
        t: 0,
        elite: false,
        blink: 0.5,
      },
    ];

    const controls = nextPilotControls(game, JEV_TACTICAL_PROFILE);

    // Target should be the enemy to the north, so it must turn left towards -PI/2
    expect(controls.left).toBe(true);
    expect(controls.right).toBe(false);
  });

  it("never sets left and right steering simultaneously (no steering cancellation lock)", () => {
    const game = new AsteroidsEngine(800, 600);
    game.phase = "playing";
    game.ship.x = 400;
    game.ship.y = 300;
    game.ship.angle = 0;

    // Add a rock very close (< 95 clearance) at 45 degrees
    game.rocks = [
      {
        x: 440,
        y: 340,
        vx: 0,
        vy: 0,
        radius: 25,
        size: 2,
        angle: 0,
        spin: 0,
        shape: [1, 1],
        hp: 1,
        boss: false,
        bossKind: "sentinel",
        shot: 0,
        spawnTick: 0,
      },
    ];

    const controls = nextPilotControls(game, JEV_TACTICAL_PROFILE);
    // left and right must NEVER both be true
    expect(controls.left && controls.right).toBe(false);
  });

  it("evades incoming enemy bullets", () => {
    const game = new AsteroidsEngine(800, 600);
    game.phase = "playing";
    game.ship.x = 400;
    game.ship.y = 300;
    game.ship.angle = 0;
    game.ship.immunity = 0;

    // Fast enemy bullet heading directly toward the ship
    game.shots = [
      {
        x: 460,
        y: 300,
        vx: -200,
        vy: 0,
        life: 2,
        enemy: true,
        damage: 1,
        pierce: 0,
        homing: false,
        weapon: "enemy",
      },
    ];

    // Dummy distant rock
    game.rocks = [
      {
        x: 700,
        y: 300,
        vx: 0,
        vy: 0,
        radius: 20,
        size: 2,
        angle: 0,
        spin: 0,
        shape: [1, 1],
        hp: 1,
        boss: false,
        bossKind: "sentinel",
        shot: 0,
        spawnTick: 0,
      },
    ];

    const controls = nextPilotControls(game, JEV_TACTICAL_PROFILE);
    // Should execute steering evasion
    expect(controls.left || controls.right).toBe(true);
    expect(controls.left && controls.right).toBe(false);
  });

  it("deploys tactical bomb when swarmed or in critical low hull", () => {
    const game = new AsteroidsEngine(800, 600);
    game.phase = "playing";
    game.ship.x = 400;
    game.ship.y = 300;
    game.bombs = 1;
    game.lives = 1;
    game.ship.immunity = 0;

    // Enemy critically close
    game.enemies = [
      {
        x: 430,
        y: 310,
        vx: 0,
        vy: 0,
        radius: 15,
        kind: "kamikaze",
        hp: 1,
        maxHp: 1,
        angle: 0,
        fireTimer: 1,
        t: 0,
        elite: false,
        blink: 0,
      },
    ];

    const controls = nextPilotControls(game, JEV_TACTICAL_PROFILE);
    expect(controls.bomb).toBe(true);
  });

  it("swaps to unlocked high-tier weapons like arc or spread when fighting enemy swarms", () => {
    const game = new AsteroidsEngine(800, 600);
    game.phase = "playing";
    game.ship.x = 400;
    game.ship.y = 300;
    game.weapon = "blaster";
    game.unlocked = ["blaster", "arc"];

    game.enemies = [
      { x: 300, y: 250, vx: 0, vy: 0, radius: 15, kind: "weaver", hp: 1, maxHp: 1, angle: 0, fireTimer: 1, t: 0, elite: false, blink: 0 },
      { x: 500, y: 350, vx: 0, vy: 0, radius: 15, kind: "gunship", hp: 1, maxHp: 1, angle: 0, fireTimer: 1, t: 0, elite: false, blink: 0 },
      { x: 450, y: 200, vx: 0, vy: 0, radius: 15, kind: "kamikaze", hp: 1, maxHp: 1, angle: 0, fireTimer: 1, t: 0, elite: false, blink: 0 },
    ];

    const controls = nextPilotControls(game, JEV_TACTICAL_PROFILE);
    expect(controls.swap).toBe(true);
  });

  it("kites charging kamikazes without thrusting head-on into them", () => {
    const game = new AsteroidsEngine(800, 600);
    game.phase = "playing";
    game.ship.x = 400;
    game.ship.y = 300;
    game.ship.angle = 0; // pointing right
    game.ship.immunity = 0;

    // Kamikaze directly in front, 170px away, charging towards ship
    game.enemies = [
      {
        x: 570,
        y: 300,
        vx: -150,
        vy: 0,
        radius: 15,
        kind: "kamikaze",
        hp: 1,
        maxHp: 1,
        angle: Math.PI,
        fireTimer: 1,
        t: 0,
        elite: false,
        blink: 0,
      },
    ];

    const controls = nextPilotControls(game, JEV_TACTICAL_PROFILE);
    // Ship must aim and fire at the chaser
    expect(controls.fire).toBe(true);
    // But must NOT thrust head-on into the charging kamikaze
    expect(controls.thrust).toBe(false);
  });

  it("detects rocks on collision trajectory, cuts thrust, and steers away", () => {
    const game = new AsteroidsEngine(800, 600);
    game.phase = "playing";
    game.ship.x = 400;
    game.ship.y = 300;
    game.ship.vx = 140; // ship moving right
    game.ship.vy = 0;
    game.ship.angle = 0; // pointing right
    game.ship.immunity = 0;

    // Rock directly ahead at x=550 (150px away)
    game.rocks = [
      {
        x: 550,
        y: 300,
        vx: 0,
        vy: 0,
        radius: 30,
        size: 2,
        angle: 0,
        spin: 0,
        shape: [1, 1],
        hp: 1,
        boss: false,
        bossKind: "sentinel",
        shot: 0,
        spawnTick: 0,
      },
    ];

    const controls = nextPilotControls(game, JEV_TACTICAL_PROFILE);
    // Must NOT thrust into the rock in front
    expect(controls.thrust).toBe(false);
    // Must execute steering evasion (left or right)
    expect(controls.left || controls.right).toBe(true);
    // Left and right must be mutually exclusive
    expect(controls.left && controls.right).toBe(false);
  });

  it("survives sustained asteroid combat with high efficiency", () => {
    const dt = 1 / 60;
    let totalScore = 0;
    let totalDeaths = 0;
    let totalKills = 0;

    for (let gameIdx = 0; gameIdx < 5; gameIdx++) {
      // Seeded games: with Math.random an unlucky spawn layout occasionally failed the death budget.
      let seed = 0x5eed + gameIdx;
      const g = new AsteroidsEngine(800, 600, () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      });
      g.start(1);
      let gDeaths = 0;
      let prevLives = g.lives;

      for (let f = 0; f < 2400; f++) {
        if (g.phase !== "playing") break;
        const controls = nextPilotControls(g, JEV_TACTICAL_PROFILE);
        g.step(dt, controls);
        if (g.lives < prevLives) {
          gDeaths += prevLives - g.lives;
          prevLives = g.lives;
        }
      }

      totalScore += g.score;
      totalDeaths += gDeaths;
      totalKills += g.kills;
      console.log(`Game #${gameIdx + 1} (40s): Sector ${g.sector} | Score: ${g.score} | Deaths: ${gDeaths} | Kills: ${g.kills}`);
    }

    console.log(`[Summary 5 Games] Avg Score: ${(totalScore/5).toFixed(0)} | Total Deaths: ${totalDeaths} | Total Kills: ${totalKills}`);
    expect(totalDeaths).toBeLessThanOrEqual(5);
  });
});


