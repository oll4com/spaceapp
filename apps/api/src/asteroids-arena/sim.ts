/**
 * Asteroids Agent Arena — deterministic benchmark simulation.
 *
 * Everything here is pure and deterministic: a fixed 30 Hz timestep, one seeded
 * scenario per round (initial rocks, hostile waves, pickups, rock refills) and
 * no randomness while stepping. The same seed and the same pilot commands always
 * replay the same round, so every model faces an identical gauntlet and the
 * server stays the only scorekeeper.
 */

export const ARENA_PROTOCOL_VERSION = "agent-arena/2";
export const TICK_HZ = 30;
export const TICK_S = 1 / TICK_HZ;
export const ARENA_WIDTH = 960;
export const ARENA_HEIGHT = 540;
export const ROUND_SECONDS = 45;
export const ROUND_TICKS = ROUND_SECONDS * TICK_HZ;
/** Lockstep decision window: 1.5 s of game time. */
export const DECISION_INTERVAL_TICKS = 45;
/** Viewers receive one snapshot every 3 ticks (10 frames per second). */
export const FRAME_INTERVAL_TICKS = 3;

export type ArenaMode = "championship" | "duel" | "shared_arena";
export const ARENA_MODES: readonly ArenaMode[] = ["championship", "duel", "shared_arena"];

export const SHIP = {
  radius: 12,
  turnRate: 3.8,
  thrust: 300,
  drag: 0.6,
  maxSpeed: 330,
  dashSpeed: 560,
  dashSeconds: 0.35,
  dashCooldown: 4,
  dashImmunity: 0.6,
  fireCooldown: 0.2,
  shotSpeed: 620,
  shotLife: 0.85,
  hitImmunity: 1.2,
  shieldImmunity: 1,
  maxHull: 5,
  startShield: 2,
  maxShield: 3,
  startBombs: 1,
  maxBombs: 2,
  bombRadius: 220,
  bombPilotDamage: 2
} as const;
export const SHOT_RANGE = SHIP.shotSpeed * SHIP.shotLife;

export const ROCK_RADIUS: Record<RockSize, number> = { 1: 12, 2: 22, 3: 38 };
export const DRONE = {
  hunter: { radius: 11, hp: 2, speed: 120, lungeRange: 170, lungeSpeed: 255 },
  gunship: { radius: 14, hp: 3, speed: 70, range: 260, fireEvery: 2.1, firstShot: 1.4, boltSpeed: 180, boltLife: 3, fireRange: 500 }
} as const;
export const PICKUP_RADIUS = 14;
export const PICKUP_TTL_S = 9;

export const SCORING = {
  rock: { 3: 10, 2: 25, 1: 50 } as Record<RockSize, number>,
  hunter: 200,
  gunship: 350,
  pilotHit: 75,
  pilotKill: 600,
  pickup: 75,
  survivalPerSecond: 10,
  hullLost: -150,
  placement: [600, 300, 150]
} as const;

export type RockSize = 1 | 2 | 3;
export type DroneKind = "hunter" | "gunship";
export type PickupKind = "shield" | "repair" | "bomb";
export const PICKUP_KINDS: readonly PickupKind[] = ["shield", "repair", "bomb"];

export interface ScoreBreakdown {
  rocks: number;
  drones: number;
  pilots: number;
  pickups: number;
  survival: number;
  damage: number;
  placement: number;
}

export interface PilotStats {
  score: number;
  breakdown: ScoreBreakdown;
  kills: { rocks: number; drones: number; pilots: number };
  shotsFired: number;
  shotsHit: number;
  hullLost: number;
  shieldAbsorbed: number;
  pickups: number;
  aliveTicks: number;
  bombsUsed: number;
  dashesUsed: number;
}

export interface ArenaShip {
  slot: number;
  pilotId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  hull: number;
  shield: number;
  bombs: number;
  dashCooldown: number;
  dashTime: number;
  fireCooldown: number;
  immunity: number;
  alive: boolean;
  destroyedAtTick: number | null;
  thrusting: boolean;
  stats: PilotStats;
}

export interface ArenaRock { id: number; x: number; y: number; vx: number; vy: number; size: RockSize; radius: number; angle: number; spin: number }
export interface ArenaDrone { id: number; kind: DroneKind; x: number; y: number; vx: number; vy: number; angle: number; hp: number; fireTimer: number }
/** owner is the firing ship slot, or -1 for a hostile drone bolt. */
export interface ArenaShot { id: number; x: number; y: number; vx: number; vy: number; life: number; owner: number }
export interface ArenaPickup { id: number; kind: PickupKind; x: number; y: number; ttl: number }

export interface ShipControls { turn: -1 | 0 | 1; thrust: boolean; fire: boolean; dash: boolean; bomb: boolean }
export const idleControls = (): ShipControls => ({ turn: 0, thrust: false, fire: false, dash: false, bomb: false });

/** Effect kinds streamed to viewers. */
export const FX = { rock: 0, drone: 1, bomb: 2, hit: 3, dash: 4, pickup: 5, destroyed: 6 } as const;

export interface ArenaFrameState {
  /** Arena key: the pilot id for split arenas, "shared" for the shared arena. */
  k: string;
  /** [slot, x, y, angle*100, hull, shield, flags(1 alive,2 thrust,4 immune,8 dash), score] */
  s: number[][];
  /** [id, x, y, size, angle*100] */
  r: number[][];
  /** [kind(0 hunter,1 gunship), x, y, angle*100, hp, id] */
  d: number[][];
  /** [x, y, vx, vy, owner] */
  b: number[][];
  /** [kind(0 shield,1 repair,2 bomb), x, y, ttl*10] */
  p: number[][];
  /** [kind, x, y, slot] */
  fx: number[][];
}

interface RockSeed { x: number; y: number; heading: number; speed: number; spin: number }
interface SpawnEvent { tick: number; kind: DroneKind | "pickup"; x: number; y: number; heading: number; pickup?: PickupKind }

export interface Scenario {
  seed: number;
  mode: ArenaMode;
  initialRocks: RockSeed[];
  refills: RockSeed[];
  events: SpawnEvent[];
  minRocks: number;
}

const TAU = Math.PI * 2;

export function hashSeed(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

/** mulberry32: small, fast and identical on every JS engine. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function wrapDelta(value: number, size: number): number {
  return ((((value + size / 2) % size) + size) % size) - size / 2;
}

export function wrapCoord(value: number, size: number): number {
  return ((value % size) + size) % size;
}

export function angleDiff(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function wrappedOffset(from: { x: number; y: number }, to: { x: number; y: number }): { dx: number; dy: number; dist: number } {
  const dx = wrapDelta(to.x - from.x, ARENA_WIDTH);
  const dy = wrapDelta(to.y - from.y, ARENA_HEIGHT);
  return { dx, dy, dist: Math.hypot(dx, dy) };
}

function edgePoint(rng: () => number): { x: number; y: number } {
  const perimeter = 2 * (ARENA_WIDTH + ARENA_HEIGHT);
  let p = rng() * perimeter;
  if (p < ARENA_WIDTH) return { x: p, y: 0 };
  p -= ARENA_WIDTH;
  if (p < ARENA_HEIGHT) return { x: ARENA_WIDTH - 1, y: p };
  p -= ARENA_HEIGHT;
  if (p < ARENA_WIDTH) return { x: ARENA_WIDTH - 1 - p, y: ARENA_HEIGHT - 1 };
  p -= ARENA_WIDTH;
  return { x: 0, y: ARENA_HEIGHT - 1 - p };
}

function rockSeed(rng: () => number, point: { x: number; y: number }, minSpeed: number, maxSpeed: number): RockSeed {
  return { x: point.x, y: point.y, heading: rng() * TAU, speed: minSpeed + rng() * (maxSpeed - minSpeed), spin: (rng() - 0.5) * 1.4 };
}

/**
 * One scenario per (mode, round seed). Split-arena modes give every pilot an
 * identical copy; the shared arena uses the same generator with denser drops.
 */
export function generateScenario(seed: number, mode: ArenaMode): Scenario {
  const rng = createRng(seed);
  const shared = mode === "shared_arena";
  const centre = { x: ARENA_WIDTH / 2, y: ARENA_HEIGHT / 2 };
  const initialRocks: RockSeed[] = [];
  const rockCount = shared ? 7 : 5;
  while (initialRocks.length < rockCount) {
    const point = { x: rng() * ARENA_WIDTH, y: rng() * ARENA_HEIGHT };
    // Rocks start in the corners: far from the solo spawn and the shared spawn ring.
    if (Math.hypot(point.x - centre.x, point.y - centre.y) < 300) continue;
    initialRocks.push(rockSeed(rng, point, 28, 62));
  }
  const refills = Array.from({ length: 48 }, () => rockSeed(rng, edgePoint(rng), 34, 70));
  const events: SpawnEvent[] = [];
  const waveTimes = shared ? [5, 12, 19, 26, 33, 40] : [3, 9, 15, 21, 27, 33, 39];
  waveTimes.forEach((seconds, wave) => {
    const hunters = 1 + Math.floor(wave / 2);
    const gunships = wave >= 1 ? 1 + Math.floor(wave / 3) : 0;
    for (let index = 0; index < hunters + gunships; index += 1) {
      const point = edgePoint(rng);
      events.push({
        tick: seconds * TICK_HZ + index * 6,
        kind: index < hunters ? "hunter" : "gunship",
        x: point.x,
        y: point.y,
        heading: Math.atan2(centre.y - point.y, centre.x - point.x) + (rng() - 0.5) * 0.8
      });
    }
  });
  const pickupTimes = shared ? [7, 14, 21, 28, 35, 41] : [9, 20, 31, 40];
  pickupTimes.forEach((seconds, index) => {
    const angle = rng() * TAU;
    const radius = 110 + rng() * 150;
    events.push({
      tick: seconds * TICK_HZ,
      kind: "pickup",
      x: wrapCoord(centre.x + Math.cos(angle) * radius * 1.6, ARENA_WIDTH),
      y: wrapCoord(centre.y + Math.sin(angle) * radius * 0.9, ARENA_HEIGHT),
      heading: 0,
      pickup: (["shield", "repair", "bomb", "shield", "repair", "bomb"] as const)[(index + Math.floor(rng() * 3)) % 3]
    });
  });
  events.sort((left, right) => left.tick - right.tick);
  return { seed, mode, initialRocks, refills, events, minRocks: shared ? 5 : 4 };
}

function emptyStats(): PilotStats {
  return {
    score: 0,
    breakdown: { rocks: 0, drones: 0, pilots: 0, pickups: 0, survival: 0, damage: 0, placement: 0 },
    kills: { rocks: 0, drones: 0, pilots: 0 },
    shotsFired: 0,
    shotsHit: 0,
    hullLost: 0,
    shieldAbsorbed: 0,
    pickups: 0,
    aliveTicks: 0,
    bombsUsed: 0,
    dashesUsed: 0
  };
}

export function totalScore(breakdown: ScoreBreakdown): number {
  return breakdown.rocks + breakdown.drones + breakdown.pilots + breakdown.pickups + breakdown.survival + breakdown.damage + breakdown.placement;
}

/** Pilot-facing log lines such as "destroyed R12 +50", drained into the next sensor snapshot. */
export type PilotEventLog = string[];

export class AgentArena {
  readonly key: string;
  readonly mode: ArenaMode;
  readonly pvp: boolean;
  readonly scenario: Scenario;
  tick = 0;
  ships: ArenaShip[];
  rocks: ArenaRock[] = [];
  drones: ArenaDrone[] = [];
  shots: ArenaShot[] = [];
  pickups: ArenaPickup[] = [];
  over = false;
  private fx: number[][] = [];
  private pilotEvents: PilotEventLog[];
  private nextId = 1;
  private refillIndex = 0;
  private eventIndex = 0;

  constructor(params: { key: string; mode: ArenaMode; scenario: Scenario; pilots: string[] }) {
    this.key = params.key;
    this.mode = params.mode;
    this.scenario = params.scenario;
    this.pvp = params.mode === "shared_arena" && params.pilots.length > 1;
    const count = params.pilots.length;
    const ring = Math.min(ARENA_WIDTH, ARENA_HEIGHT) * 0.36;
    this.ships = params.pilots.map((pilotId, slot) => {
      const angle = count === 1 ? -Math.PI / 2 : (slot / count) * TAU - Math.PI / 2;
      const x = count === 1 ? ARENA_WIDTH / 2 : ARENA_WIDTH / 2 + Math.cos(angle) * ring * 1.55;
      const y = count === 1 ? ARENA_HEIGHT / 2 : ARENA_HEIGHT / 2 + Math.sin(angle) * ring;
      return {
        slot,
        pilotId,
        x,
        y,
        vx: 0,
        vy: 0,
        angle: count === 1 ? -Math.PI / 2 : angle + Math.PI,
        hull: SHIP.maxHull,
        shield: SHIP.startShield,
        bombs: SHIP.startBombs,
        dashCooldown: 0,
        dashTime: 0,
        fireCooldown: 0,
        immunity: 2,
        alive: true,
        destroyedAtTick: null,
        thrusting: false,
        stats: emptyStats()
      };
    });
    this.pilotEvents = this.ships.map(() => []);
    for (const seed of params.scenario.initialRocks) this.spawnRock(3, seed.x, seed.y, seed.heading, seed.speed, seed.spin);
  }

  get timeS(): number {
    return this.tick / TICK_HZ;
  }

  get timeLeftS(): number {
    return Math.max(0, (ROUND_TICKS - this.tick) / TICK_HZ);
  }

  aliveShips(): ArenaShip[] {
    return this.ships.filter((ship) => ship.alive);
  }

  drainPilotEvents(slot: number): string[] {
    const events = this.pilotEvents[slot] ?? [];
    this.pilotEvents[slot] = [];
    return events.slice(-8);
  }

  private log(slot: number, text: string): void {
    const events = this.pilotEvents[slot];
    if (!events) return;
    events.push(text);
    if (events.length > 16) events.splice(0, events.length - 16);
  }

  private id(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  private emit(kind: number, x: number, y: number, slot = -1): void {
    if (this.fx.length < 80) this.fx.push([kind, Math.round(x), Math.round(y), slot]);
  }

  private spawnRock(size: RockSize, x: number, y: number, heading: number, speed: number, spin: number): void {
    if (this.rocks.length >= 40) return;
    this.rocks.push({ id: this.id(), x, y, vx: Math.cos(heading) * speed, vy: Math.sin(heading) * speed, size, radius: ROCK_RADIUS[size], angle: heading, spin });
  }

  /** Spawn points that land on top of a pilot jump half an arena away (deterministic, no RNG). */
  private safePoint(x: number, y: number, minDistance: number): { x: number; y: number } {
    const tooClose = (px: number, py: number) => this.ships.some((ship) => ship.alive && wrappedOffset(ship, { x: px, y: py }).dist < minDistance);
    if (!tooClose(x, y)) return { x, y };
    const moved = { x: wrapCoord(x + ARENA_WIDTH / 2, ARENA_WIDTH), y: wrapCoord(y + ARENA_HEIGHT / 2, ARENA_HEIGHT) };
    return moved;
  }

  private runScenario(): void {
    const events = this.scenario.events;
    while (this.eventIndex < events.length && events[this.eventIndex]!.tick <= this.tick) {
      const event = events[this.eventIndex]!;
      this.eventIndex += 1;
      if (event.kind === "pickup") {
        if (this.pickups.length < 4) this.pickups.push({ id: this.id(), kind: event.pickup ?? "shield", x: event.x, y: event.y, ttl: PICKUP_TTL_S });
        continue;
      }
      if (this.drones.length >= 14) continue;
      const point = this.safePoint(event.x, event.y, 170);
      const spec = DRONE[event.kind];
      this.drones.push({
        id: this.id(),
        kind: event.kind,
        x: point.x,
        y: point.y,
        vx: Math.cos(event.heading) * spec.speed * 0.6,
        vy: Math.sin(event.heading) * spec.speed * 0.6,
        angle: event.heading,
        hp: spec.hp,
        fireTimer: event.kind === "gunship" ? DRONE.gunship.firstShot : 0
      });
    }
    if (this.rocks.length < this.scenario.minRocks && this.refillIndex < this.scenario.refills.length) {
      const seed = this.scenario.refills[this.refillIndex]!;
      this.refillIndex += 1;
      const point = this.safePoint(seed.x, seed.y, 150);
      this.spawnRock(3, point.x, point.y, seed.heading, seed.speed, seed.spin);
    }
  }

  private nearestShip(from: { x: number; y: number }): { ship: ArenaShip; dx: number; dy: number; dist: number } | null {
    let best: { ship: ArenaShip; dx: number; dy: number; dist: number } | null = null;
    for (const ship of this.ships) {
      if (!ship.alive) continue;
      const offset = wrappedOffset(from, ship);
      if (!best || offset.dist < best.dist) best = { ship, ...offset };
    }
    return best;
  }

  private addScore(ship: ArenaShip, key: keyof ScoreBreakdown, points: number): void {
    ship.stats.breakdown[key] += points;
    ship.stats.score = totalScore(ship.stats.breakdown);
  }

  private destroyShip(ship: ArenaShip, attacker: ArenaShip | null): void {
    ship.alive = false;
    ship.hull = 0;
    ship.destroyedAtTick = this.tick;
    ship.vx = 0;
    ship.vy = 0;
    this.emit(FX.destroyed, ship.x, ship.y, ship.slot);
    this.log(ship.slot, attacker ? `you were destroyed by P${attacker.slot + 1}` : "you were destroyed");
    if (attacker && attacker !== ship && attacker.alive) {
      attacker.stats.kills.pilots += 1;
      this.addScore(attacker, "pilots", SCORING.pilotKill);
      this.log(attacker.slot, `destroyed P${ship.slot + 1} +${SCORING.pilotKill}`);
    }
  }

  /** Returns true when the hit landed (not absorbed by immunity). */
  damageShip(ship: ArenaShip, amount: number, cause: string, attacker: ArenaShip | null = null): boolean {
    if (!ship.alive || ship.immunity > 0) return false;
    let hullLost = 0;
    for (let unit = 0; unit < amount; unit += 1) {
      if (ship.shield > 0) {
        ship.shield -= 1;
        ship.stats.shieldAbsorbed += 1;
      } else {
        ship.hull -= 1;
        hullLost += 1;
      }
    }
    if (hullLost > 0) {
      ship.stats.hullLost += hullLost;
      this.addScore(ship, "damage", SCORING.hullLost * hullLost);
    }
    ship.immunity = hullLost > 0 ? SHIP.hitImmunity : SHIP.shieldImmunity;
    this.emit(FX.hit, ship.x, ship.y, ship.slot);
    this.log(ship.slot, hullLost > 0 ? `hit by ${cause} -${hullLost} hull` : `hit by ${cause}, shield absorbed`);
    if (attacker && attacker !== ship && attacker.alive) {
      this.addScore(attacker, "pilots", SCORING.pilotHit);
      this.log(attacker.slot, `hit P${ship.slot + 1} +${SCORING.pilotHit}`);
    }
    if (ship.hull <= 0) this.destroyShip(ship, attacker);
    return true;
  }

  private destroyRock(rock: ArenaRock, by: ArenaShip | null, split: boolean): void {
    const index = this.rocks.indexOf(rock);
    if (index < 0) return;
    this.rocks.splice(index, 1);
    this.emit(FX.rock, rock.x, rock.y, by?.slot ?? -1);
    if (by) {
      by.stats.kills.rocks += 1;
      this.addScore(by, "rocks", SCORING.rock[rock.size]);
      this.log(by.slot, `destroyed R${rock.id} +${SCORING.rock[rock.size]}`);
    }
    if (split && rock.size > 1) {
      const heading = Math.atan2(rock.vy, rock.vx);
      const speed = Math.hypot(rock.vx, rock.vy) * 1.3 + 12;
      const spread = 0.45 + ((rock.id * 37) % 20) / 100;
      const size = (rock.size - 1) as RockSize;
      this.spawnRock(size, rock.x, rock.y, heading + spread, speed, rock.spin * 1.3);
      this.spawnRock(size, rock.x, rock.y, heading - spread, speed, -rock.spin * 1.3);
    }
  }

  private destroyDrone(drone: ArenaDrone, by: ArenaShip | null): void {
    const index = this.drones.indexOf(drone);
    if (index < 0) return;
    this.drones.splice(index, 1);
    this.emit(FX.drone, drone.x, drone.y, by?.slot ?? -1);
    if (by) {
      const points = drone.kind === "hunter" ? SCORING.hunter : SCORING.gunship;
      by.stats.kills.drones += 1;
      this.addScore(by, "drones", points);
      this.log(by.slot, `destroyed D${drone.id} ${drone.kind} +${points}`);
    }
  }

  private detonateBomb(ship: ArenaShip): void {
    ship.bombs -= 1;
    ship.stats.bombsUsed += 1;
    ship.immunity = Math.max(ship.immunity, 0.5);
    this.emit(FX.bomb, ship.x, ship.y, ship.slot);
    for (const rock of [...this.rocks]) {
      if (wrappedOffset(ship, rock).dist < SHIP.bombRadius + rock.radius * 0.5) this.destroyRock(rock, ship, false);
    }
    for (const drone of [...this.drones]) {
      if (wrappedOffset(ship, drone).dist < SHIP.bombRadius) this.destroyDrone(drone, ship);
    }
    this.shots = this.shots.filter((shot) => shot.owner !== -1 || wrappedOffset(ship, shot).dist >= SHIP.bombRadius);
    if (this.pvp) {
      for (const other of this.ships) {
        if (other !== ship && other.alive && wrappedOffset(ship, other).dist < SHIP.bombRadius) {
          this.damageShip(other, SHIP.bombPilotDamage, `P${ship.slot + 1} bomb`, ship);
        }
      }
    }
  }

  private stepShip(ship: ArenaShip, controls: ShipControls): void {
    const dt = TICK_S;
    ship.immunity = Math.max(0, ship.immunity - dt);
    ship.dashCooldown = Math.max(0, ship.dashCooldown - dt);
    ship.dashTime = Math.max(0, ship.dashTime - dt);
    ship.fireCooldown = Math.max(0, ship.fireCooldown - dt);
    ship.angle += controls.turn * SHIP.turnRate * dt;
    ship.thrusting = controls.thrust;
    if (controls.thrust) {
      ship.vx += Math.cos(ship.angle) * SHIP.thrust * dt;
      ship.vy += Math.sin(ship.angle) * SHIP.thrust * dt;
    }
    if (controls.dash && ship.dashCooldown <= 0) {
      ship.vx = Math.cos(ship.angle) * SHIP.dashSpeed;
      ship.vy = Math.sin(ship.angle) * SHIP.dashSpeed;
      ship.dashTime = SHIP.dashSeconds;
      ship.dashCooldown = SHIP.dashCooldown;
      ship.immunity = Math.max(ship.immunity, SHIP.dashImmunity);
      ship.stats.dashesUsed += 1;
      this.emit(FX.dash, ship.x, ship.y, ship.slot);
    }
    if (controls.bomb && ship.bombs > 0) this.detonateBomb(ship);
    if (controls.fire && ship.fireCooldown <= 0 && this.shots.length < 160) {
      ship.fireCooldown = SHIP.fireCooldown;
      ship.stats.shotsFired += 1;
      this.shots.push({
        id: this.id(),
        x: wrapCoord(ship.x + Math.cos(ship.angle) * 14, ARENA_WIDTH),
        y: wrapCoord(ship.y + Math.sin(ship.angle) * 14, ARENA_HEIGHT),
        vx: Math.cos(ship.angle) * SHIP.shotSpeed,
        vy: Math.sin(ship.angle) * SHIP.shotSpeed,
        life: SHIP.shotLife,
        owner: ship.slot
      });
    }
    const drag = Math.exp(-dt * SHIP.drag);
    ship.vx *= drag;
    ship.vy *= drag;
    const cap = ship.dashTime > 0 ? SHIP.dashSpeed : SHIP.maxSpeed;
    const speed = Math.hypot(ship.vx, ship.vy);
    if (speed > cap) {
      ship.vx *= cap / speed;
      ship.vy *= cap / speed;
    }
    ship.x = wrapCoord(ship.x + ship.vx * dt, ARENA_WIDTH);
    ship.y = wrapCoord(ship.y + ship.vy * dt, ARENA_HEIGHT);
  }

  private stepDrones(): void {
    const dt = TICK_S;
    for (const drone of this.drones) {
      const target = this.nearestShip(drone);
      if (drone.kind === "hunter") {
        if (drone.fireTimer > 0) {
          // Committed lunge: a straight line the pilot can sidestep.
          drone.fireTimer -= dt;
        } else if (target && target.dist < DRONE.hunter.lungeRange) {
          drone.vx = (target.dx / (target.dist || 1)) * DRONE.hunter.lungeSpeed;
          drone.vy = (target.dy / (target.dist || 1)) * DRONE.hunter.lungeSpeed;
          drone.fireTimer = 1.1;
        } else if (target) {
          const desiredX = (target.dx / (target.dist || 1)) * DRONE.hunter.speed;
          const desiredY = (target.dy / (target.dist || 1)) * DRONE.hunter.speed;
          drone.vx += (desiredX - drone.vx) * Math.min(1, 1.8 * dt);
          drone.vy += (desiredY - drone.vy) * Math.min(1, 1.8 * dt);
        }
      } else if (target) {
        const spec = DRONE.gunship;
        const direction = target.dist > spec.range + 30 ? 1 : target.dist < spec.range - 30 ? -1 : 0;
        const desiredX = (target.dx / (target.dist || 1)) * spec.speed * direction;
        const desiredY = (target.dy / (target.dist || 1)) * spec.speed * direction;
        drone.vx += (desiredX - drone.vx) * Math.min(1, 1.4 * dt);
        drone.vy += (desiredY - drone.vy) * Math.min(1, 1.4 * dt);
        drone.fireTimer -= dt;
        if (drone.fireTimer <= 0 && target.dist < spec.fireRange && this.shots.length < 160) {
          // Bolts lead the pilot's current velocity: standing still or flying straight gets you hit.
          const flight = target.dist / spec.boltSpeed;
          const heading = Math.atan2(target.dy + target.ship.vy * flight, target.dx + target.ship.vx * flight);
          this.shots.push({ id: this.id(), x: drone.x, y: drone.y, vx: Math.cos(heading) * spec.boltSpeed, vy: Math.sin(heading) * spec.boltSpeed, life: spec.boltLife, owner: -1 });
          drone.fireTimer = spec.fireEvery;
        }
      }
      if (Math.hypot(drone.vx, drone.vy) > 1) drone.angle = Math.atan2(drone.vy, drone.vx);
      drone.x = wrapCoord(drone.x + drone.vx * dt, ARENA_WIDTH);
      drone.y = wrapCoord(drone.y + drone.vy * dt, ARENA_HEIGHT);
    }
  }

  private stepShots(): void {
    const dt = TICK_S;
    for (const shot of this.shots) {
      shot.x = wrapCoord(shot.x + shot.vx * dt, ARENA_WIDTH);
      shot.y = wrapCoord(shot.y + shot.vy * dt, ARENA_HEIGHT);
      shot.life -= dt;
      if (shot.life <= 0) continue;
      if (shot.owner === -1) {
        for (const ship of this.ships) {
          if (ship.alive && wrappedOffset(shot, ship).dist < SHIP.radius + 3) {
            this.damageShip(ship, 1, "gunship bolt");
            shot.life = 0;
            break;
          }
        }
        continue;
      }
      const owner = this.ships[shot.owner] ?? null;
      const rock = this.rocks.find((candidate) => wrappedOffset(shot, candidate).dist < candidate.radius * 0.9 + 2);
      if (rock) {
        shot.life = 0;
        if (owner) owner.stats.shotsHit += 1;
        this.destroyRock(rock, owner, true);
        continue;
      }
      const drone = this.drones.find((candidate) => wrappedOffset(shot, candidate).dist < DRONE[candidate.kind].radius + 3);
      if (drone) {
        shot.life = 0;
        if (owner) owner.stats.shotsHit += 1;
        drone.hp -= 1;
        this.emit(FX.hit, drone.x, drone.y, owner?.slot ?? -1);
        if (drone.hp <= 0) this.destroyDrone(drone, owner);
        continue;
      }
      if (this.pvp) {
        for (const ship of this.ships) {
          if (ship.slot === shot.owner || !ship.alive) continue;
          if (wrappedOffset(shot, ship).dist < SHIP.radius + 3) {
            shot.life = 0;
            if (owner) owner.stats.shotsHit += 1;
            this.damageShip(ship, 1, `P${shot.owner + 1} laser`, owner);
            break;
          }
        }
      }
    }
    this.shots = this.shots.filter((shot) => shot.life > 0);
  }

  private stepContacts(): void {
    for (const ship of this.ships) {
      if (!ship.alive) continue;
      for (const rock of this.rocks) {
        if (wrappedOffset(ship, rock).dist < SHIP.radius * 0.85 + rock.radius * 0.88) {
          this.damageShip(ship, 1, `rock R${rock.id}`);
          break;
        }
      }
      if (!ship.alive) continue;
      for (const drone of [...this.drones]) {
        if (wrappedOffset(ship, drone).dist < SHIP.radius + DRONE[drone.kind].radius) {
          if (drone.kind === "hunter") {
            // Hunters detonate on contact and score nothing for anyone.
            this.destroyDrone(drone, null);
            this.damageShip(ship, 1, `hunter D${drone.id}`);
          } else {
            this.damageShip(ship, 1, `gunship D${drone.id}`);
          }
          if (!ship.alive) break;
        }
      }
      if (!ship.alive) continue;
      for (const pickup of [...this.pickups]) {
        if (wrappedOffset(ship, pickup).dist < SHIP.radius + PICKUP_RADIUS) {
          this.pickups.splice(this.pickups.indexOf(pickup), 1);
          if (pickup.kind === "shield") ship.shield = Math.min(SHIP.maxShield, ship.shield + 1);
          if (pickup.kind === "repair") ship.hull = Math.min(SHIP.maxHull, ship.hull + 1);
          if (pickup.kind === "bomb") ship.bombs = Math.min(SHIP.maxBombs, ship.bombs + 1);
          ship.stats.pickups += 1;
          this.addScore(ship, "pickups", SCORING.pickup);
          this.log(ship.slot, `collected K${pickup.id} ${pickup.kind} +${SCORING.pickup}`);
          this.emit(FX.pickup, pickup.x, pickup.y, ship.slot);
        }
      }
    }
  }

  step(controls: Array<ShipControls | null | undefined>): void {
    if (this.over) return;
    const dt = TICK_S;
    this.runScenario();
    for (const ship of this.ships) {
      if (ship.alive) this.stepShip(ship, controls[ship.slot] ?? idleControls());
    }
    this.stepDrones();
    for (const rock of this.rocks) {
      rock.x = wrapCoord(rock.x + rock.vx * dt, ARENA_WIDTH);
      rock.y = wrapCoord(rock.y + rock.vy * dt, ARENA_HEIGHT);
      rock.angle += rock.spin * dt;
    }
    this.stepShots();
    this.stepContacts();
    for (const pickup of this.pickups) pickup.ttl -= dt;
    this.pickups = this.pickups.filter((pickup) => pickup.ttl > 0);
    this.tick += 1;
    for (const ship of this.ships) {
      if (!ship.alive) continue;
      ship.stats.aliveTicks += 1;
      if (ship.stats.aliveTicks % TICK_HZ === 0) this.addScore(ship, "survival", SCORING.survivalPerSecond);
    }
    const alive = this.aliveShips().length;
    if (this.tick >= ROUND_TICKS || alive === 0 || (this.pvp && alive <= 1)) this.finish();
  }

  /** Placement bonus (shared arena): survivors by score, then the destroyed by how long they lasted. */
  private finish(): void {
    this.over = true;
    if (!this.pvp && this.mode !== "shared_arena") return;
    const ranked = this.placementOrder();
    ranked.forEach((ship, index) => {
      const bonus = SCORING.placement[index] ?? 0;
      if (bonus > 0) this.addScore(ship, "placement", bonus);
    });
  }

  placementOrder(): ArenaShip[] {
    const survivors = this.ships.filter((ship) => ship.alive).sort((left, right) => right.stats.score - left.stats.score || left.slot - right.slot);
    const destroyed = this.ships
      .filter((ship) => !ship.alive)
      .sort((left, right) => (right.destroyedAtTick ?? 0) - (left.destroyedAtTick ?? 0) || right.stats.score - left.stats.score || left.slot - right.slot);
    return [...survivors, ...destroyed];
  }

  drainFx(): number[][] {
    const fx = this.fx;
    this.fx = [];
    return fx;
  }

  snapshot(): ArenaFrameState {
    const round = (value: number) => Math.round(value);
    return {
      k: this.key,
      s: this.ships.map((ship) => [
        ship.slot,
        round(ship.x),
        round(ship.y),
        round(ship.angle * 100),
        ship.hull,
        ship.shield,
        (ship.alive ? 1 : 0) | (ship.thrusting ? 2 : 0) | (ship.immunity > 0 ? 4 : 0) | (ship.dashTime > 0 ? 8 : 0),
        ship.stats.score
      ]),
      r: this.rocks.map((rock) => [rock.id, round(rock.x), round(rock.y), rock.size, round(rock.angle * 100)]),
      d: this.drones.map((drone) => [drone.kind === "hunter" ? 0 : 1, round(drone.x), round(drone.y), round(drone.angle * 100), drone.hp, drone.id]),
      b: this.shots.map((shot) => [round(shot.x), round(shot.y), round(shot.vx), round(shot.vy), shot.owner]),
      p: this.pickups.map((pickup) => [PICKUP_KINDS.indexOf(pickup.kind), round(pickup.x), round(pickup.y), round(pickup.ttl * 10)]),
      fx: this.drainFx()
    };
  }
}
