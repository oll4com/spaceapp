import type { AsteroidsEngine, Controls } from "./engine.js";
import { emptyControls } from "./engine.js";

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

function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function wrappedDelta(value: number, size: number): number {
  return ((value + size / 2) % size + size) % size - size / 2;
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

  const allTargets = [...game.enemies, ...game.rocks].filter(
    (candidate) => !("boss" in candidate) || candidate.boss || candidate.radius > 0
  );

  if (allTargets.length === 0) {
    controls.thrust = true;
    controls.left = true;
    return controls;
  }

  let candidates = allTargets;
  if (profile.targetPreference === "enemies" && game.enemies.length > 0) {
    candidates = game.enemies;
  } else if (profile.targetPreference === "rocks" && game.rocks.length > 0) {
    candidates = game.rocks;
  }

  const target = candidates.sort((a, b) => {
    const da = Math.hypot(wrappedDelta(a.x - game.ship.x, game.width), wrappedDelta(a.y - game.ship.y, game.height));
    const db = Math.hypot(wrappedDelta(b.x - game.ship.x, game.width), wrappedDelta(b.y - game.ship.y, game.height));
    if (profile.targetPreference === "threat") {
      const threatA = ("elite" in a && a.elite ? 1.5 : 1) * (1000 / (da + 10));
      const threatB = ("elite" in b && b.elite ? 1.5 : 1) * (1000 / (db + 10));
      return threatB - threatA;
    }
    return da - db;
  })[0];

  if (!target) {
    controls.thrust = true;
    controls.left = true;
    return controls;
  }

  const targetDx = wrappedDelta(target.x - game.ship.x, game.width);
  const targetDy = wrappedDelta(target.y - game.ship.y, game.height);
  const distance = Math.hypot(targetDx, targetDy);

  const leadFactor = Math.min(0.55, (distance / 500) * (profile.leadAiming ?? 0.8));
  const targetAngle = Math.atan2(
    targetDy + target.vy * leadFactor,
    targetDx + target.vx * leadFactor
  );
  const delta = angleDelta(game.ship.angle, targetAngle);

  const turnDeadZone = 0.02 + (1 - profile.precision) * 0.05;
  if (delta > turnDeadZone) controls.right = true;
  if (delta < -turnDeadZone) controls.left = true;

  // Disciplined marksman fire
  controls.fire = Math.abs(delta) < 0.42 + (1 - profile.precision) * 0.2;
  controls.thrust = distance > (120 + (1 - profile.aggression) * 80) || Math.abs(delta) > 1.25;

  // Collision avoidance when dangerously close (<130px)
  if (distance < 130) {
    if (delta > 0) controls.left = true; else controls.right = true;
    controls.thrust = false;
    if (Math.abs(delta) > 1.1 && game.ship.immunity <= 0 && profile.mobility > 0.6) {
      controls.dash = true;
    }
  } else if (distance < 180 && Math.abs(delta) > 1.4 && game.ship.immunity <= 0 && profile.mobility > 0.75) {
    controls.dash = true;
  }

  if (game.bombs > 0 && (game.enemies.length >= 3 || game.rocks.length >= 8) && profile.aggression > 0.72) {
    controls.bomb = true;
  }

  // Live real-time directive execution from AI model
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

    if (dir.action === "emergency_dash") {
      if (delta > 0) { controls.left = true; controls.right = false; }
      else { controls.right = true; controls.left = false; }
      if (Math.abs(delta) > 0.7 || game.ship.immunity <= 0) {
        controls.dash = true;
      }
    } else if (dir.action === "tactical_bomb") {
      if (game.bombs > 0) controls.bomb = true;
      controls.fire = true;
    } else if (dir.action === "strafe_circle") {
      controls.thrust = true;
      controls.right = true;
      controls.fire = Math.abs(delta) < 0.6;
    } else if (dir.action === "breakaway") {
      controls.thrust = false;
      if (delta > 0) controls.left = true; else controls.right = true;
    } else if (dir.action === "full_assault") {
      controls.thrust = true;
      controls.fire = true;
      if (distance < 130 && Math.abs(delta) > 1.0) controls.dash = true;
    } else if (dir.action === "lock_and_fire") {
      controls.fire = Math.abs(delta) < 0.4;
      controls.thrust = distance > 120;
    }
  }

  return controls;
}
