import type { Controls } from "./engine.js";
import { emptyControls } from "./engine.js";
import type { LivePilotDirective, TacticalProfile } from "./ai-pilot.js";

export interface ArenaShip {
  id: string;
  name: string;
  provider: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hp: number;
  maxHp: number;
  shield: number;
  immunity: number;
  dashCooldown: number;
  score: number;
  asteroidKills: number;
  pvpKills: number;
  shotsFired: number;
  shotsHit: number;
  shotCooldown: number;
  alive: boolean;
  survivalRank: number;
  eliminatedAt: number | null;
  bombs: number;
  tactic: TacticalProfile;
  liveDirective?: LivePilotDirective | null;
  isJev: boolean;
  lastControls: Controls;
}

export interface ArenaRock {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  angle: number;
  spin: number;
  shape: number[];
  hp: number;
}

export interface ArenaShot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  color: string;
  life: number;
  damage: number;
}

export interface ArenaParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
}

export interface ArenaAnnouncement {
  text: string;
  timer: number;
  color: string;
}

export interface ArenaShockwave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  color: string;
}

export const ARENA_COLORS = [
  "#00f0ff", // Jev: Electric Neon Cyan
  "#ff9d00", // Opponent 1: Solar Gold
  "#00ff88", // Opponent 2: Neon Emerald
  "#d000ff", // Opponent 3: Cyber Violet
  "#ff2255", // Opponent 4: Crimson Red
  "#ffea00", // Opponent 5: Amber Yellow
  "#3399ff", // Opponent 6: Cobalt Blue
];

function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function wrappedDelta(val: number, max: number): number {
  return ((val + max / 2) % max + max) % max - max / 2;
}

export class MultiArenaEngine {
  width: number;
  height: number;
  ships: ArenaShip[] = [];
  rocks: ArenaRock[] = [];
  shots: ArenaShot[] = [];
  particles: ArenaParticle[] = [];
  announcements: ArenaAnnouncement[] = [];
  shockwaves: ArenaShockwave[] = [];
  elapsed = 0;
  phase: "ready" | "playing" | "over" = "ready";
  private random: () => number;

  constructor(width = 960, height = 540, random = Math.random) {
    this.width = width;
    this.height = height;
    this.random = random;
  }

  resize(width: number, height: number) {
    const oldW = this.width;
    const oldH = this.height;
    this.width = Math.max(480, width);
    this.height = Math.max(320, height);
    const scaleX = this.width / oldW;
    const scaleY = this.height / oldH;
    for (const s of this.ships) { s.x *= scaleX; s.y *= scaleY; }
    for (const r of this.rocks) { r.x *= scaleX; r.y *= scaleY; }
    for (const sh of this.shots) { sh.x *= scaleX; sh.y *= scaleY; }
  }

  initMatch(contestants: { id: string; name: string; provider: string; tactic: TacticalProfile; isJev: boolean }[]) {
    this.ships = [];
    this.rocks = [];
    this.shots = [];
    this.particles = [];
    this.announcements = [];
    this.shockwaves = [];
    this.elapsed = 0;
    this.phase = "playing";

    const count = contestants.length;
    const centerX = this.width / 2;
    const centerY = this.height / 2;
    const spawnRadius = Math.min(this.width, this.height) * 0.38;

    this.ships = contestants.map((c, i) => {
      const angle = (i * Math.PI * 2) / count - Math.PI / 2;
      const x = centerX + Math.cos(angle) * spawnRadius;
      const y = centerY + Math.sin(angle) * spawnRadius;
      const faceAngle = angle + Math.PI; // Face inward toward center
      const color = c.isJev ? ARENA_COLORS[0]! : ARENA_COLORS[(i % (ARENA_COLORS.length - 1)) + 1]!;

      return {
        id: c.id,
        name: c.name,
        provider: c.provider,
        color,
        x,
        y,
        vx: 0,
        vy: 0,
        angle: faceAngle,
        hp: 5,
        maxHp: 5,
        shield: 2,
        immunity: 3.5,
        dashCooldown: 0,
        score: 0,
        asteroidKills: 0,
        pvpKills: 0,
        shotsFired: 0,
        shotsHit: 0,
        shotCooldown: 0,
        alive: true,
        survivalRank: 0,
        eliminatedAt: null,
        bombs: 1,
        tactic: c.tactic,
        liveDirective: null,
        isJev: c.isJev,
        lastControls: emptyControls(),
      };
    });

    // Spawn 10 initial drifting asteroids
    for (let i = 0; i < 10; i++) {
      this.spawnRock(32, this.random() * this.width, this.random() * this.height);
    }

    this.addAnnouncement("🔥 BATTLE ROYALE · LAST AI STANDING IS CHAMPION!", 4.5, "#00f0ff");
  }

  spawnRock(radius: number, x?: number, y?: number) {
    const rx = x ?? (this.random() > 0.5 ? 0 : this.width);
    const ry = y ?? this.random() * this.height;
    const speed = 25 + this.random() * 45;
    const dir = this.random() * Math.PI * 2;
    const numPoints = 8 + Math.floor(this.random() * 4);
    const shape = Array.from({ length: numPoints }, () => 0.75 + this.random() * 0.45);

    this.rocks.push({
      x: rx,
      y: ry,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      radius,
      angle: this.random() * Math.PI * 2,
      spin: (this.random() - 0.5) * 1.5,
      shape,
      hp: radius > 24 ? 2 : 1,
    });
  }

  addAnnouncement(text: string, timer = 3.0, color = "#fff") {
    this.announcements.unshift({ text, timer, color });
    if (this.announcements.length > 4) this.announcements.pop();
  }

  addExplosion(x: number, y: number, color: string, count = 30) {
    for (let i = 0; i < count; i++) {
      const speed = 40 + this.random() * 220;
      const ang = this.random() * Math.PI * 2;
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * speed,
        vy: Math.sin(ang) * speed,
        life: 0.4 + this.random() * 0.6,
        maxLife: 1.0,
        color,
      });
    }
  }

  eliminateShip(ship: ArenaShip, killer?: ArenaShip, reason = "combat") {
    if (!ship.alive) return;
    ship.alive = false;
    ship.hp = 0;
    ship.eliminatedAt = Math.round(this.elapsed * 10) / 10;
    this.addExplosion(ship.x, ship.y, ship.color, 45);

    const remainingAlive = this.ships.filter((s) => s.alive);
    ship.survivalRank = remainingAlive.length + 1;

    if (killer && killer.id !== ship.id) {
      killer.pvpKills += 1;
      killer.score += 1000;
      this.addAnnouncement(`⚡ ${killer.name} ELIMINATED ${ship.name}! (#${ship.survivalRank})`, 3.5, killer.color);
    } else {
      this.addAnnouncement(`💀 ${ship.name} ELIMINATED! (#${ship.survivalRank})`, 3.0, ship.color);
    }

    if (ship.survivalRank === 2) {
      ship.score += 2500; // Runner-up bonus
    } else if (ship.survivalRank === 3) {
      ship.score += 1200; // 3rd Place bronze bonus
    }

    if (remainingAlive.length === 1) {
      const winner = remainingAlive[0]!;
      winner.survivalRank = 1;
      winner.score += 5000; // Victory Royale champion bonus
      this.addAnnouncement(`👑 VICTORY ROYALE: ${winner.name} IS THE LAST AI STANDING! (+5000 pts)`, 5.0, winner.color);
      this.phase = "over";
    } else if (remainingAlive.length === 0) {
      this.phase = "over";
    }
  }

  computeShipControls(ship: ArenaShip): Controls {
    const controls = emptyControls();
    if (!ship.alive) return controls;

    // Potential targets: all other live ships, and rocks
    const otherShips = this.ships.filter((s) => s.id !== ship.id && s.alive);
    const targets: { x: number; y: number; vx: number; vy: number; radius: number; isShip: boolean; threat: number }[] = [];

    for (const other of otherShips) {
      const dx = wrappedDelta(other.x - ship.x, this.width);
      const dy = wrappedDelta(other.y - ship.y, this.height);
      const dist = Math.hypot(dx, dy) || 1;
      targets.push({
        x: other.x,
        y: other.y,
        vx: other.vx,
        vy: other.vy,
        radius: 18,
        isShip: true,
        threat: 500 / dist + (other.isJev ? 40 : 15),
      });
    }

    for (const rock of this.rocks) {
      const dx = wrappedDelta(rock.x - ship.x, this.width);
      const dy = wrappedDelta(rock.y - ship.y, this.height);
      const dist = Math.hypot(dx, dy) || 1;
      targets.push({
        x: rock.x,
        y: rock.y,
        vx: rock.vx,
        vy: rock.vy,
        radius: rock.radius,
        isShip: false,
        threat: 250 / dist,
      });
    }

    if (targets.length === 0) {
      controls.thrust = true;
      controls.right = true;
      return controls;
    }

    // Sort by priority based on tactic
    const primaryTarget = targets.sort((a, b) => {
      if (ship.tactic.targetPreference === "threat") return b.threat - a.threat;
      if (ship.tactic.targetPreference === "enemies") {
        if (a.isShip !== b.isShip) return a.isShip ? -1 : 1;
      }
      const da = Math.hypot(wrappedDelta(a.x - ship.x, this.width), wrappedDelta(a.y - ship.y, this.height));
      const db = Math.hypot(wrappedDelta(b.x - ship.x, this.width), wrappedDelta(b.y - ship.y, this.height));
      return da - db;
    })[0]!;

    const tDx = wrappedDelta(primaryTarget.x - ship.x, this.width);
    const tDy = wrappedDelta(primaryTarget.y - ship.y, this.height);
    const tDist = Math.hypot(tDx, tDy) || 1;

    // Aim calculation with lead
    const lead = Math.min(0.5, (tDist / 550) * (ship.tactic.leadAiming ?? 0.8));
    const targetAngle = Math.atan2(tDy + primaryTarget.vy * lead, tDx + primaryTarget.vx * lead);
    const delta = angleDelta(ship.angle, targetAngle);

    // Turn toward target
    const deadZone = 0.03 + (1 - ship.tactic.precision) * 0.05;
    if (delta > deadZone) controls.right = true;
    if (delta < -deadZone) controls.left = true;

    // Fire laser if lined up
    controls.fire = Math.abs(delta) < 0.38 + (1 - ship.tactic.precision) * 0.15;

    // Thrust toward target if not too close
    controls.thrust = tDist > 130;

    // Closest collision danger (rock or enemy ship)
    let closestHazardDist = 9999;
    let closestHazardAngle = 0;
    for (const h of targets) {
      const hDx = wrappedDelta(h.x - ship.x, this.width);
      const hDy = wrappedDelta(h.y - ship.y, this.height);
      const dist = Math.hypot(hDx, hDy);
      if (dist < closestHazardDist) {
        closestHazardDist = dist;
        closestHazardAngle = Math.atan2(hDy, hDx);
      }
    }

    // Emergency evasion when hazard is within collision zone (< 120px)
    if (closestHazardDist < 120) {
      const hazardDelta = angleDelta(ship.angle, closestHazardAngle);
      // Steer perpendicular away from collision vector (mutually exclusive)
      if (hazardDelta > 0) {
        controls.left = true;
        controls.right = false;
      } else {
        controls.right = true;
        controls.left = false;
      }

      if (Math.abs(hazardDelta) < 1.1) {
        controls.thrust = false;
      }

      // Smart evasive dash: dash sideways away from incoming hazard
      if (ship.dashCooldown <= 0 && ship.immunity <= 0 && Math.abs(hazardDelta) > 1.1) {
        controls.dash = true;
      }

      // Detonate tactical bomb if heavily crowded
      if (ship.bombs > 0 && closestHazardDist < 85) {
        controls.bomb = true;
      }
    }

    // Live AI directive overrides (Jev AI OpenRouter directives)
    if (ship.liveDirective) {
      const dir = ship.liveDirective;
      if (dir.action === "emergency_dash" && ship.dashCooldown <= 0) {
        controls.dash = true;
        if (dir.turnBias === "left") { controls.left = true; controls.right = false; }
        else if (dir.turnBias === "right") { controls.right = true; controls.left = false; }
      } else if (dir.action === "tactical_bomb") {
        if (ship.bombs > 0) controls.bomb = true;
        controls.fire = true;
      } else if (dir.action === "strafe_circle") {
        controls.thrust = true;
        controls.right = true;
        controls.fire = Math.abs(delta) < 0.6;
      } else if (dir.action === "breakaway") {
        controls.thrust = false;
        controls.left = true;
      } else if (dir.action === "lock_and_fire") {
        controls.fire = Math.abs(delta) < 0.35;
        controls.thrust = tDist > 120;
      } else if (dir.action === "full_assault") {
        controls.thrust = true;
        controls.fire = true;
      }
    }

    return controls;
  }

  step(dt: number) {
    this.elapsed += dt;

    // 1. Announcements countdown
    for (const a of this.announcements) a.timer -= dt;
    this.announcements = this.announcements.filter((a) => a.timer > 0);

    // 2. Shockwaves expansion
    for (const sw of this.shockwaves) {
      sw.radius += dt * 380;
    }
    this.shockwaves = this.shockwaves.filter((sw) => sw.radius < sw.maxRadius);

    // 3. Ships update
    for (const ship of this.ships) {
      if (!ship.alive) continue;

      ship.immunity = Math.max(0, ship.immunity - dt);
      ship.dashCooldown = Math.max(0, ship.dashCooldown - dt);
      ship.shotCooldown = Math.max(0, ship.shotCooldown - dt);

      const controls = this.computeShipControls(ship);
      ship.lastControls = controls;

      // Turning
      const turnSpeed = 3.6;
      ship.angle += (Number(controls.right) - Number(controls.left)) * turnSpeed * dt;

      // Thrust
      if (controls.thrust) {
        const accel = 320;
        ship.vx += Math.cos(ship.angle) * accel * dt;
        ship.vy += Math.sin(ship.angle) * accel * dt;
        // Thruster particles
        if (this.random() < 0.35) {
          const backX = ship.x - Math.cos(ship.angle) * 14;
          const backY = ship.y - Math.sin(ship.angle) * 14;
          this.particles.push({
            x: backX,
            y: backY,
            vx: -Math.cos(ship.angle) * 60 + (this.random() - 0.5) * 20,
            vy: -Math.sin(ship.angle) * 60 + (this.random() - 0.5) * 20,
            life: 0.25,
            maxLife: 0.25,
            color: ship.color,
          });
        }
      }

      // Evasive Dash
      if (controls.dash && ship.dashCooldown <= 0) {
        ship.vx = Math.cos(ship.angle) * 580;
        ship.vy = Math.sin(ship.angle) * 580;
        ship.immunity = Math.max(0.8, ship.immunity);
        ship.dashCooldown = 3.5;
        this.addExplosion(ship.x, ship.y, ship.color, 15);
      }

      // Tactical Bomb
      if (controls.bomb && ship.bombs > 0) {
        ship.bombs -= 1;
        this.shockwaves.push({ x: ship.x, y: ship.y, radius: 10, maxRadius: 260, color: ship.color });
        this.addAnnouncement(`💥 ${ship.name} DETONATED ANTIMATTER BOMB!`, 2.5, ship.color);
        // Destroy nearby rocks and damage nearby enemy ships
        for (const rock of [...this.rocks]) {
          const d = Math.hypot(rock.x - ship.x, rock.y - ship.y);
          if (d < 240) {
            ship.score += 250;
            ship.asteroidKills += 1;
            this.addExplosion(rock.x, rock.y, "#ffd700", 15);
            this.rocks = this.rocks.filter((r) => r !== rock);
          }
        }
        for (const other of this.ships) {
          if (other.id !== ship.id && other.alive && other.immunity <= 0) {
            const d = Math.hypot(other.x - ship.x, other.y - ship.y);
            if (d < 220) {
              other.hp -= 2;
              this.addExplosion(other.x, other.y, other.color, 20);
              if (other.hp <= 0) {
                this.eliminateShip(other, ship, "bomb");
              }
            }
          }
        }
      }

      // Fire Lasers
      if (controls.fire && ship.shotCooldown <= 0) {
        ship.shotCooldown = 0.22;
        ship.shotsFired += 1;
        const shotSpeed = 620;
        const tipX = ship.x + Math.cos(ship.angle) * 16;
        const tipY = ship.y + Math.sin(ship.angle) * 16;
        this.shots.push({
          x: tipX,
          y: tipY,
          vx: Math.cos(ship.angle) * shotSpeed,
          vy: Math.sin(ship.angle) * shotSpeed,
          ownerId: ship.id,
          color: ship.color,
          life: 1.1,
          damage: 1,
        });
      }

      // Apply drag
      const drag = Math.exp(-dt * 0.6);
      ship.vx *= drag;
      ship.vy *= drag;

      // Move and wrap
      ship.x = (ship.x + ship.vx * dt + this.width) % this.width;
      ship.y = (ship.y + ship.vy * dt + this.height) % this.height;
    }

    // 4. Update Shots & Collisions
    for (const shot of this.shots) {
      shot.life -= dt;
      shot.x = (shot.x + shot.vx * dt + this.width) % this.width;
      shot.y = (shot.y + shot.vy * dt + this.height) % this.height;

      const owner = this.ships.find((s) => s.id === shot.ownerId);

      // Collision with Rocks
      for (const rock of [...this.rocks]) {
        const dx = wrappedDelta(shot.x - rock.x, this.width);
        const dy = wrappedDelta(shot.y - rock.y, this.height);
        if (Math.hypot(dx, dy) < rock.radius) {
          shot.life = 0;
          rock.hp -= shot.damage;
          if (owner) { owner.shotsHit += 1; owner.score += 80; }
          this.addExplosion(rock.x, rock.y, "#9aa4b2", 8);

          if (rock.hp <= 0) {
            if (owner) { owner.asteroidKills += 1; owner.score += 180; }
            this.addExplosion(rock.x, rock.y, "#ffd700", 18);
            this.rocks = this.rocks.filter((r) => r !== rock);
            // Split rock
            if (rock.radius > 20) {
              this.spawnRock(rock.radius * 0.55, rock.x, rock.y);
              this.spawnRock(rock.radius * 0.55, rock.x, rock.y);
            }
          }
          break;
        }
      }

      // Collision with Other Ships (PVP DOGFIGHT!)
      for (const target of this.ships) {
        if (target.id !== shot.ownerId && target.alive && target.immunity <= 0 && shot.life > 0) {
          const dx = wrappedDelta(shot.x - target.x, this.width);
          const dy = wrappedDelta(shot.y - target.y, this.height);
          if (Math.hypot(dx, dy) < 18) {
            shot.life = 0;
            if (owner) { owner.shotsHit += 1; owner.score += 150; }

            // Shield absorption
            if (target.shield > 0) {
              target.shield -= 1;
              target.immunity = 0.6;
              this.addExplosion(target.x, target.y, "#00f0ff", 12);
            } else {
              target.hp -= 1;
              target.immunity = 0.5;
              this.addExplosion(target.x, target.y, target.color, 16);

              if (target.hp <= 0) {
                this.eliminateShip(target, owner, "laser");
              }
            }
            break;
          }
        }
      }
    }
    this.shots = this.shots.filter((s) => s.life > 0);

    // 5. Update Rocks
    for (const rock of this.rocks) {
      rock.angle += rock.spin * dt;
      rock.x = (rock.x + rock.vx * dt + this.width) % this.width;
      rock.y = (rock.y + rock.vy * dt + this.height) % this.height;

      // Rock collision with ships
      for (const ship of this.ships) {
        if (ship.alive && ship.immunity <= 0) {
          const dx = wrappedDelta(rock.x - ship.x, this.width);
          const dy = wrappedDelta(rock.y - ship.y, this.height);
          if (Math.hypot(dx, dy) < rock.radius + 12) {
            ship.hp -= 1;
            ship.immunity = 1.2;
            this.addExplosion(ship.x, ship.y, ship.color, 18);
            if (ship.hp <= 0) {
              this.eliminateShip(ship, undefined, "asteroid");
            }
          }
        }
      }
    }

    // Keep minimum rocks in play
    if (this.rocks.length < 6) {
      this.spawnRock(28);
    }

    // 6. Update Particles
    for (const p of this.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  render(ctx: CanvasRenderingContext2D) {
    const w = this.width;
    const h = this.height;

    ctx.clearRect(0, 0, w, h);

    // Background stars
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    for (let i = 0; i < 70; i++) {
      const sx = ((i * 137.5) % w);
      const sy = ((i * 269.3) % h);
      ctx.fillRect(sx, sy, i % 4 === 0 ? 1.5 : 0.8, i % 4 === 0 ? 1.5 : 0.8);
    }

    // Shockwaves
    for (const sw of this.shockwaves) {
      const alpha = Math.max(0, 1 - sw.radius / sw.maxRadius);
      ctx.save();
      ctx.strokeStyle = sw.color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Rocks
    for (const r of this.rocks) {
      ctx.save();
      ctx.translate(r.x, r.y);
      ctx.rotate(r.angle);
      ctx.strokeStyle = "#8b949e";
      ctx.fillStyle = "#161b22";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      r.shape.forEach((ratio, idx) => {
        const rad = r.radius * ratio;
        const ang = (idx / r.shape.length) * Math.PI * 2;
        const px = Math.cos(ang) * rad;
        const py = Math.sin(ang) * rad;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Lasers
    for (const s of this.shots) {
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.vx * 0.025, s.y - s.vy * 0.025);
      ctx.stroke();
      ctx.restore();
    }

    // Particles
    for (const p of this.particles) {
      ctx.save();
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fillRect(p.x, p.y, 2.5, 2.5);
      ctx.restore();
    }

    // Ships
    for (const ship of this.ships) {
      if (!ship.alive) continue;

      ctx.save();
      ctx.translate(ship.x, ship.y);

      // Shield bubble
      if (ship.immunity > 0 || ship.shield > 0) {
        ctx.save();
        ctx.strokeStyle = ship.shield > 0 ? ship.color : "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.shadowColor = ship.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(0, 0, 22, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Ship body
      ctx.save();
      ctx.rotate(ship.angle);

      // Thruster flame
      if (ship.lastControls.thrust) {
        ctx.fillStyle = "#ffaa00";
        ctx.beginPath();
        ctx.moveTo(-10, -5);
      ctx.lineTo(-24 - this.random() * 8, 0);
        ctx.lineTo(-10, 5);
        ctx.fill();
      }

      // Hull
      ctx.fillStyle = "#111827";
      ctx.strokeStyle = ship.color;
      ctx.lineWidth = ship.isJev ? 2.5 : 2;
      ctx.shadowColor = ship.color;
      ctx.shadowBlur = ship.isJev ? 12 : 5;

      ctx.beginPath();
      ctx.moveTo(18, 0);
      ctx.lineTo(-12, -10);
      ctx.lineTo(-6, 0);
      ctx.lineTo(-12, 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Overhead HUD (Floating Name, HP, Directive)
      ctx.save();
      ctx.font = ship.isJev ? "bold 10px monospace" : "9px monospace";
      ctx.textAlign = "center";

      // Name banner
      ctx.fillStyle = ship.isJev ? "#00f0ff" : "#ffffff";
      ctx.fillText(`${ship.name}`, 0, -28);

      // Health hearts / pips
      let hpPips = "";
      for (let i = 0; i < ship.maxHp; i++) {
        hpPips += i < ship.hp ? "♥" : "♡";
      }
      ctx.fillStyle = ship.hp > 2 ? "#00ff88" : "#ff3344";
      ctx.font = "bold 9px monospace";
      ctx.fillText(hpPips, 0, -18);

      // Jev Live Directive Beacon
      if (ship.isJev && ship.liveDirective) {
        ctx.fillStyle = "#ffe600";
        ctx.font = "bold 9px monospace";
        ctx.fillText(`⚡ [${ship.liveDirective.action.toUpperCase()}]`, 0, 30);
      }
      ctx.restore();

      ctx.restore();
    }

    // Top Battle Announcements
    if (this.announcements.length > 0) {
      ctx.save();
      ctx.textAlign = "center";
      this.announcements.forEach((a, index) => {
        ctx.font = "bold 12px monospace";
        ctx.fillStyle = a.color;
        ctx.shadowColor = a.color;
        ctx.shadowBlur = 6;
        ctx.globalAlpha = Math.min(1, a.timer);
        ctx.fillText(a.text, w / 2, 24 + index * 18);
      });
      ctx.restore();
    }
  }
}
