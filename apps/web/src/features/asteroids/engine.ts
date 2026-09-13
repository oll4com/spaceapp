import { getSectorDef } from "./sectors.js";
import type { DirectorModifier, LLMModifier } from "./director.js";
import { scaleModifierForDifficulty, type DirectorZone } from "./director.js";
import { DIFFICULTY_ORDER, LEVEL_MAX, difficultyById, type DifficultyDef, type DifficultyId } from "./difficulty.js";

export type Controls = { left: boolean; right: boolean; thrust: boolean; fire: boolean; dash: boolean; bomb: boolean; swap: boolean };
export const emptyControls = (): Controls => ({ left: false, right: false, thrust: false, fire: false, dash: false, bomb: false, swap: false });
export type Upgrade = "weapon" | "shield" | "engine";
export type Cue = "fire" | "hit" | "pickup" | "hurt" | "sector" | "dash" | "rail" | "missile" | "arc" | "overheat" | "swap" | "bomb";
type Body = { x: number; y: number; vx: number; vy: number };
export type BossKind = "sentinel" | "warden" | "hive";
export type Rock = Body & { radius: number; size: number; angle: number; spin: number; shape: number[]; hp: number; boss: boolean; bossKind: BossKind; shot: number; spawnTick: number };
export type WeaponId = "blaster" | "spread" | "railgun" | "missiles" | "arc" | "orbitals";
export const WEAPONS: Record<WeaponId, { name: string; damage: number; cooldown: number; speed: number; life: number }> = {
  blaster: { name: "Blaster", damage: 1, cooldown: 0.23, speed: 540, life: 0.85 },
  spread: { name: "Spread", damage: 1, cooldown: 0.3, speed: 500, life: 0.7 },
  railgun: { name: "Railgun", damage: 4, cooldown: 0.65, speed: 900, life: 0.6 },
  missiles: { name: "Missiles", damage: 1, cooldown: 0.42, speed: 420, life: 1.6 },
  arc: { name: "Arc", damage: 2, cooldown: 0.5, speed: 0, life: 0 },
  orbitals: { name: "Orbitals", damage: 1, cooldown: 0.2, speed: 540, life: 0.85 },
};
export type EnemyKind = "weaver" | "gunship" | "kamikaze" | "splitter" | "shielder" | "miner";
export type Enemy = Body & { kind: EnemyKind; hp: number; maxHp: number; radius: number; angle: number; fireTimer: number; t: number; elite: boolean; blink: number };
export type Mine = Body & { timer: number; radius: number };
type Shot = Body & { life: number; enemy: boolean; damage: number; pierce: number; homing: boolean; weapon: WeaponId | "enemy" };
type Particle = Body & { life: number; max: number; color: "accent" | "warning" | "danger" };
type Pickup = Body & { life: number; kind: "rapid" | "shield" | "nova" | "bomb" | "weapon"; angle: number; weapon?: WeaponId };
export const SECTORS = ["Launch orbit", "Neon drift", "The debris belt", "Solar storm", "Sentinel encounter"];
export const LIMITS = { rocks: 48, shots: 120, playerShots: 70, enemyShots: 50, particles: 320, pickups: 8, enemies: 40, mines: 12 };
const TAU = Math.PI * 2;
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const wrap = (n: number, max: number) => ((n % max) + max) % max;

export class AsteroidsEngine {
  width: number;
  height: number;
  phase: "ready" | "playing" | "over" = "ready";
  ship = { x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, immunity: 2.5, dash: 0 };
  rocks: Rock[] = [];
  enemies: Enemy[] = [];
  mines: Mine[] = [];
  shots: Shot[] = [];
  particles: Particle[] = [];
  pickups: Pickup[] = [];
  cues: Cue[] = [];
  score = 0;
  lives = 3;
  sector = 1;
  combo = 0;
  comboTime = 0;
  rapid = 0;
  shield = 0;
  weaponLevel = 0;
  engineLevel = 0;
  shieldLevel = 0;
  regenTimer = 60;
  /** Shield charges scale with shield level: Lv0 = 2 … Lv5 = 7. */
  maxShieldCharges() { return 2 + Math.max(0, Math.min(5, this.shieldLevel)); }
  /** Max hull is 5, or 6 once the shield hits Lv5. */
  maxHull() { return this.shieldLevel >= 5 ? 6 : 5; }
  /** Absorb immunity per shield charge: 1.5s … 2.5s. */
  shieldImmunity() { return 1.5 + Math.max(0, Math.min(5, this.shieldLevel)) * 0.2; }
  elapsed = 0;
  launchThrust = 0;
  manualThrustTime = 0;
  banner = 0;
  shake = 0;
  kills = 0;
  shotCooldown = 0;
  clearDelay = 0;
  // --- 10x additions ---
  weapon: WeaponId = "blaster";
  unlocked: WeaponId[] = ["blaster"];
  weaponLevels: Record<WeaponId, number> = { blaster: 0, spread: 0, railgun: 0, missiles: 0, arc: 0, orbitals: 0 };
  heat = 0;
  bombs = 1;
  shotsFired = 0;
  shotsHit = 0;
  deaths = 0;
  sectorTime = 0;
  dashUses = 0;
  orbitalsAngle = 0;
  spawnMul = 1;
  enemySpeedMul = 1;
  enemyFireMul = 1;
  eliteChance = 0.08;
  pickupMul = 1;
  difficultyId: DifficultyId = 4;
  difficulty: DifficultyDef = DIFFICULTY_ORDER[3]!;
  infernoFire = false;
  directorBase: DirectorModifier = { spawnRate: 1, enemySpeed: 1, fireCooldown: 1, eliteChance: 0.08, pickupRate: 1, zone: "tense" };
  llmEvent = "none";
  llmThreat = 0;
  llmTimer = 0;
  taunt = "";
  gust = { x: 0, y: 0 };
  aiZone = "tense";
  directives: { t: number; text: string }[] = [];
  constructor(width: number, height: number, private random = Math.random) {
    this.width = Math.max(240, width);
    this.height = Math.max(240, height);
    this.resetShip();
  }
  get sectorName() { return getSectorDef(this.sector).name; }
  get accuracy() { return this.shotsFired === 0 ? 0.5 : this.shotsHit / this.shotsFired; }
  get multiplier() { return 1 + Math.min(4, Math.floor(this.combo / 4)); }
  resize(width: number, height: number) {
    const w = Math.max(240, width), h = Math.max(240, height);
    for (const body of [this.ship, ...this.rocks, ...this.enemies, ...this.mines, ...this.shots, ...this.pickups, ...this.particles]) {
      body.x = body.x / this.width * w; body.y = body.y / this.height * h;
    }
    this.width = w; this.height = h;
  }
  resetShip() {
    Object.assign(this.ship, { x: this.width / 2, y: this.height / 2, vx: 0, vy: 0, angle: -Math.PI / 2, immunity: 2.5 });
  }
  start(startSector = 1) {
    this.score = 0; this.lives = 3;
    this.sector = Math.max(1, Math.min(999, Math.floor(startSector) || 1)); this.combo = 0; this.comboTime = 0;
    this.weaponLevel = 0; this.engineLevel = 0; this.shieldLevel = 0; this.regenTimer = 60; this.shield = 0; this.rapid = 0;
    this.kills = 0; this.elapsed = 0; this.shotCooldown = 0; this.ship.dash = 0;
    this.weapon = "blaster"; this.unlocked = ["blaster"];
    this.weaponLevels = { blaster: 0, spread: 0, railgun: 0, missiles: 0, arc: 0, orbitals: 0 };
    this.heat = 0; this.bombs = 1; this.shotsFired = 0; this.shotsHit = 0; this.deaths = 0;
    this.enemies = []; this.mines = [];
    this.directorBase = { spawnRate: 1, enemySpeed: 1, fireCooldown: 1, eliteChance: 0.08, pickupRate: 1, zone: "tense" };
    this.recomputeDifficulty();
    this.llmEvent = "none"; this.llmThreat = 0; this.llmTimer = 0; this.taunt = "";
    this.autoUpgradeText = ""; this.autoUpgradeUntil = 0;
    this.directives = [];
    this.particles = []; this.cues = []; this.resetShip(); this.beginSector();
    this.ship.vy = -110; this.launchThrust = .9; this.manualThrustTime = 0;
  }
  waveBudget = 0;
  waveTimer = 0;
  waveInterval = 4;
  beginSector() {
    this.phase = "playing"; this.rocks = []; this.enemies = []; this.mines = []; this.shots = []; this.pickups = [];
    this.clearDelay = 0; this.banner = 2.8; this.sectorTime = 0;
    // Sustained pressure: trickle waves for most of the sector, scaled by difficulty.
    // 0.5x waves at LEVEL 1 … 2.5x at LEVEL 10; boss sectors get a lighter budget.
    const lvl = this.difficultyId;
    const def0 = getSectorDef(this.sector);
    const diffFactor = 0.5 + (lvl - 1) * (2 / 9);
    this.waveBudget = Math.round(((def0.boss !== "none" ? 3 : 4) + this.sector) * diffFactor);
    this.waveInterval = Math.max(1.5, 6 - (lvl - 1) * 0.5);
    this.waveTimer = this.waveInterval;
    this.ship.immunity = Math.max(2.5, this.ship.immunity);
    const def = getSectorDef(this.sector);
    const count = def.boss !== "none" ? Math.min(def.rocks, 3) : Math.min(10, def.rocks);
    for (let i = 0; i < count; i++) this.spawnRock(3);
    // Director-scaled enemies from sector mix.
    const mix = { ...def.enemies };
    for (const [kind, n] of Object.entries(mix)) {
      const scaled = Math.round((n as number) * this.spawnMul);
      for (let i = 0; i < scaled; i++) this.spawnEnemy(kind as EnemyKind);
    }
    // LLM event extras.
    if (this.llmEvent === "ambush" || this.llmEvent === "elite-pack") {
      for (let i = 0; i < 2; i++) this.spawnEnemy("weaver", true);
    }
    // Hunter packs scale with difficulty: constant pressure from mid levels up.
    if (this.infernoFire) {
      this.spawnEnemy("kamikaze", true);
      this.spawnEnemy("kamikaze", true);
      this.spawnEnemy("weaver", true);
      this.spawnEnemy("weaver", true);
      if (this.sector >= 2) this.spawnEnemy("gunship", true);
    } else if (lvl >= 7) {
      this.spawnEnemy("kamikaze", true);
      this.spawnEnemy("weaver", true);
    } else if (lvl >= 5 && this.sector >= 3) {
      this.spawnEnemy("weaver");
    }
    if (def.boss !== "none") this.spawnRock(5, undefined, undefined, true, def.boss);
    else if (this.sector % 5 === 0) this.spawnRock(5, undefined, undefined, true, "sentinel");
    this.cues.push("sector");
  }
  autoUpgradeText = "";
  autoUpgradeUntil = 0;
  /**
   * Smart automatic upgrade on sector clear — no clicks, no pause.
   * Hurt hull pulls shield, otherwise the lowest of the three 0-5 tracks wins.
   */
  autoUpgrade(): Upgrade {
    let choice: Upgrade;
    if (this.lives < 3 && this.shieldLevel < 5) {
      choice = "shield";
    } else {
      const tracks: { id: Upgrade; lvl: number }[] = [
        { id: "weapon" as Upgrade, lvl: this.weaponLevel },
        { id: "shield" as Upgrade, lvl: this.shieldLevel },
        { id: "engine" as Upgrade, lvl: this.engineLevel },
      ].filter(t => t.lvl < 5);
      // Lowest track first; ties keep weapon > shield > engine order (stable).
      tracks.sort((a, b) => a.lvl - b.lvl);
      choice = tracks[0]?.id ?? "weapon";
    }
    if (choice === "weapon") {
      this.weaponLevel = Math.min(5, this.weaponLevel + 1);
      this.weaponLevels[this.weapon] = Math.min(5, this.weaponLevels[this.weapon]! + 1);
      // Every 2nd weapon upgrade unlocks the next weapon.
      const order: WeaponId[] = ["blaster", "spread", "railgun", "missiles", "arc", "orbitals"];
      const next = order.find(w => !this.unlocked.includes(w));
      if (next && this.weaponLevel % 2 === 0) this.unlockWeapon(next);
    }
    if (choice === "shield") {
      this.shieldLevel = Math.min(5, this.shieldLevel + 1);
      this.lives = Math.min(this.maxHull(), this.lives + 1);
      this.shield = this.maxShieldCharges();
    }
    if (choice === "engine") this.engineLevel = Math.min(5, this.engineLevel + 1);
    this.autoUpgradeText = choice === "weapon" ? "OVERCLOCK" : choice === "shield" ? "SAFE ORBIT" : "WARP DRIVE";
    this.autoUpgradeUntil = this.elapsed + 3.2;
    this.logDirective(`auto-upgrade=${choice}`);
    return choice;
  }
  unlockWeapon(id: WeaponId) {
    if (!this.unlocked.includes(id)) { this.unlocked.push(id); this.cues.push("swap"); }
  }
  setWeapon(id: WeaponId) {
    if (!this.unlocked.includes(id) || this.weapon === id) return;
    this.weapon = id; this.heat = 0; this.cues.push("swap");
  }
  swapWeapon() {
    const i = this.unlocked.indexOf(this.weapon);
    this.setWeapon(this.unlocked[(i + 1) % this.unlocked.length]!);
  }
  setDifficulty(id: DifficultyId) {
    this.difficultyId = id;
    this.difficulty = difficultyById(id);
    this.recomputeDifficulty();
  }
  setInfernoFire(active: boolean) {
    const next = active && this.difficultyId === LEVEL_MAX;
    if (next === this.infernoFire) return;
    this.infernoFire = next;
    this.recomputeDifficulty(true);
  }
  private recomputeDifficulty(forceZoneLog = false) {
    const scaled = scaleModifierForDifficulty(this.directorBase, this.difficulty);
    this.spawnMul = scaled.spawnRate;
    this.enemySpeedMul = scaled.enemySpeed;
    this.enemyFireMul = scaled.fireCooldown;
    this.eliteChance = scaled.eliteChance;
    this.pickupMul = scaled.pickupRate;
    if (this.infernoFire) {
      // Inferno fire floor: hardest pressure even if the local director wants calm.
      this.spawnMul = Math.max(this.spawnMul, 1.6);
      this.enemySpeedMul = Math.max(this.enemySpeedMul, 1.35);
      this.enemyFireMul = Math.min(this.enemyFireMul, 0.6);
      this.eliteChance = Math.max(this.eliteChance, 0.32);
      this.pickupMul = Math.min(this.pickupMul, 0.6);
      if (this.aiZone !== "inferno" || forceZoneLog) {
        this.aiZone = "inferno";
        this.logDirective(`INFERNO FIRE difficulty=inferno spawn=${this.spawnMul.toFixed(2)} speed=${this.enemySpeedMul.toFixed(2)} fire=${this.enemyFireMul.toFixed(2)} elite=${this.eliteChance.toFixed(2)} drops=${this.pickupMul.toFixed(2)}`);
      }
      return;
    }
    const zone: DirectorZone = this.directorBase.zone;
    if (zone !== this.aiZone || forceZoneLog) {
      this.aiZone = zone;
      if (forceZoneLog) {
        this.logDirective(`difficulty=${this.difficultyId} spawn=${this.spawnMul.toFixed(2)} speed=${this.enemySpeedMul.toFixed(2)} fire=${this.enemyFireMul.toFixed(2)} elite=${this.eliteChance.toFixed(2)} drops=${this.pickupMul.toFixed(2)}`);
      }
    }
  }
  applyDirector(m: DirectorModifier) {
    this.directorBase = { ...m };
    const previousZone = this.aiZone;
    this.recomputeDifficulty(false);
    const effectiveZone = this.infernoFire ? "inferno" : m.zone;
    if (effectiveZone !== previousZone && !this.infernoFire) {
      this.logDirective(`zone=${m.zone} spawn=${this.spawnMul.toFixed(2)} speed=${this.enemySpeedMul.toFixed(2)} fire=${this.enemyFireMul.toFixed(2)} elite=${this.eliteChance.toFixed(2)} drops=${this.pickupMul.toFixed(2)}`);
    }
  }
  applyLLM(m: LLMModifier) {
    this.llmEvent = m.event; this.llmThreat = m.threat; this.llmTimer = 20;
    this.taunt = this.infernoFire && m.taunt ? `INFERNO: ${m.taunt}`.slice(0, 60) : m.taunt;
    this.spawnMul = clamp(this.spawnMul * m.spawnRate, 0.4, 2.2);
    this.logDirective(`LLM event=${m.event} threat=${m.threat.toFixed(2)} spawn=${m.spawnRate.toFixed(2)}${m.taunt ? ` say="${this.taunt}"` : ""}`);
  }
  logDirective(text: string) {
    this.directives.push({ t: this.elapsed, text });
    if (this.directives.length > 8) this.directives.splice(0, this.directives.length - 8);
  }
  spawnRock(size: number, x?: number, y?: number, boss = false, bossKind: BossKind = "sentinel") {
    if (this.rocks.length >= LIMITS.rocks) return;
    let px = x ?? this.random() * this.width, py = y ?? this.random() * this.height;
    if (x === undefined && this.distance({ x: px, y: py }, this.ship) < Math.min(200, this.width * .35)) {
      px = wrap(this.ship.x + this.width * .45, this.width); py = wrap(this.ship.y + this.height * .42, this.height);
    }
    const angle = this.random() * TAU;
    const speed = (25 + this.random() * 35 + Math.min(80, this.sector * 5)) * (boss ? .55 : 1 + (3 - size) * .24) * (boss ? 1 : this.enemySpeedMul);
    this.rocks.push({ x: px, y: py, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      radius: boss ? 57 : size * 12 + 5, size, angle, spin: (this.random() - .5) * 1.6,
      shape: Array.from({ length: boss ? 12 : 9 }, () => .72 + this.random() * .28),
      hp: boss ? Math.round((28 + Math.floor(this.sector / 5) * 12) * (1 + (this.difficultyId - 1) * 0.08 + (this.difficultyId >= 9 ? 0.15 : 0) + (this.difficultyId >= 10 ? 0.15 : 0))) : 1, boss, bossKind, shot: 2, spawnTick: 0 });
  }
  spawnEnemy(kind: EnemyKind, forceElite = false) {
    const enemyCap = this.difficultyId >= 8 ? LIMITS.enemies + 20 : LIMITS.enemies;
    if (this.enemies.length >= enemyCap) return;
    const elite = forceElite || this.random() < this.eliteChance;
    const a = this.random() * TAU;
    const dist = Math.min(this.width, this.height) * (0.35 + this.random() * 0.2);
    const x = wrap(this.ship.x + Math.cos(a) * dist, this.width);
    const y = wrap(this.ship.y + Math.sin(a) * dist, this.height);
    const base: Record<EnemyKind, { hp: number; radius: number }> = {
      weaver: { hp: 1, radius: 13 }, gunship: { hp: 2, radius: 15 }, kamikaze: { hp: 1, radius: 12 },
      splitter: { hp: 3, radius: 18 }, shielder: { hp: 3, radius: 16 }, miner: { hp: 2, radius: 15 },
    };
    const hpBonus = this.difficultyId >= 10 ? 3 : this.difficultyId >= 9 ? 2 : this.difficultyId >= 7 ? 1 : 0;
    const hp = (base[kind].hp + Math.floor(this.sector / 4) + hpBonus) * (elite ? 3 : 1);
    this.enemies.push({ x, y, vx: 0, vy: 0, kind, hp, maxHp: hp, radius: base[kind].radius + (elite ? 4 : 0),
      angle: this.random() * TAU, fireTimer: 1 + this.random() * 2, t: this.random() * 10, elite, blink: 0 });
  }
  spawnMine(x: number, y: number) {
    if (this.mines.length >= LIMITS.mines) return;
    this.mines.push({ x, y, vx: 0, vy: 0, timer: 6, radius: 12 });
  }
  /**
   * Mid-sector trickle wave. Budget-gated so the sector always ends:
   * waves only fire while budget remains, and the wave is skipped (not
   * consumed) when the field is already at the enemy cap.
   */
  spawnWave() {
    if (this.waveBudget <= 0 || this.phase !== "playing") return;
    const enemyCap = this.difficultyId >= 8 ? LIMITS.enemies + 20 : LIMITS.enemies;
    if (this.enemies.length >= enemyCap) return;
    const def = getSectorDef(this.sector);
    const keys = Object.keys(def.enemies);
    const pool = (keys.length ? keys : ["weaver"]) as EnemyKind[];
    const bossAlive = this.rocks.some(r => r.boss);
    const lvl = this.difficultyId;
    const n = bossAlive ? 1 : 1 + (lvl >= 6 ? 1 : 0) + (lvl >= 10 ? 1 : 0);
    for (let i = 0; i < n && this.enemies.length < enemyCap; i++) {
      this.spawnEnemy(pool[Math.floor(this.random() * pool.length)]!);
    }
    if (!bossAlive && this.random() < 0.25 * this.spawnMul && this.rocks.length < LIMITS.rocks) {
      this.spawnRock(this.random() < 0.3 ? 3 : 2);
    }
    this.waveBudget--;
  }
  distance(a: { x: number; y: number }, b: { x: number; y: number }) {
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    return Math.hypot(Math.min(dx, this.width - dx), Math.min(dy, this.height - dy));
  }
  burst(x: number, y: number, color: "accent" | "warning" | "danger", count = 15) {
    for (let i = 0; i < count && this.particles.length < LIMITS.particles; i++) {
      const a = this.random() * TAU, speed = 25 + this.random() * 150, life = .25 + this.random() * .45;
      this.particles.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, life, max: life, color });
    }
  }
  destroyRock(rock: Rock) {
    const index = this.rocks.indexOf(rock);
    if (index < 0) return;
    this.rocks.splice(index, 1); this.combo++; this.comboTime = 3; this.kills++;
    this.score += Math.round((rock.boss ? 2000 : (4 - rock.size) * 60) * this.multiplier * this.difficulty.scoreMul);
    this.burst(rock.x, rock.y, rock.boss ? "warning" : "accent", rock.boss ? 60 : 14);
    this.cues.push("hit"); this.shake = rock.boss ? 5 : 1.5;
    if (rock.size > 1 && !rock.boss) {
      this.spawnRock(rock.size - 1, rock.x, rock.y); this.spawnRock(rock.size - 1, rock.x, rock.y);
    }
    // Hive death releases its brood as score only (no cascade).
    if (rock.boss) this.dropPickup(rock.x, rock.y, true);
    else if ((this.kills % 7 === 0) && this.pickups.length < LIMITS.pickups) this.dropPickup(rock.x, rock.y, false);
  }
  destroyEnemy(e: Enemy) {
    const i = this.enemies.indexOf(e);
    if (i < 0) return;
    this.enemies.splice(i, 1); this.combo++; this.comboTime = 3; this.kills++;
    const base = e.kind === "splitter" ? 220 : e.kind === "gunship" ? 180 : e.kind === "shielder" ? 200 : 120;
    this.score += Math.round(base * (e.elite ? 3 : 1) * this.multiplier * this.difficulty.scoreMul);
    this.burst(e.x, e.y, e.elite ? "warning" : "accent", e.elite ? 30 : 14);
    this.cues.push("hit"); this.shake = Math.max(this.shake, e.elite ? 3 : 1.5);
    if (e.kind === "splitter") { for (let k = 0; k < 2; k++) this.spawnEnemy("weaver"); }
    if (e.kind === "miner") { this.spawnMine(e.x - 10, e.y); this.spawnMine(e.x + 10, e.y); }
    if (e.elite || this.random() < 0.12 * this.pickupMul) this.dropPickup(e.x, e.y, e.elite);
  }
  dropPickup(x: number, y: number, guaranteed: boolean) {
    if (this.pickups.length >= LIMITS.pickups) return;
    if (!guaranteed && this.random() > 0.5 * this.pickupMul) return;
    const roll = this.random();
    // High difficulty skews drops toward higher tiers so brutal sectors stay survivable.
    const hi = this.difficultyId >= 8 ? 0.1 : this.difficultyId >= 6 ? 0.05 : 0;
    if (roll < 0.3 - hi) this.pickups.push({ x, y, vx: 0, vy: 0, life: 12, kind: "rapid", angle: 0 });
    else if (roll < 0.55 - hi) this.pickups.push({ x, y, vx: 0, vy: 0, life: 12, kind: "shield", angle: 0 });
    else if (roll < 0.7) this.pickups.push({ x, y, vx: 0, vy: 0, life: 12, kind: "nova", angle: 0 });
    else if (roll < 0.85) this.pickups.push({ x, y, vx: 0, vy: 0, life: 14, kind: "bomb", angle: 0 });
    else {
      const locked: WeaponId[] = ["spread", "railgun", "missiles", "arc", "orbitals"];
      const next = locked.find(w => !this.unlocked.includes(w));
      this.pickups.push({ x, y, vx: 0, vy: 0, life: 14, kind: "weapon", angle: 0, weapon: next ?? "spread" });
    }
  }
  hurt() {
    if (this.ship.immunity > 0 || this.phase !== "playing") return;
    if (this.shield > 0) { this.shield--; this.ship.immunity = this.shieldImmunity(); this.cues.push("pickup"); return; }
    this.burst(this.ship.x, this.ship.y, "danger", 40);
    this.lives--; this.deaths++; this.combo = 0; this.comboTime = 0; this.shake = 6; this.cues.push("hurt");
    if (this.lives <= 0) this.phase = "over";
    else this.resetShip();
  }
  useBomb() {
    if (this.phase !== "playing" || this.bombs <= 0) return;
    this.bombs--; this.cues.push("bomb"); this.shake = 6;
    this.burst(this.ship.x, this.ship.y, "warning", 60);
    for (const rock of [...this.rocks]) { if (!rock.boss) this.destroyRock(rock); else rock.hp = Math.max(1, rock.hp - 12); }
    for (const e of [...this.enemies]) this.destroyEnemy(e);
    this.mines = []; this.shots = this.shots.filter(s => !s.enemy);
    this.ship.immunity = Math.max(1.5, this.ship.immunity);
  }
  /** Player bullets have their own budget, so enemy fire can never starve the trigger. */
  playerShotCount() { let n = 0; for (const s of this.shots) if (!s.enemy) n++; return n; }
  enemyShotCount() { let n = 0; for (const s of this.shots) if (s.enemy) n++; return n; }
  fire() {
    if (this.heat >= 1) { this.cues.push("overheat"); return; }
    const lvl = this.weaponLevels[this.weapon]!;
    if (this.weapon === "arc") { this.fireArc(lvl); return; }
    if (this.playerShotCount() >= LIMITS.playerShots) return;
    const w = WEAPONS[this.weapon]!;
    const mk = (a: number, speed: number, damage: number, pierce: number, homing: boolean, life: number) => {
      this.shots.push({ x: wrap(this.ship.x + Math.cos(a) * 18, this.width), y: wrap(this.ship.y + Math.sin(a) * 18, this.height),
        vx: Math.cos(a) * speed + this.ship.vx * .25, vy: Math.sin(a) * speed + this.ship.vy * .25, life, enemy: false, damage, pierce, homing, weapon: this.weapon });
      this.shotsFired++;
    };
    if (this.weapon === "blaster") {
      const angles = this.rapid > 0 ? [-.17, 0, .17] : [0];
      for (const o of angles) mk(this.ship.angle + o, w.speed, w.damage + Math.floor(lvl / 2), 0, false, w.life);
      this.heat = Math.min(1, this.heat + 0.06);
      this.shotCooldown = Math.max(0.09, w.cooldown - this.weaponLevel * .024 - lvl * 0.008);
      this.cues.push("fire");
    } else if (this.weapon === "spread") {
      const n = 5;
      for (let i = 0; i < n; i++) mk(this.ship.angle + (i - (n - 1) / 2) * 0.14, w.speed, w.damage, 0, false, w.life);
      this.heat = Math.min(1, this.heat + 0.1);
      this.shotCooldown = Math.max(0.14, w.cooldown - lvl * 0.015);
      this.cues.push("fire");
    } else if (this.weapon === "railgun") {
      mk(this.ship.angle, w.speed, w.damage + lvl, 99, false, w.life);
      this.heat = Math.min(1, this.heat + 0.22);
      this.shotCooldown = Math.max(0.3, w.cooldown - lvl * 0.03);
      this.cues.push("rail");
    } else if (this.weapon === "missiles") {
      const n = 2 + Math.min(1, Math.floor(lvl / 2));
      for (let i = 0; i < n; i++) mk(this.ship.angle + (i - (n - 1) / 2) * 0.3, w.speed * (0.9 + i * 0.1), w.damage, 0, true, w.life);
      this.heat = Math.min(1, this.heat + 0.09);
      this.shotCooldown = Math.max(0.2, w.cooldown - lvl * 0.02);
      this.cues.push("missile");
    } else if (this.weapon === "orbitals") {
      mk(this.ship.angle, w.speed, w.damage + Math.floor(lvl / 3), 0, false, w.life);
      this.heat = Math.min(1, this.heat + 0.05);
      this.shotCooldown = Math.max(0.1, w.cooldown - lvl * 0.01);
      this.cues.push("fire");
    }
  }
  fireArc(lvl: number) {
    // Instant chain lightning to nearest targets.
    const targets: { x: number; y: number; rock?: Rock; enemy?: Enemy }[] = [
      ...this.rocks.map(r => ({ x: r.x, y: r.y, rock: r })),
      ...this.enemies.map(e => ({ x: e.x, y: e.y, enemy: e })),
    ].sort((a, b) => this.distance(a, this.ship) - this.distance(b, this.ship)).slice(0, 3 + Math.floor(lvl / 2));
    const range = 240 + lvl * 15;
    let chained = 0;
    for (const t of targets) {
      if (this.distance(t, this.ship) > range) continue;
      chained++; this.shotsFired++;
      this.burst(t.x, t.y, "accent", 6);
      if (t.rock) { t.rock.hp -= 2; if (t.rock.hp <= 0) this.destroyRock(t.rock); else this.shotsHit++; }
      if (t.enemy) { t.enemy.hp -= 2; if (t.enemy.hp <= 0) this.destroyEnemy(t.enemy); else this.shotsHit++; }
    }
    this.heat = Math.min(1, this.heat + 0.14);
    this.shotCooldown = Math.max(0.25, 0.5 - lvl * 0.03);
    this.cues.push("arc");
    if (!chained) this.shotCooldown = 0.15;
  }
  step(delta: number, controls: Controls) {
    if (this.phase !== "playing") return;
    const dt = clamp(delta, 0, .034); // A stalled tab never teleports through a wave.
    this.launchThrust = Math.max(0, this.launchThrust - dt);
    if (controls.thrust) this.manualThrustTime += dt;
    this.elapsed += dt; this.sectorTime += dt;
    this.banner = Math.max(0, this.banner - dt); this.shake = Math.max(0, this.shake - dt * 18);
    this.comboTime = Math.max(0, this.comboTime - dt); if (!this.comboTime) this.combo = 0;
    this.rapid = Math.max(0, this.rapid - dt); this.ship.immunity = Math.max(0, this.ship.immunity - dt);
    this.ship.dash = Math.max(0, this.ship.dash - dt); this.shotCooldown -= dt;
    this.heat = Math.max(0, this.heat - dt * 0.75); // Sustained basic fire must never flatline the trigger.
    this.llmTimer = Math.max(0, this.llmTimer - dt);
    if (!this.llmTimer) { this.llmEvent = "none"; this.taunt = ""; }
    // Shield regen: Lv3+ regrows hull slowly (up to 3).
    if (this.shieldLevel >= 3 && this.lives > 0 && this.lives < 3) {
      this.regenTimer -= dt;
      if (this.regenTimer <= 0) {
        this.lives++;
        this.regenTimer = this.shieldLevel >= 5 ? 40 : 60;
        this.burst(this.ship.x, this.ship.y, "accent", 12);
      }
    } else {
      this.regenTimer = this.shieldLevel >= 5 ? 40 : 60;
    }
    // Sustained pressure: trickle waves while budget remains.
    if (this.waveBudget > 0) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) { this.waveTimer = this.waveInterval; this.spawnWave(); }
    }
    // Solar gust hazard.
    const def = getSectorDef(this.sector);
    if (def.hazards.includes("gust")) {
      this.gust.x = Math.sin(this.elapsed * 0.7) * 60; this.gust.y = Math.cos(this.elapsed * 0.5) * 40;
    } else { this.gust.x = 0; this.gust.y = 0; }
    this.ship.angle += (Number(controls.right) - Number(controls.left)) * (3.8 + this.engineLevel * .12) * dt;
    if (controls.thrust || this.launchThrust > 0) {
      const acceleration = 290 + this.engineLevel * 30;
      this.ship.vx += Math.cos(this.ship.angle) * acceleration * dt; this.ship.vy += Math.sin(this.ship.angle) * acceleration * dt;
    }
    this.ship.vx += this.gust.x * dt; this.ship.vy += this.gust.y * dt;
    if (controls.dash && !this.ship.dash) {
      this.ship.vx = Math.cos(this.ship.angle) * 640; this.ship.vy = Math.sin(this.ship.angle) * 640;
      this.ship.immunity = Math.max(.7, this.ship.immunity); this.ship.dash = 5 - this.engineLevel * .45;
      this.dashUses++; this.burst(this.ship.x, this.ship.y, "accent", 25); this.cues.push("dash");
    }
    if (controls.bomb) this.useBomb();
    if (controls.swap) { this.swapWeapon(); controls.swap = false; }
    const drag = Math.exp(-dt * .52); this.ship.vx *= drag; this.ship.vy *= drag;
    const speed = Math.hypot(this.ship.vx, this.ship.vy), maxSpeed = this.ship.immunity > 0 ? 650 : 340 + this.engineLevel * 25;
    if (speed > maxSpeed) { this.ship.vx *= maxSpeed / speed; this.ship.vy *= maxSpeed / speed; }
    if (controls.fire && this.shotCooldown <= 0) this.fire();
    this.move(this.ship, dt);
    this.orbitalsAngle += dt * 3;
    this.updateRocks(dt);
    this.updateEnemies(dt);
    this.updateMines(dt);
    this.updateShots(dt);
    for (const particle of this.particles) { this.move(particle, dt); particle.life -= dt; }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const pickup of this.pickups) {
      pickup.life -= dt; pickup.angle += dt;
      const distance = this.distance(pickup, this.ship);
      if (distance < 110) { // Gentle tractor beam makes rewards collectible on touch screens.
        const dx = wrap(this.ship.x - pickup.x + this.width / 2, this.width) - this.width / 2;
        const dy = wrap(this.ship.y - pickup.y + this.height / 2, this.height) - this.height / 2;
        pickup.x = wrap(pickup.x + dx * dt * 3, this.width); pickup.y = wrap(pickup.y + dy * dt * 3, this.height);
      }
      if (distance < 25) {
        pickup.life = 0; this.score += 150; this.cues.push("pickup");
        if (pickup.kind === "rapid") this.rapid = 12;
        if (pickup.kind === "shield") this.shield = Math.min(this.maxShieldCharges(), this.shield + 1);
        if (pickup.kind === "bomb") this.bombs = Math.min(3, this.bombs + 1);
        if (pickup.kind === "weapon" && pickup.weapon) { this.unlockWeapon(pickup.weapon); this.setWeapon(pickup.weapon); }
        if (pickup.kind === "nova") {
          for (const rock of [...this.rocks]) { if (!rock.boss) this.destroyRock(rock); else rock.hp = Math.max(1, rock.hp - 12); }
          for (const e of [...this.enemies]) this.destroyEnemy(e);
          this.mines = []; this.shots = this.shots.filter(s => !s.enemy); this.ship.immunity = Math.max(1.5, this.ship.immunity);
        }
      }
    }
    this.pickups = this.pickups.filter(p => p.life > 0);
    // Orbitals contact damage.
    if (this.weapon === "orbitals" || this.unlocked.includes("orbitals")) {
      const lvl = this.weaponLevels.orbitals!;
      const n = 2, R = 46;
      for (let i = 0; i < n; i++) {
        const a = this.orbitalsAngle + (i * TAU) / n;
        const ox = wrap(this.ship.x + Math.cos(a) * R, this.width), oy = wrap(this.ship.y + Math.sin(a) * R, this.height);
        const rock = this.rocks.find(r => Math.hypot(r.x - ox, r.y - oy) < r.radius * 0.85 + 6);
        if (rock) { rock.hp -= (1 + Math.floor(lvl / 2)) * dt * 6; if (rock.hp <= 0) this.destroyRock(rock); }
      }
    }
    if (!this.rocks.length && !this.enemies.length && this.phase === "playing") {
      this.clearDelay += dt;
      if (this.clearDelay >= 1.2) {
        // Seamless sector transition: auto-upgrade and dive into the next sector.
        this.clearDelay = 0;
        this.score += Math.round(this.sector * 250 * this.difficulty.scoreMul);
        // High-difficulty sector rewards keep brutal runs survivable.
        if (this.difficultyId >= 7) this.bombs = Math.min(5, this.bombs + 1);
        if (this.difficultyId >= 8) this.shield = this.maxShieldCharges();
        if (this.difficultyId >= 9) this.lives = Math.min(this.maxHull(), this.lives + 1);
        this.shots = [];
        this.autoUpgrade();
        this.sector++;
        this.beginSector();
      }
    }
    if (this.cues.length > 24) this.cues.splice(0, this.cues.length - 24);
  }
  private updateRocks(dt: number) {
    for (const rock of this.rocks) {
      this.move(rock, dt); rock.angle += rock.spin * dt; rock.spawnTick += dt;
      if (rock.boss) {
        rock.shot -= dt;
        if (rock.shot <= 0 && this.enemyShotCount() < LIMITS.enemyShots) {
          const a = Math.atan2(this.ship.y - rock.y, this.ship.x - rock.x);
          const cd = Math.max(.85, 1.9 - this.sector * .025) * this.enemyFireMul * (this.infernoFire ? 0.7 : 1);
          if (rock.bossKind === "warden") {
            const ring = this.infernoFire ? 14 : 10;
            for (let i = 0; i < ring && this.enemyShotCount() < LIMITS.enemyShots; i++) {
              const aa = (i / ring) * TAU + rock.angle;
              this.shots.push({ x: rock.x, y: rock.y, vx: Math.cos(aa) * 140, vy: Math.sin(aa) * 140, life: 3.5, enemy: true, damage: 1, pierce: 0, homing: false, weapon: "enemy" });
            }
          } else {
            const spread = this.infernoFire ? 3 : 2;
            for (let i = -spread; i <= spread && this.enemyShotCount() < LIMITS.enemyShots; i++) this.shots.push({ x: rock.x, y: rock.y, vx: Math.cos(a + i * .24) * 155, vy: Math.sin(a + i * .24) * 155, life: 3.5, enemy: true, damage: 1, pierce: 0, homing: false, weapon: "enemy" });
          }
          if (rock.bossKind === "hive" && this.enemies.length < LIMITS.enemies - 2) {
            const brood = this.infernoFire ? 4 : 2;
            for (let i = 0; i < brood; i++) this.spawnEnemy("weaver");
          }
          if (this.infernoFire) this.burst(rock.x, rock.y, "danger", 6);
          rock.shot = cd;
        } else if (this.infernoFire && this.random() < dt * 4) {
          this.burst(rock.x, rock.y, "danger", 1);
        }
      }
      if (this.distance(this.ship, rock) < rock.radius * .8 + 9) this.hurt();
    }
  }
  private updateEnemies(dt: number) {
    for (const e of this.enemies) {
      e.t += dt; e.blink = Math.max(0, e.blink - dt);
      const dx = wrap(this.ship.x - e.x + this.width / 2, this.width) - this.width / 2;
      const dy = wrap(this.ship.y - e.y + this.height / 2, this.height) - this.height / 2;
      const dist = Math.hypot(dx, dy) || 1;
      const fireBoost = this.infernoFire ? 1.3 : 1;
      const sp = (e.kind === "weaver" ? 120 : e.kind === "kamikaze" ? 150 : e.kind === "gunship" ? 80 : 60) * this.enemySpeedMul * (e.elite ? 1.2 : 1) * (this.infernoFire && (e.kind === "weaver" || e.kind === "kamikaze") ? fireBoost : 1);
      if (e.kind === "weaver") {
        const zig = Math.sin(e.t * 5) * 0.8;
        const a = Math.atan2(dy, dx) + zig;
        e.vx += (Math.cos(a) * sp - e.vx) * dt * 2; e.vy += (Math.sin(a) * sp - e.vy) * dt * 2;
      } else if (e.kind === "kamikaze") {
        if (dist < 260 && e.blink === 0) e.blink = 0.8; // warning blink before charge
        const charge = e.blink > 0 ? 0.4 : this.infernoFire ? 2.1 : 1.6;
        e.vx += ((dx / dist) * sp * charge - e.vx) * dt * 2; e.vy += ((dy / dist) * sp * charge - e.vy) * dt * 2;
      } else if (e.kind === "gunship") {
        const want = 220;
        const dir = dist > want + 30 ? 1 : dist < want - 30 ? -1 : 0;
        e.vx += ((dx / dist) * sp * dir - e.vx) * dt * 1.5; e.vy += ((dy / dist) * sp * dir - e.vy) * dt * 1.5;
        e.fireTimer -= dt;
        const range = this.infernoFire ? 620 : 480;
        if (e.fireTimer <= 0 && this.enemyShotCount() < LIMITS.enemyShots && dist < range) {
          const a = Math.atan2(dy, dx);
          this.shots.push({ x: e.x, y: e.y, vx: Math.cos(a) * 165, vy: Math.sin(a) * 165, life: 3, enemy: true, damage: 1, pierce: 0, homing: false, weapon: "enemy" });
          if (this.infernoFire && this.enemyShotCount() < LIMITS.enemyShots) {
            this.shots.push({ x: e.x, y: e.y, vx: Math.cos(a + 0.18) * 165, vy: Math.sin(a + 0.18) * 165, life: 3, enemy: true, damage: 1, pierce: 0, homing: false, weapon: "enemy" });
          }
          e.fireTimer = (1.6 + this.random() * 1.2) * this.enemyFireMul * (this.infernoFire ? 0.75 : 1);
        }
      } else if (e.kind === "miner") {
        e.vx += (Math.cos(e.t * 0.6) * 40 - e.vx) * dt; e.vy += (Math.sin(e.t * 0.6) * 40 - e.vy) * dt;
        e.fireTimer -= dt;
        if (e.fireTimer <= 0) { this.spawnMine(e.x, e.y); e.fireTimer = 4 * this.enemyFireMul * (this.infernoFire ? 0.7 : 1); }
      } else {
        // splitter / shielder drift toward player slowly
        e.vx += ((dx / dist) * sp * 0.5 - e.vx) * dt; e.vy += ((dy / dist) * sp * 0.5 - e.vy) * dt;
      }
      e.vx += this.gust.x * dt * 0.5; e.vy += this.gust.y * dt * 0.5;
      if (this.infernoFire && (e.elite || e.kind === "kamikaze") && this.random() < dt * 6) {
        this.burst(e.x, e.y, "danger", 1);
      }
      this.move(e, dt);
      if (this.distance(this.ship, e) < e.radius + 9) {
        if (e.kind === "kamikaze") { this.burst(e.x, e.y, "danger", 25); this.destroyEnemy(e); }
        this.hurt();
      }
    }
  }
  private updateMines(dt: number) {
    for (const m of [...this.mines]) {
      m.timer -= dt;
      if (m.timer <= 0) {
        this.burst(m.x, m.y, "danger", 30); this.shake = Math.max(this.shake, 3);
        if (this.distance(m, this.ship) < 70) this.hurt();
        for (const rock of [...this.rocks]) if (!rock.boss && this.distance(m, rock) < 80) this.destroyRock(rock);
        this.mines.splice(this.mines.indexOf(m), 1);
      } else if (this.distance(m, this.ship) < m.radius + 9) {
        this.burst(m.x, m.y, "danger", 30); this.mines.splice(this.mines.indexOf(m), 1); this.hurt();
      }
    }
  }
  private updateShots(dt: number) {
    for (const shot of this.shots) {
      if (shot.homing && !shot.enemy) {
        const target = [...this.enemies, ...this.rocks].sort((a, b) => this.distance(shot, a) - this.distance(shot, b))[0];
        if (target) {
          const want = Math.atan2(target.y - shot.y, target.x - shot.x);
          const cur = Math.atan2(shot.vy, shot.vx);
          let d = want - cur;
          while (d > Math.PI) d -= TAU; while (d < -Math.PI) d += TAU;
          const na = cur + clamp(d, -3.5 * dt, 3.5 * dt);
          const sp = Math.hypot(shot.vx, shot.vy);
          shot.vx = Math.cos(na) * sp; shot.vy = Math.sin(na) * sp;
        }
      }
      shot.vx += this.gust.x * dt * 0.3; shot.vy += this.gust.y * dt * 0.3;
      this.move(shot, dt); shot.life -= dt;
      if (shot.life <= 0) continue;
      if (shot.enemy) {
        if (this.distance(shot, this.ship) < 13) { this.hurt(); shot.life = 0; }
      } else {
        const rock = this.rocks.find(r => this.distance(shot, r) < r.radius * .85 + 3);
        if (rock) {
          shot.life = shot.pierce > 0 ? shot.life : 0; shot.pierce--;
          rock.hp -= shot.damage; this.shotsHit++;
          if (rock.hp <= 0) this.destroyRock(rock); else this.burst(shot.x, shot.y, "warning", 3);
          continue;
        }
        const enemy = this.enemies.find(e => {
          if (e.kind !== "shielder") return this.distance(shot, e) < e.radius + 3;
          // Shielder frontal arc blocks: only side/rear hits count.
          const incoming = Math.atan2(shot.vy, shot.vx);
          const facing = Math.atan2(this.ship.y - e.y, this.ship.x - e.x);
          let diff = Math.abs(incoming - facing);
          while (diff > Math.PI) diff = Math.abs(diff - TAU);
          if (diff < 0.9) { this.burst(shot.x, shot.y, "warning", 2); return false; }
          return this.distance(shot, e) < e.radius + 3;
        });
        if (enemy) {
          shot.life = shot.pierce > 0 ? shot.life : 0; shot.pierce--;
          enemy.hp -= shot.damage; this.shotsHit++;
          if (enemy.hp <= 0) this.destroyEnemy(enemy); else this.burst(shot.x, shot.y, "warning", 3);
        }
      }
    }
    this.shots = this.shots.filter(s => s.life > 0);
  }
  private move(body: Body, dt: number) { body.x = wrap(body.x + body.vx * dt, this.width); body.y = wrap(body.y + body.vy * dt, this.height); }
}
