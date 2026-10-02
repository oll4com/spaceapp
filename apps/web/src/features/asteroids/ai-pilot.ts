import type { AsteroidsEngine, Controls, WeaponId } from "./engine.js";
import { emptyControls, WEAPONS } from "./engine.js";

export interface LivePilotDirective {
  action: "emergency_dash" | "tactical_bomb" | "lock_and_fire" | "strafe_circle" | "breakaway" | "full_assault";
  turnBias?: "left" | "right" | "direct";
  thrustOverride?: boolean;
  radioCallout: string;
  confidence: number;
  latencyMs: number;
}

export interface TacticalProfile {
  aggression: number;
  precision: number;
  mobility: number;
  leadAiming: number;
  targetPreference: "nearest" | "threat" | "rocks" | "enemies";
  tactic: string;
  latencyMs?: number;
  source?: "model" | "fallback";
  liveDirective?: LivePilotDirective | null;
}

export type PilotProfile = TacticalProfile;

export const JEV_MODEL_ID = "openrouter/typesafe/jev-1.13";

export const JEV_TACTICAL_PROFILE: TacticalProfile = {
  aggression: 0.96,
  precision: 0.95,
  mobility: 0.95,
  leadAiming: 0.92,
  targetPreference: "threat",
  tactic: "TypeSafe Jev Neural Combat Core - Real-Time Threat Interception",
  source: "model",
};

function hashModel(modelId: string): number {
  let hash = 2166136261;
  for (const char of modelId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function defaultTacticalProfile(modelId: string = JEV_MODEL_ID): TacticalProfile {
  if (!modelId || modelId === JEV_MODEL_ID || modelId.toLowerCase().includes("jev") || modelId === "pilot") {
    return { ...JEV_TACTICAL_PROFILE };
  }
  const hash = hashModel(modelId);
  return {
    aggression: 0.6 + (hash % 35) / 100,
    precision: 0.6 + ((hash >>> 8) % 35) / 100,
    mobility: 0.6 + ((hash >>> 16) % 35) / 100,
    leadAiming: 0.5 + ((hash >>> 24) % 45) / 100,
    targetPreference: (hash % 4 === 0 ? "threat" : hash % 4 === 1 ? "enemies" : hash % 4 === 2 ? "rocks" : "nearest"),
    tactic: "Autonomous tactical patrol doctrine",
    source: "fallback",
  };
}

export const pilotProfile = (modelId: string = JEV_MODEL_ID): TacticalProfile => defaultTacticalProfile(modelId);

export function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function wrappedDelta(value: number, size: number): number {
  return ((value + size / 2) % size + size) % size - size / 2;
}

/**
 * Predicts whether a hazard will collide with the ship along their current velocity vectors.
 */
export function checkCollisionCourse(
  ship: { x: number; y: number; vx: number; vy: number },
  hazard: { x: number; y: number; vx: number; vy: number; radius: number },
  width: number,
  height: number,
  timeHorizon = 1.6
): { willCollide: boolean; tClosest: number; minDist: number; hazardDx: number; hazardDy: number } {
  const dx = wrappedDelta(hazard.x - ship.x, width);
  const dy = wrappedDelta(hazard.y - ship.y, height);
  const rvx = hazard.vx - ship.vx;
  const rvy = hazard.vy - ship.vy;
  const rv2 = rvx * rvx + rvy * rvy;
  const collisionRadius = hazard.radius + 18; // 14px ship radius + 4px safety buffer

  if (rv2 < 1) {
    const dist = Math.hypot(dx, dy);
    return {
      willCollide: dist < collisionRadius + 20,
      tClosest: 0,
      minDist: dist,
      hazardDx: dx,
      hazardDy: dy,
    };
  }

  const tClosest = - (dx * rvx + dy * rvy) / rv2;
  if (tClosest <= 0 || tClosest > timeHorizon) {
    const currentDist = Math.hypot(dx, dy);
    return {
      willCollide: currentDist < collisionRadius + 15,
      tClosest: 0,
      minDist: currentDist,
      hazardDx: dx,
      hazardDy: dy,
    };
  }

  const closeDx = dx + rvx * tClosest;
  const closeDy = dy + rvy * tClosest;
  const minDist = Math.hypot(closeDx, closeDy);

  return {
    willCollide: minDist < collisionRadius + 22,
    tClosest,
    minDist,
    hazardDx: dx,
    hazardDy: dy,
  };
}

export function nextPilotControls(
  game: AsteroidsEngine,
  modelOrProfile: string | TacticalProfile = JEV_MODEL_ID
): Controls {
  const controls = emptyControls();
  if (game.phase !== "playing") return controls;

  const profile: TacticalProfile =
    typeof modelOrProfile === "string"
      ? defaultTacticalProfile(modelOrProfile)
      : modelOrProfile;

  const ship = game.ship;
  const currentSpeed = Math.hypot(ship.vx, ship.vy);

  const allTargets = [...game.enemies, ...game.rocks].filter(
    (candidate) => !("boss" in candidate) || candidate.boss || candidate.radius > 0
  );

  if (allTargets.length === 0) {
    controls.thrust = currentSpeed < 100;
    controls.left = true;
    return controls;
  }

  let candidates = allTargets;
  if (profile.targetPreference === "enemies" && game.enemies.length > 0) {
    candidates = game.enemies;
  } else if (profile.targetPreference === "rocks" && game.rocks.length > 0) {
    candidates = game.rocks;
  }

  // 1. Dynamic threat assessment & combat target selection
  const target = candidates.sort((a, b) => {
    const da = Math.hypot(wrappedDelta(a.x - ship.x, game.width), wrappedDelta(a.y - ship.y, game.height));
    const db = Math.hypot(wrappedDelta(b.x - ship.x, game.width), wrappedDelta(b.y - ship.y, game.height));

    if (profile.targetPreference === "threat") {
      const getThreat = (cand: typeof a, dist: number) => {
        const isEnemy = "kind" in cand;
        const isRock = !isEnemy;
        const rvx = cand.vx - ship.vx;
        const rvy = cand.vy - ship.vy;
        const dx = wrappedDelta(cand.x - ship.x, game.width);
        const dy = wrappedDelta(cand.y - ship.y, game.height);
        const closingSpeed = - (dx * rvx + dy * rvy) / (dist || 1);

        let threatMul = 1.0;
        if (isEnemy) {
          threatMul = 4.0;
          if (cand.kind === "kamikaze") {
            threatMul = 6.5;
            if (cand.blink > 0) threatMul = 8.5;
          } else if (cand.kind === "gunship") {
            threatMul = 4.8;
          } else if (cand.kind === "weaver") {
            threatMul = 4.2;
          }
          if (cand.elite) threatMul *= 1.4;
          if (closingSpeed > 30) threatMul *= 1.3;
        } else if (isRock) {
          if (cand.boss) {
            threatMul = 5.0;
          } else if (dist < 140 && closingSpeed > 50) {
            threatMul = 2.2;
          } else {
            threatMul = 0.75;
          }
        }
        return threatMul * (1000 / (dist + 15));
      };

      return getThreat(b, db) - getThreat(a, da);
    }
    return da - db;
  })[0];

  if (!target) {
    controls.thrust = currentSpeed < 100;
    controls.left = true;
    return controls;
  }

  const targetDx = wrappedDelta(target.x - ship.x, game.width);
  const targetDy = wrappedDelta(target.y - ship.y, game.height);
  const distance = Math.hypot(targetDx, targetDy) || 1;

  // 2. Ballistic intercept calculation based on active weapon speed
  const weaponSpeed = WEAPONS[game.weapon]?.speed || 540;
  const timeToHit = Math.min(0.8, distance / Math.max(200, weaponSpeed));
  const leadFactor = timeToHit * (profile.leadAiming ?? 0.92);

  const aimDx = targetDx + target.vx * leadFactor;
  const aimDy = targetDy + target.vy * leadFactor;
  const targetAngle = Math.atan2(aimDy, aimDx);
  const delta = angleDelta(ship.angle, targetAngle);

  // Turn toward target (mutually exclusive)
  const turnDeadZone = 0.02 + (1 - profile.precision) * 0.03;
  if (delta > turnDeadZone) {
    controls.right = true;
    controls.left = false;
  } else if (delta < -turnDeadZone) {
    controls.left = true;
    controls.right = false;
  }

  // Disciplined marksman fire
  const firingTolerance = 0.38 + (1 - profile.precision) * 0.15;
  controls.fire = Math.abs(delta) < firingTolerance && game.heat < 0.95;

  // 3. Controlled Cruising Speed & Kiting
  // Never blindly accelerate: Asteroids has inertia.
  const isChaser = "kind" in target && (target.kind === "kamikaze" || target.kind === "weaver");
  if (isChaser && distance < 210) {
    // Kite: do not thrust head-on into charging chaser unless immune
    controls.thrust = ship.immunity > 0.5;
  } else {
    // Regulate speed to ~130 px/s so the ship always has stopping and turning agility
    const desiredSpeed = 130 + profile.aggression * 40;
    controls.thrust = currentSpeed < desiredSpeed && (distance > 160 || Math.abs(delta) > 1.25);
  }

  // 4. Tactical Weapon Selection
  if (game.unlocked.length > 1) {
    let idealWeapon: WeaponId = "blaster";
    const hasBoss = game.rocks.some((r) => r.boss);
    if (hasBoss && game.unlocked.includes("railgun")) {
      idealWeapon = "railgun";
    } else if (game.enemies.length >= 3 && game.unlocked.includes("arc")) {
      idealWeapon = "arc";
    } else if (game.enemies.length >= 2 && game.unlocked.includes("spread")) {
      idealWeapon = "spread";
    } else if (game.unlocked.includes("missiles")) {
      idealWeapon = "missiles";
    } else if (game.unlocked.includes("railgun")) {
      idealWeapon = "railgun";
    }

    if (game.weapon !== idealWeapon && game.unlocked.includes(idealWeapon)) {
      controls.swap = true;
    }
  }

  // 5. Tactical Directives execution from AI model (Tactical baseline)
  if (profile.liveDirective) {
    const dir = profile.liveDirective;
    if (dir.turnBias === "left") {
      controls.left = true;
      controls.right = false;
    } else if (dir.turnBias === "right") {
      controls.right = true;
      controls.left = false;
    }
    if (dir.thrustOverride !== undefined) {
      controls.thrust = dir.thrustOverride;
    }

    if (dir.action === "tactical_bomb") {
      if (game.bombs > 0) controls.bomb = true;
      controls.fire = true;
    } else if (dir.action === "strafe_circle") {
      controls.thrust = currentSpeed < 140;
      controls.fire = Math.abs(delta) < 0.6;
    } else if (dir.action === "full_assault") {
      controls.thrust = currentSpeed < 200;
      controls.fire = true;
    } else if (dir.action === "lock_and_fire") {
      controls.fire = Math.abs(delta) < 0.35 && game.heat < 0.95;
      controls.thrust = distance > 160 && currentSpeed < 130;
    }
  }

  // 6. Tactical Bomb Deployment
  if (game.bombs > 0) {
    const enemiesNearby = game.enemies.filter((e) => Math.hypot(wrappedDelta(e.x - ship.x, game.width), wrappedDelta(e.y - ship.y, game.height)) < 260).length;
    const rocksNearby = game.rocks.filter((r) => Math.hypot(wrappedDelta(r.x - ship.x, game.width), wrappedDelta(r.y - ship.y, game.height)) < 200).length;

    const criticalDanger = game.lives <= 1 && ship.immunity <= 0 && (enemiesNearby >= 1 || rocksNearby >= 3);
    const swarmed = enemiesNearby >= 2 || (game.enemies.length >= 3 && profile.aggression > 0.7);
    const rockOverwhelm = rocksNearby >= 6;

    if (criticalDanger || swarmed || rockOverwhelm) {
      controls.bomb = true;
    }
  }

  // =========================================================================
  // 7. SURVIVAL ENVELOPE (Final Guardian — Trajectory & Proximity Avoidance)
  // This runs LAST to guarantee collision evasion is never overridden.
  // =========================================================================

  // Check enemy bullets
  const enemyShots = game.shots.filter((s) => s.enemy);
  for (const shot of enemyShots) {
    const sDx = wrappedDelta(shot.x - ship.x, game.width);
    const sDy = wrappedDelta(shot.y - ship.y, game.height);
    const sDist = Math.hypot(sDx, sDy);
    if (sDist < 170) {
      const rvx = shot.vx - ship.vx;
      const rvy = shot.vy - ship.vy;
      const closing = - (sDx * rvx + sDy * rvy) / (sDist || 1);
      if (closing > 50) {
        const timeToImpact = sDist / closing;
        if (timeToImpact < 0.7) {
          const bulletAngle = Math.atan2(sDy, sDx);
          const bulletDelta = angleDelta(ship.angle, bulletAngle);
          // Evasive perpendicular steer
          if (bulletDelta > 0) {
            controls.left = true;
            controls.right = false;
          } else {
            controls.right = true;
            controls.left = false;
          }
          if (sDist < 60 && ship.dash <= 0 && ship.immunity <= 0 && profile.mobility > 0.6) {
            controls.dash = true;
          }
        }
      }
    }
  }

  // Scan ALL obstacles (rocks, enemies, mines) for clearance & collision trajectory
  type Obstacle = { x: number; y: number; vx: number; vy: number; radius: number; isEnemy?: boolean; isKamikaze?: boolean };
  const obstacles: Obstacle[] = [
    ...game.rocks.map((r) => ({ x: r.x, y: r.y, vx: r.vx, vy: r.vy, radius: r.radius })),
    ...game.enemies.map((e) => ({ x: e.x, y: e.y, vx: e.vx, vy: e.vy, radius: e.radius, isEnemy: true, isKamikaze: e.kind === "kamikaze" })),
    ...game.mines.map((m) => ({ x: m.x, y: m.y, vx: m.vx, vy: m.vy, radius: m.radius })),
  ];

  let urgentHazard: { dx: number; dy: number; dist: number; clearance: number; tClosest: number; isKamikaze: boolean } | null = null;
  let minClearance = 9999;
  let minTimeToCollision = 9999;

  for (const obs of obstacles) {
    const oDx = wrappedDelta(obs.x - ship.x, game.width);
    const oDy = wrappedDelta(obs.y - ship.y, game.height);
    const oDist = Math.hypot(oDx, oDy);
    const clearance = oDist - obs.radius - 14;

    const course = checkCollisionCourse(ship, obs, game.width, game.height, 1.5);

    // Hazard is considered urgent if either:
    // 1) Current static clearance is critically low (< 110px)
    // 2) Velocity trajectory will intersect hazard within 1.4 seconds
    const isCollisionCourse = course.willCollide && course.tClosest < 1.4 && course.tClosest > 0;
    const isProximityDanger = clearance < 110;

    if (isCollisionCourse && course.tClosest < minTimeToCollision) {
      minTimeToCollision = course.tClosest;
      urgentHazard = {
        dx: course.hazardDx,
        dy: course.hazardDy,
        dist: oDist,
        clearance,
        tClosest: course.tClosest,
        isKamikaze: !!obs.isKamikaze,
      };
    } else if (!isCollisionCourse && isProximityDanger && clearance < minClearance && minTimeToCollision === 9999) {
      minClearance = clearance;
      urgentHazard = {
        dx: oDx,
        dy: oDy,
        dist: oDist,
        clearance,
        tClosest: 0,
        isKamikaze: !!obs.isKamikaze,
      };
    }
  }

  // Execute evasion if urgent hazard detected
  if (urgentHazard) {
    const hazardAngle = Math.atan2(urgentHazard.dy, urgentHazard.dx);
    const hazardDelta = angleDelta(ship.angle, hazardAngle);

    // Steer away from hazard (mutually exclusive)
    if (hazardDelta > 0) {
      controls.left = true;
      controls.right = false;
    } else {
      controls.right = true;
      controls.left = false;
    }

    // Thrust control:
    // If the hazard is in front of the ship, NEVER thrust into it!
    if (Math.abs(hazardDelta) < 1.25) {
      controls.thrust = false;
    } else {
      // If hazard is behind or sideways, thrusting forward escapes the collision zone
      controls.thrust = currentSpeed < 170;
    }

    // Emergency evasive dash:
    // Trigger dash only when heading away from the hazard (Math.abs(hazardDelta) > 0.8)
    const isImminentCollision = urgentHazard.tClosest > 0 && urgentHazard.tClosest < 0.65;
    const isPointBlank = urgentHazard.clearance < 50;
    const isKamikazeCharge = urgentHazard.isKamikaze && urgentHazard.dist < 140;

    if ((isImminentCollision || isPointBlank || isKamikazeCharge) && ship.immunity <= 0 && ship.dash <= 0 && profile.mobility > 0.5) {
      if (Math.abs(hazardDelta) > 0.75) {
        controls.dash = true;
      }
    }

    // Emergency bomb if about to crash with 0 life remaining
    if (urgentHazard.clearance < 40 && game.lives <= 1 && ship.immunity <= 0 && game.bombs > 0) {
      controls.bomb = true;
    }
  }

  return controls;
}
