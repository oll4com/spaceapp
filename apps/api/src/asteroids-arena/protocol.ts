import {
  ARENA_HEIGHT,
  ARENA_PROTOCOL_VERSION,
  ARENA_WIDTH,
  DECISION_INTERVAL_TICKS,
  DRONE,
  ROUND_SECONDS,
  SCORING,
  SHIP,
  SHOT_RANGE,
  TICK_HZ,
  angleDiff,
  idleControls,
  wrappedOffset,
  type AgentArena,
  type ArenaMode,
  type ArenaShip,
  type ShipControls
} from "./sim.js";

/**
 * The agent protocol: what a pilot sees (sensor snapshot), what it may answer
 * (one JSON command per window) and how the flight computer executes that
 * command. The executor follows orders only: it never picks a target and never
 * dodges on its own, so the score reflects the model's decisions.
 */

export const MANEUVERS = ["attack", "evade", "orbit", "hold", "collect", "brake"] as const;
export type Maneuver = (typeof MANEUVERS)[number];

export interface PilotCommand {
  maneuver: Maneuver;
  target: string | null;
  fire: boolean;
  dash: boolean;
  bomb: boolean;
  note: string;
}

export type ParseResult = { ok: true; command: PilotCommand } | { ok: false; reason: string };

export interface SensorContact {
  id: string;
  type: "rock" | "hunter" | "gunship" | "pilot" | "bolt";
  dist: number;
  bearing: number;
  closing: number;
  tca: number | null;
  miss: number;
  r: number;
  size?: number;
  hp?: number;
  name?: string;
}

export interface SensorPickup { id: string; kind: string; dist: number; bearing: number; ttl: number }

export interface SensorSnapshot {
  protocol: string;
  mode: ArenaMode;
  t: number;
  tLeft: number;
  decision: string;
  self: {
    hull: number;
    maxHull: number;
    shield: number;
    bombs: number;
    dashReady: boolean;
    dashCooldown: number;
    speed: number;
    heading: number;
    drift: number | null;
    immune: number;
    score: number;
  };
  contacts: SensorContact[];
  contactsTotal: number;
  incoming: SensorContact[];
  pickups: SensorPickup[];
  pilotsAlive?: number;
  events: string[];
  last: { command: string; result: string } | null;
}

export const MAX_CONTACTS = 10;
const MAX_INCOMING = 4;
const NOTE_PATTERN = /^[\x20-\x7E]*$/;

const degrees = (radians: number) => Math.round((radians * 180) / Math.PI);
const tenth = (value: number) => Math.round(value * 10) / 10;

export function describeModeForPilot(mode: ArenaMode): string {
  if (mode === "duel") {
    return "MODE real-time duel: the game does NOT pause while you think. Your command applies the moment it arrives, so the snapshot is already as old as your response time; your ship keeps executing your previous command until then.";
  }
  if (mode === "shared_arena") {
    return "MODE shared arena: every pilot (P1, P2, ...) flies in this same arena. Other pilots are enemies: your lasers and bombs damage them and theirs damage you. The game pauses while all pilots decide.";
  }
  return "MODE championship: you fly alone in a seeded gauntlet that every model faces identically. The game pauses while you decide, so response time does not change your score.";
}

export function buildSystemPrompt(mode: ArenaMode): string {
  return [
    `You are an autonomous starship pilot in ASTEROIDS AGENT ARENA (benchmark protocol ${ARENA_PROTOCOL_VERSION}).`,
    `The round lasts ${ROUND_SECONDS} s and is played in decision windows of ${DECISION_INTERVAL_TICKS / TICK_HZ} s. At each window you receive a SENSOR SNAPSHOT (JSON) and must reply with exactly ONE JSON command. A flight computer executes it for the whole window: it steers, thrusts, aims with lead and pulls the trigger, but it never chooses targets and never dodges on its own. Avoiding damage is your job.`,
    describeModeForPilot(mode),
    "",
    "GOAL: maximize your round score.",
    `+${SCORING.rock[3]}/+${SCORING.rock[2]}/+${SCORING.rock[1]} rock destroyed (large/medium/small; large and medium rocks split), +${SCORING.hunter} hunter drone, +${SCORING.gunship} gunship drone, +${SCORING.pilotHit} per hit on an enemy pilot, +${SCORING.pilotKill} enemy pilot destroyed, +${SCORING.pickup} pickup collected, +${SCORING.survivalPerSecond} per second alive, ${SCORING.hullLost} per hull point lost, placement bonus +${SCORING.placement.join("/+")} in the shared arena.`,
    `You start with ${SHIP.maxHull} hull, ${SHIP.startShield} shield charges (each absorbs one hit) and ${SHIP.startBombs} bomb. Hull 0 = destroyed: you stop scoring for the round. Hunter drones (${DRONE.hunter.hp} hp) chase you, lunge in a straight line when within ~${DRONE.hunter.lungeRange} px and explode on contact; gunship drones (${DRONE.gunship.hp} hp) keep ~${DRONE.gunship.range} px away and fire slow bolts aimed at where you are heading; rocks drift and hurt on contact.`,
    "",
    "SENSOR SNAPSHOT fields:",
    "- self: hull, shield, bombs, dashReady, dashCooldown (s), speed (px/s), heading (deg, 0 = east, 90 = south), drift (direction of travel relative to your nose, deg; null when nearly still), immune (s of invulnerability left), score.",
    "- contacts: the most urgent objects first. id (R = rock, D = drone, P = pilot), type, dist (px), bearing (deg relative to your nose: 0 dead ahead, +90 right, -90 left, 180 behind), closing (px/s, positive = approaching), tca (s until closest approach, null = moving apart), miss (predicted clearance in px at closest approach; 0 or less means IMPACT unless someone changes course), r (radius).",
    "- incoming: hostile bolts that may hit you (same fields). pickups: id (K..), kind (shield|repair|bomb), dist, bearing, ttl (s).",
    "- events: what happened to you since the last snapshot. last: your previous command and whether it was accepted.",
    `The arena (${ARENA_WIDTH}x${ARENA_HEIGHT} px) wraps around at the edges; distances and bearings already account for that. Your guns reach about ${Math.round(SHOT_RANGE)} px.`,
    "",
    "COMMAND (reply with this JSON object only: no prose, no markdown):",
    '{"maneuver":"attack|evade|orbit|hold|collect|brake","target":"<id from the snapshot or null>","fire":true|false,"dash":true|false,"bomb":true|false,"note":"<=60 chars radio callout"}',
    "- attack: fly toward the target, aim with lead and shoot it when the guns line up.",
    "- evade: steer and thrust away from the target's predicted path (use it for contacts with small or negative miss and a short tca).",
    "- orbit: circle the target at ~190 px.",
    "- hold: stay put, rotate and snipe the target.",
    "- collect: fly to the pickup given as target.",
    "- brake: kill your velocity.",
    "- fire: true = the guns shoot whenever they line up (attack/hold: on the target; other maneuvers: on any hostile in the line of fire). false keeps the guns cold.",
    `- dash: one ${SHIP.dashSpeed} px/s burst along the maneuver's travel direction (immune ${SHIP.dashImmunity} s, ${SHIP.dashCooldown} s cooldown).`,
    `- bomb: detonate now: destroys rocks and drones within ${SHIP.bombRadius} px (points count) and damages enemy pilots in range.`,
    "If the target disappears the flight computer switches to the nearest contact of the same kind. An invalid reply leaves your ship coasting with guns cold for the window."
  ].join("\n");
}

export function buildUserPrompt(snapshot: SensorSnapshot): string {
  return `SENSOR SNAPSHOT\n${JSON.stringify(snapshot)}\nReply with the JSON command only.`;
}

/** Single-message form for CLI runtimes that take one prompt on stdin. */
export function buildCombinedPrompt(mode: ArenaMode, snapshot: SensorSnapshot): string {
  return `${buildSystemPrompt(mode)}\n\n${buildUserPrompt(snapshot)}`;
}

export function commandLabel(command: PilotCommand | null): string {
  if (!command) return "coast";
  const flags = [command.fire ? "fire" : "", command.dash ? "dash" : "", command.bomb ? "bomb" : ""].filter(Boolean).join("+");
  return `${command.maneuver}${command.target ? ` ${command.target}` : ""}${flags ? ` ${flags}` : ""}`;
}

interface Kinematic { x: number; y: number; vx: number; vy: number }

function approach(ship: ArenaShip, other: Kinematic, otherRadius: number): Pick<SensorContact, "dist" | "bearing" | "closing" | "tca" | "miss"> {
  const { dx, dy, dist } = wrappedOffset(ship, other);
  const rvx = other.vx - ship.vx;
  const rvy = other.vy - ship.vy;
  const rv2 = rvx * rvx + rvy * rvy;
  const closing = dist > 0 ? -(dx * rvx + dy * rvy) / dist : 0;
  const radii = otherRadius + SHIP.radius;
  let tca: number | null = null;
  let miss = dist - radii;
  if (rv2 > 1) {
    const t = -(dx * rvx + dy * rvy) / rv2;
    if (t > 0) {
      tca = tenth(Math.min(t, 99));
      miss = Math.hypot(dx + rvx * t, dy + rvy * t) - radii;
    }
  }
  return { dist: Math.round(dist), bearing: degrees(angleDiff(ship.angle, Math.atan2(dy, dx))), closing: Math.round(closing), tca, miss: Math.round(miss) };
}

function urgency(contact: SensorContact): number {
  if (contact.tca !== null && contact.tca < 3 && contact.miss < 15) return contact.tca;
  return 10 + contact.dist / 100;
}

export function buildSensorSnapshot(
  arena: AgentArena,
  slot: number,
  meta: { decisionIndex: number; decisionsTotal: number; pilotNames?: Record<number, string>; last?: { command: string; result: string } | null }
): SensorSnapshot {
  const ship = arena.ships[slot];
  if (!ship) throw new Error(`Unknown pilot slot ${slot}.`);
  const contacts: SensorContact[] = [];
  for (const rock of arena.rocks) {
    contacts.push({ id: `R${rock.id}`, type: "rock", size: rock.size, r: rock.radius, ...approach(ship, rock, rock.radius) });
  }
  for (const drone of arena.drones) {
    contacts.push({ id: `D${drone.id}`, type: drone.kind, hp: drone.hp, r: DRONE[drone.kind].radius, ...approach(ship, drone, DRONE[drone.kind].radius) });
  }
  for (const other of arena.ships) {
    if (other === ship || !other.alive) continue;
    contacts.push({
      id: `P${other.slot + 1}`,
      type: "pilot",
      hp: other.hull,
      name: meta.pilotNames?.[other.slot],
      r: SHIP.radius,
      ...approach(ship, other, SHIP.radius)
    });
  }
  contacts.sort((left, right) => urgency(left) - urgency(right) || left.dist - right.dist);
  const incoming: SensorContact[] = [];
  for (const shot of arena.shots) {
    const hostile = shot.owner === -1 || (arena.pvp && shot.owner !== slot);
    if (!hostile) continue;
    const contact: SensorContact = { id: `B${shot.id}`, type: "bolt", r: 2, ...approach(ship, shot, 2) };
    if (contact.tca !== null && contact.tca < 3 && contact.miss < 30) incoming.push(contact);
  }
  incoming.sort((left, right) => (left.tca ?? 99) - (right.tca ?? 99));
  const speed = Math.hypot(ship.vx, ship.vy);
  return {
    protocol: ARENA_PROTOCOL_VERSION,
    mode: arena.mode,
    t: tenth(arena.timeS),
    tLeft: tenth(arena.timeLeftS),
    decision: `${meta.decisionIndex + 1}/${meta.decisionsTotal}`,
    self: {
      hull: ship.hull,
      maxHull: SHIP.maxHull,
      shield: ship.shield,
      bombs: ship.bombs,
      dashReady: ship.dashCooldown <= 0,
      dashCooldown: tenth(ship.dashCooldown),
      speed: Math.round(speed),
      heading: ((degrees(ship.angle) % 360) + 360) % 360,
      drift: speed < 5 ? null : degrees(angleDiff(ship.angle, Math.atan2(ship.vy, ship.vx))),
      immune: tenth(ship.immunity),
      score: ship.stats.score
    },
    contacts: contacts.slice(0, MAX_CONTACTS),
    contactsTotal: contacts.length,
    incoming: incoming.slice(0, MAX_INCOMING),
    pickups: arena.pickups.map((pickup) => {
      const offset = wrappedOffset(ship, pickup);
      return {
        id: `K${pickup.id}`,
        kind: pickup.kind,
        dist: Math.round(offset.dist),
        bearing: degrees(angleDiff(ship.angle, Math.atan2(offset.dy, offset.dx))),
        ttl: tenth(pickup.ttl)
      };
    }),
    ...(arena.mode === "shared_arena" ? { pilotsAlive: arena.aliveShips().length } : {}),
    events: arena.drainPilotEvents(slot),
    last: meta.last ?? null
  };
}

/** Returns the first balanced JSON object in a reply (code fences and prose around it are tolerated). */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

const TARGET_PATTERN = /^[RDPBK][0-9]{1,5}$/;

export function parsePilotCommand(text: string): ParseResult {
  const json = extractJsonObject(text);
  if (!json) return { ok: false, reason: "no JSON object in the reply" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, reason: "malformed JSON" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "the reply is not a JSON object" };
  const raw = value as Record<string, unknown>;
  const maneuver = typeof raw.maneuver === "string" ? raw.maneuver.trim().toLowerCase() : "";
  if (!(MANEUVERS as readonly string[]).includes(maneuver)) {
    return { ok: false, reason: `unknown maneuver ${JSON.stringify(String(raw.maneuver ?? "")).slice(0, 30)}` };
  }
  let target: string | null = null;
  if (raw.target !== undefined && raw.target !== null && raw.target !== "") {
    if (typeof raw.target !== "string" || !TARGET_PATTERN.test(raw.target.trim().toUpperCase())) {
      return { ok: false, reason: `invalid target ${JSON.stringify(raw.target).slice(0, 30)}` };
    }
    target = raw.target.trim().toUpperCase();
  }
  for (const key of ["fire", "dash", "bomb"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") return { ok: false, reason: `${key} must be true or false` };
  }
  const noteRaw = typeof raw.note === "string" ? raw.note.replace(/\s+/g, " ").trim() : "";
  const note = NOTE_PATTERN.test(noteRaw) ? noteRaw.slice(0, 60) : "";
  return {
    ok: true,
    command: { maneuver: maneuver as Maneuver, target, fire: raw.fire === true, dash: raw.dash === true, bomb: raw.bomb === true, note }
  };
}

interface ResolvedTarget extends Kinematic {
  id: string;
  radius: number;
  kind: "rock" | "drone" | "pilot" | "bolt" | "pickup";
}

function kindOfId(id: string): ResolvedTarget["kind"] {
  switch (id[0]) {
    case "R": return "rock";
    case "D": return "drone";
    case "P": return "pilot";
    case "B": return "bolt";
    default: return "pickup";
  }
}

function lookup(arena: AgentArena, slot: number, id: string): ResolvedTarget | null {
  const number = Number(id.slice(1));
  switch (id[0]) {
    case "R": {
      const rock = arena.rocks.find((candidate) => candidate.id === number);
      return rock ? { id, kind: "rock", radius: rock.radius, x: rock.x, y: rock.y, vx: rock.vx, vy: rock.vy } : null;
    }
    case "D": {
      const drone = arena.drones.find((candidate) => candidate.id === number);
      return drone ? { id, kind: "drone", radius: DRONE[drone.kind].radius, x: drone.x, y: drone.y, vx: drone.vx, vy: drone.vy } : null;
    }
    case "P": {
      const ship = arena.ships[number - 1];
      return ship && ship.alive && ship.slot !== slot ? { id, kind: "pilot", radius: SHIP.radius, x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy } : null;
    }
    case "B": {
      const shot = arena.shots.find((candidate) => candidate.id === number);
      return shot ? { id, kind: "bolt", radius: 2, x: shot.x, y: shot.y, vx: shot.vx, vy: shot.vy } : null;
    }
    case "K": {
      const pickup = arena.pickups.find((candidate) => candidate.id === number);
      return pickup ? { id, kind: "pickup", radius: 14, x: pickup.x, y: pickup.y, vx: 0, vy: 0 } : null;
    }
    default:
      return null;
  }
}

function candidates(arena: AgentArena, slot: number, kind: ResolvedTarget["kind"] | "hostile"): ResolvedTarget[] {
  const list: ResolvedTarget[] = [];
  if (kind === "rock" || kind === "hostile") for (const rock of arena.rocks) list.push({ id: `R${rock.id}`, kind: "rock", radius: rock.radius, x: rock.x, y: rock.y, vx: rock.vx, vy: rock.vy });
  if (kind === "drone" || kind === "hostile") for (const drone of arena.drones) list.push({ id: `D${drone.id}`, kind: "drone", radius: DRONE[drone.kind].radius, x: drone.x, y: drone.y, vx: drone.vx, vy: drone.vy });
  if ((kind === "pilot" || kind === "hostile") && arena.pvp) {
    for (const ship of arena.ships) if (ship.alive && ship.slot !== slot) list.push({ id: `P${ship.slot + 1}`, kind: "pilot", radius: SHIP.radius, x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy });
  }
  if (kind === "pickup") for (const pickup of arena.pickups) list.push({ id: `K${pickup.id}`, kind: "pickup", radius: 14, x: pickup.x, y: pickup.y, vx: 0, vy: 0 });
  if (kind === "bolt") {
    for (const shot of arena.shots) {
      if (shot.owner === -1 || (arena.pvp && shot.owner !== slot)) list.push({ id: `B${shot.id}`, kind: "bolt", radius: 2, x: shot.x, y: shot.y, vx: shot.vx, vy: shot.vy });
    }
  }
  return list;
}

function nearest(ship: ArenaShip, list: ResolvedTarget[]): ResolvedTarget | null {
  let best: ResolvedTarget | null = null;
  let bestDist = Infinity;
  for (const candidate of list) {
    const dist = wrappedOffset(ship, candidate).dist;
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  return best;
}

/** Lead aim for a shot that does not inherit ship velocity. */
export function leadAim(ship: ArenaShip, target: Kinematic): { angle: number; dist: number } {
  const { dx, dy, dist } = wrappedOffset(ship, target);
  const speed = SHIP.shotSpeed;
  const a = target.vx * target.vx + target.vy * target.vy - speed * speed;
  const b = 2 * (dx * target.vx + dy * target.vy);
  const c = dx * dx + dy * dy;
  let time = 0;
  if (Math.abs(a) < 1e-6) time = b !== 0 ? -c / b : 0;
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      const t1 = (-b - root) / (2 * a);
      const t2 = (-b + root) / (2 * a);
      time = Math.min(...[t1, t2].filter((value) => value > 0), Infinity);
      if (!Number.isFinite(time)) time = 0;
    }
  }
  if (time <= 0 || time > SHIP.shotLife * 1.2) return { angle: Math.atan2(dy, dx), dist };
  return { angle: Math.atan2(dy + target.vy * time, dx + target.vx * time), dist };
}

function aligned(ship: ArenaShip, target: ResolvedTarget): boolean {
  const aim = leadAim(ship, target);
  if (aim.dist > SHOT_RANGE + target.radius) return false;
  const tolerance = Math.atan2(target.radius * 0.9 + 3, Math.max(aim.dist, 1)) + 0.03;
  return Math.abs(angleDiff(ship.angle, aim.angle)) < tolerance;
}

function steer(ship: ArenaShip, desired: number, controls: ShipControls): number {
  const error = angleDiff(ship.angle, desired);
  const deadZone = 0.04;
  controls.turn = error > deadZone ? 1 : error < -deadZone ? -1 : 0;
  return Math.abs(error);
}

/** Per-pilot executor state: the command in force plus one-shot dash/bomb requests. */
export interface ExecutorState {
  command: PilotCommand | null;
  dashPending: boolean;
  bombPending: boolean;
  orbitDirection: 1 | -1;
}

export function createExecutorState(): ExecutorState {
  return { command: null, dashPending: false, bombPending: false, orbitDirection: 1 };
}

export function applyCommand(state: ExecutorState, command: PilotCommand | null): void {
  state.command = command;
  state.dashPending = Boolean(command?.dash);
  state.bombPending = Boolean(command?.bomb);
}

function resolveTarget(arena: AgentArena, slot: number, command: PilotCommand): ResolvedTarget | null {
  const ship = arena.ships[slot]!;
  if (command.target) {
    const found = lookup(arena, slot, command.target);
    if (found) return found;
    const kind = kindOfId(command.target);
    // Same-kind fallback keeps the order meaningful after the target dies.
    return nearest(ship, candidates(arena, slot, kind === "pilot" && !arena.pvp ? "hostile" : kind));
  }
  if (command.maneuver === "collect") return nearest(ship, candidates(arena, slot, "pickup"));
  if (command.maneuver === "brake") return null;
  return nearest(ship, candidates(arena, slot, "hostile"));
}

/** Controls for one tick, derived only from the command in force and the current state. */
export function computeControls(arena: AgentArena, slot: number, state: ExecutorState): ShipControls {
  const controls = idleControls();
  const ship = arena.ships[slot];
  const command = state.command;
  if (!ship || !ship.alive || !command) return controls;
  if (state.bombPending) {
    controls.bomb = ship.bombs > 0;
    state.bombPending = false;
  }
  const target = resolveTarget(arena, slot, command);
  const speed = Math.hypot(ship.vx, ship.vy);
  let travel: number | null = null;
  let aimTarget: ResolvedTarget | null = null;

  switch (command.maneuver) {
    case "attack": {
      if (!target) break;
      const aim = leadAim(ship, target);
      const error = steer(ship, aim.angle, controls);
      controls.thrust = aim.dist > 220 && error < 0.5 && speed < 240;
      travel = aim.angle;
      aimTarget = target;
      break;
    }
    case "hold": {
      if (!target) break;
      steer(ship, leadAim(ship, target).angle, controls);
      aimTarget = target;
      break;
    }
    case "evade": {
      if (!target) break;
      const { dx, dy, dist } = wrappedOffset(ship, target);
      const rvx = target.vx - ship.vx;
      const rvy = target.vy - ship.vy;
      const rv2 = rvx * rvx + rvy * rvy;
      let awayX = -dx;
      let awayY = -dy;
      if (rv2 > 400) {
        const t = Math.max(0, -(dx * rvx + dy * rvy) / rv2);
        const cx = dx + rvx * t;
        const cy = dy + rvy * t;
        if (Math.hypot(cx, cy) > 4) {
          // Move away from where the threat will be at closest approach.
          awayX = -cx;
          awayY = -cy;
        } else {
          // Dead-centre collision course: break perpendicular to the threat's path.
          awayX = -rvy;
          awayY = rvx;
        }
      }
      if (dist < 1 && Math.hypot(awayX, awayY) < 1) awayX = Math.cos(ship.angle);
      const desired = Math.atan2(awayY, awayX);
      const error = steer(ship, desired, controls);
      controls.thrust = error < 0.9;
      travel = desired;
      break;
    }
    case "orbit": {
      if (!target) break;
      const { dx, dy, dist } = wrappedOffset(ship, target);
      const radial = Math.atan2(dy, dx);
      const cross = dx * ship.vy - dy * ship.vx;
      if (Math.abs(cross) > 2000) state.orbitDirection = cross > 0 ? -1 : 1;
      const tangent = radial + (state.orbitDirection * Math.PI) / 2;
      const correction = Math.max(-1, Math.min(1, (dist - 190) / 190)) * 1.2;
      const desired = Math.atan2(Math.sin(tangent) + Math.sin(radial) * correction, Math.cos(tangent) + Math.cos(radial) * correction);
      const error = steer(ship, desired, controls);
      controls.thrust = speed < 200 && error < 0.8;
      travel = desired;
      break;
    }
    case "collect": {
      if (!target) break;
      const { dx, dy, dist } = wrappedOffset(ship, target);
      const desired = Math.atan2(dy, dx);
      const error = steer(ship, desired, controls);
      controls.thrust = error < 0.5 && (dist > 70 || speed < 90);
      travel = desired;
      break;
    }
    case "brake": {
      if (speed > 25) {
        const desired = Math.atan2(-ship.vy, -ship.vx);
        const error = steer(ship, desired, controls);
        controls.thrust = error < 0.3;
      }
      break;
    }
  }

  if (command.fire) {
    if (aimTarget && aimTarget.kind !== "pickup") {
      controls.fire = aligned(ship, aimTarget);
    } else {
      controls.fire = candidates(arena, slot, "hostile").some((candidate) => aligned(ship, candidate));
    }
  }

  if (state.dashPending && ship.dashCooldown <= 0) {
    const ready = travel === null || Math.abs(angleDiff(ship.angle, travel)) < 0.5;
    if (ready) {
      controls.dash = true;
      state.dashPending = false;
    }
  }
  return controls;
}

/**
 * Reference pilots built on the same snapshot and command interface as the
 * models. The scripted baseline is the bar a model has to clear; the naive and
 * idle policies exist to prove the arena separates good decisions from bad.
 */
export function scriptedBaselineCommand(snapshot: SensorSnapshot): PilotCommand {
  const self = snapshot.self;
  const horizon = (contact: SensorContact) => (contact.type === "rock" ? 1 : contact.type === "bolt" ? 1.2 : 0.8);
  const threats = [...snapshot.contacts, ...snapshot.incoming]
    .filter((contact) => contact.tca !== null && contact.tca < horizon(contact) && contact.miss < 6)
    .sort((left, right) => (left.tca ?? 9) - (right.tca ?? 9));
  const crowd = snapshot.contacts.filter((contact) => contact.type !== "pilot" && contact.dist < 200).length;
  if (threats.length > 0) {
    const threat = threats[0]!;
    return {
      maneuver: "evade",
      target: threat.id,
      fire: true,
      dash: self.dashReady && (threat.tca ?? 9) < 0.6,
      bomb: self.bombs > 0 && crowd >= 4,
      note: `evading ${threat.id}`
    };
  }
  const pickup = snapshot.pickups.filter((candidate) => candidate.ttl > 1.5).sort((left, right) => left.dist - right.dist)[0];
  if (pickup && (pickup.dist < 200 || (self.hull + self.shield <= 3 && pickup.dist < 420))) {
    return { maneuver: "collect", target: pickup.id, fire: true, dash: false, bomb: false, note: `collecting ${pickup.kind}` };
  }
  if (self.bombs > 0 && crowd >= 5) {
    return { maneuver: "hold", target: snapshot.contacts[0]?.id ?? null, fire: true, dash: false, bomb: true, note: "bomb the crowd" };
  }
  const priority = (contact: SensorContact) =>
    contact.type === "hunter" ? 0 : contact.type === "pilot" ? 1 : contact.type === "gunship" ? 2 : 3;
  const target = [...snapshot.contacts]
    .filter((contact) => contact.dist < (contact.type === "rock" ? 380 : 480))
    .sort((left, right) => priority(left) - priority(right) || left.dist - right.dist)[0] ?? snapshot.contacts[0];
  if (!target) return { maneuver: "brake", target: null, fire: false, dash: false, bomb: false, note: "sector clear" };
  const turret = target.type === "hunter" || target.dist < 200;
  return { maneuver: turret ? "hold" : "attack", target: target.id, fire: true, dash: false, bomb: false, note: `engaging ${target.id}` };
}

export function naiveCommand(snapshot: SensorSnapshot): PilotCommand {
  const target = [...snapshot.contacts].sort((left, right) => left.dist - right.dist)[0];
  return { maneuver: "attack", target: target?.id ?? null, fire: true, dash: false, bomb: false, note: "attack nearest" };
}

export function idleCommand(): PilotCommand {
  return { maneuver: "brake", target: null, fire: false, dash: false, bomb: false, note: "idle" };
}
