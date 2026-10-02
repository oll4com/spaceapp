import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import {
  generateNativeOpenCodeTitle,
  nativeOpenCodeModelCatalog,
  resolveNativeOpenCodeRuntime,
} from "./task-title-opencode.js";
import { createDecisionsService } from "./decisions-service.js";
import { loadOpenRouterBenchmarkModels, requestOpenRouterDoctrine } from "./openrouter-benchmark-models.js";

/**
 * Benchmark results API — read-only views over the published
 * space-model-benchmark results directory.
 *
 * Data source: directory of JSON files produced by
 * `space-model-benchmark.sh --publish` (leaderboard.json + <runId>.json).
 * Default location is /opt/spaceapp/var/space-model-benchmark; override with
 * SPACE_BENCHMARK_RESULTS_DIR. The routes are guarded by the global /api/*
 * authentication hook, so they only serve authenticated users.
 */

const DEFAULT_RESULTS_DIR = "/opt/spaceapp/var/space-model-benchmark";
const MAX_RUN_FILES = 50;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const CHAMPIONSHIP_FILE = "/opt/spaceapp/var/asteroids-championship.json";
const CHAMPIONSHIP_FILES = {
  championship: CHAMPIONSHIP_FILE,
  duel: "/opt/spaceapp/var/asteroids-duel.json",
  shared_arena: "/opt/spaceapp/var/asteroids-shared-arena.json",
} as const;
type AsteroidsBenchmarkMode = keyof typeof CHAMPIONSHIP_FILES;
const GEMINI_MODELS_FILE = "/opt/spaceapp/var/gemini-models.last-good.json";
const GITHUB_AUTO_MODEL = { id: "github/auto", displayName: "GitHub CLI · Auto", providerId: "github", status: "VERIFIED" };
const JEV_MODEL = { id: "openrouter/typesafe/jev-1.13", displayName: "TypeSafe Jev 1.13", providerId: "openrouter", status: "VERIFIED" };

export interface TacticalDoctrine {
  aggression: number;
  precision: number;
  mobility: number;
  leadAiming: number;
  targetPreference: "nearest" | "threat" | "rocks" | "enemies";
  tactic: string;
  latencyMs: number;
  source: "model" | "fallback";
}

export interface AsteroidsModelStats {
  id: string;
  displayName: string;
  providerId: string;
  wins: number;
  gamesPlayed: number;
  totalScore: number;
  bestScore: number;
  totalKills: number;
  avgAccuracy: number;
  totalSurvivalSeconds: number;
  lastTactic?: string;
  lastLatencyMs?: number;
  lastSource?: "model" | "fallback";
}

export interface AsteroidsMatchRound {
  game: number;
  winner: string;
  scores: Record<string, { score: number; kills: number; accuracy: number; survival: number; tactic?: string; source?: "model" | "fallback" }>;
}

export interface AsteroidsChampionship {
  id: string;
  status: "ready" | "running" | "completed";
  startedAt: string;
  completedAt?: string;
  games: number;
  currentGame: number;
  models: AsteroidsModelStats[];
  gamesPlayed: AsteroidsMatchRound[];
  error?: string;
}

function modelSeed(id: string): number {
  let value = 2166136261;
  for (const char of id) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

async function loadAntigravityModels(): Promise<Array<{ id: string; displayName: string; providerId: string; status: string }>> {
  try {
    const payload = JSON.parse(await readFile(GEMINI_MODELS_FILE, "utf8")) as { models?: string };
    return (payload.models ?? "").split("\n").flatMap((line) => {
      const [id, displayName] = line.split("\t").map((value) => value.trim());
      return id && displayName ? [{ id: `antigravity/${id}`, displayName, providerId: "antigravity", status: "VERIFIED" }] : [];
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const CODEX_ENV_FILE = "/var/lib/spaceapp-user/.config/codex-lb-provider.env";
const CODEX_KEY_FILE = process.env.SPACE_CODEX_LB_KEY_FILE ?? "/opt/spaceapp/secrets/space-codex-lb-provider.key";
const CODEX_MODELS_CACHE_FILE = "/var/lib/spaceapp-user/.codex/models_cache.json";
const CODEX_LB_BASE_URL = "http://127.0.0.1:2458";

async function getCodexApiKey(): Promise<string | null> {
  try {
    const key = (await readFile(CODEX_KEY_FILE, "utf8")).trim();
    if (key) return key;
  } catch {}
  try {
    const content = await readFile(CODEX_ENV_FILE, "utf8");
    const match = content.match(/CODEX_LB_API_KEY=["']?([^"'\r\n]+)/);
    return match?.[1] ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function loadCodexModels(): Promise<Array<{ id: string; displayName: string; providerId: string; status: string }>> {
  // 1. Try querying the live Codex-LB HTTP API endpoint
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${CODEX_LB_BASE_URL}/v1/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json()) as any;
      const list = (data.data || data.models || (Array.isArray(data) ? data : [])) as any[];
      const models = list
        .filter((m) => m && m.visibility !== "hide" && (m.id || m.slug))
        .map((m) => {
          const rawId = String(m.id || m.slug);
          const name = String(m.display_name || m.name || m.metadata?.display_name || rawId);
          return {
            id: `codex/${rawId}`,
            displayName: name,
            providerId: "codex",
            status: "VERIFIED",
          };
        });
      if (models.length > 0) return models;
    }
  } catch {}

  // 2. Fallback to ~/.codex/models_cache.json
  try {
    const raw = await readFile(CODEX_MODELS_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as any;
    const list = (Array.isArray(parsed) ? parsed : parsed.models ?? []) as any[];
    const models = list
      .filter((m) => m && m.visibility !== "hide" && (m.slug || m.id))
      .map((m) => {
        const rawId = String(m.slug || m.id);
        const name = String(m.display_name || m.name || rawId);
        return {
          id: `codex/${rawId}`,
          displayName: name,
          providerId: "codex",
          status: "VERIFIED",
        };
      });
    if (models.length > 0) return models;
  } catch {}

  // 3. Fallback to verified Codex model fleet
  return [
    { id: "codex/gpt-6-astra", displayName: "GPT-6-Astra", providerId: "codex", status: "VERIFIED" },
    { id: "codex/gpt-5.6-sol", displayName: "GPT-5.6-Sol", providerId: "codex", status: "VERIFIED" },
    { id: "codex/gpt-5.6-terra", displayName: "GPT-5.6-Terra", providerId: "codex", status: "VERIFIED" },
    { id: "codex/gpt-5.6-luna", displayName: "GPT-5.6-Luna", providerId: "codex", status: "VERIFIED" },
    { id: "codex/gpt-5.5", displayName: "GPT-5.5", providerId: "codex", status: "VERIFIED" },
  ];
}

function championshipFile(mode: AsteroidsBenchmarkMode): string {
  return CHAMPIONSHIP_FILES[mode];
}

async function saveChampionship(state: AsteroidsChampionship, mode: AsteroidsBenchmarkMode): Promise<void> {
  const file = championshipFile(mode);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

async function loadChampionship(mode: AsteroidsBenchmarkMode): Promise<AsteroidsChampionship | null> {
  const file = championshipFile(mode);
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as AsteroidsChampionship;
    const hasInvalidRound = !Array.isArray(state.gamesPlayed) || state.gamesPlayed.some((round) =>
      !round || typeof round.game !== "number" || !round.scores ||
      Object.values(round.scores).some((score) => !score || score.source !== "model")
    );
    const hasInvalidModel = !Array.isArray(state.models) || state.models.some((model) =>
      model.lastSource !== undefined && model.lastSource !== "model"
    );
    if (hasInvalidRound || hasInvalidModel) return null;
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export const DOCTRINE_SYSTEM_PROMPT =
  "You are the combat pilot AI for a starship in an Asteroids dogfight arena. " +
  "Analyze the battle state and formulate your flight doctrine. Return strict JSON only (no markdown): " +
  '{"aggression": 0.2..1.0, "precision": 0.3..1.0, "mobility": 0.3..1.0, "leadAiming": 0.0..1.0, "targetPreference": "nearest"|"threat"|"rocks"|"enemies", "tactic": "short tactical radio line max 60 chars ASCII"}.';

/**
 * Doctrine batches are fetched with bounded parallelism and a global deadline:
 * a wide selection (up to 32 models) must not stampede the providers, and the
 * answer has to stay well below the proxy read timeout (60s). Models that miss
 * the deadline are simply absent from the response; the web client skips them
 * instead of aborting the battle.
 */
const TACTICS_BATCH_LIMIT = 32;
const TACTICS_BATCH_CONCURRENCY = 8;
const TACTICS_BATCH_DEADLINE_MS = 55_000;

/** Resolve to null when the promise misses the deadline (never rejects). */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    const settle = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    promise.then((value) => settle(value), () => settle(null));
  });
}

async function mapWithDeadline<T>(
  items: string[],
  concurrency: number,
  deadlineAt: number,
  worker: (item: string) => Promise<T>
): Promise<Array<T | null>> {
  const results: Array<T | null> = new Array(items.length).fill(null);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) return;
      results[index] = await withDeadline(worker(item), remaining);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Shared parser for provider chat completions (Codex-LB, OpenRouter): turns a
 * model answer into a clamped combat doctrine, or null when it is not usable.
 */
function doctrineFromModelJson(
  content: string,
  fallback: TacticalDoctrine,
  options: { prefix: string; fallbackTacticLine: string; latencyMs: number }
): TacticalDoctrine | null {
  const parsed = extractJson(content) as Record<string, unknown> | null;
  if (!parsed) return null;
  const agg = Number(parsed.aggression);
  const prec = Number(parsed.precision);
  const mob = Number(parsed.mobility);
  const lead = Number(parsed.leadAiming);
  const pref = String(parsed.targetPreference ?? "");
  const validPrefs = ["nearest", "threat", "rocks", "enemies"] as const;
  const targetPref = validPrefs.includes(pref as any) ? (pref as TacticalDoctrine["targetPreference"]) : fallback.targetPreference;
  const rawTactic = typeof parsed.tactic === "string" ? parsed.tactic.trim() : "";
  const tactic =
    rawTactic && /^[\x20-\x7E]{1,60}$/.test(rawTactic) ? `${options.prefix}${rawTactic}` : options.fallbackTacticLine;

  return {
    aggression: Number.isFinite(agg) ? Math.max(0.2, Math.min(1.0, agg)) : fallback.aggression,
    precision: Number.isFinite(prec) ? Math.max(0.3, Math.min(1.0, prec)) : fallback.precision,
    mobility: Number.isFinite(mob) ? Math.max(0.3, Math.min(1.0, mob)) : fallback.mobility,
    leadAiming: Number.isFinite(lead) ? Math.max(0.0, Math.min(1.0, lead)) : fallback.leadAiming,
    targetPreference: targetPref,
    tactic,
    latencyMs: options.latencyMs,
    source: "model",
  };
}

export async function fetchModelTactics(modelId: string, situation?: unknown): Promise<TacticalDoctrine> {
  const start = Date.now();
  const seed = modelSeed(modelId);
  const fallbackTactic: TacticalDoctrine = {
    aggression: 0.6 + (seed % 35) / 100,
    precision: 0.6 + ((seed >>> 8) % 35) / 100,
    mobility: 0.6 + ((seed >>> 16) % 35) / 100,
    leadAiming: 0.5 + ((seed >>> 24) % 45) / 100,
    targetPreference: (seed % 4 === 0 ? "threat" : seed % 4 === 1 ? "enemies" : seed % 4 === 2 ? "rocks" : "nearest"),
    tactic: "Autonomous flight doctrine",
    latencyMs: 0,
    source: "fallback",
  };

  try {
    const isJev = modelId === "openrouter/typesafe/jev-1.13" || modelId === "typesafe/jev-1.13" || modelId.endsWith("/jev-1.13");
    if (isJev) {
      try {
        const decisionsService = createDecisionsService();
        const decisionResult = await decisionsService.decide({
          state: typeof situation === "object" && situation !== null
            ? { ...situation, hostiles: "Alien gunships deploying lasers and collision hazards", objective: "Maximum dogfight score with lethal accuracy and evasive dashing" }
            : { rocks: 8, difficulty: 4, sector: "Asteroids dogfight arena", hostiles: "Alien gunships deploying lasers", objective: "Maximum combat score with lethal accuracy" },
          questions: {
            target_preference: {
              type: "choice",
              instructions: "Select tactical target priority for starship fire control.",
              criteria: {
                threat: "Prioritize incoming collision hazards and active lethal hostile raiders to ensure survival",
                enemies: "Hunt and eliminate high-value alien gunships and raiders for maximum score",
                rocks: "Fire at distant drifting rock debris",
                nearest: "Engage nearest radar contact",
              },
            },
            combat_style: {
              type: "choice",
              instructions: "Select combat dogfight doctrine.",
              criteria: {
                interceptor: "Precision interceptor hunting high-value threats",
                blitz: "High-speed aggressive combat assault with heavy ordnance",
                kiting: "Defensive standoff evasion",
                defensive: "Low-risk perimeter sweep",
              },
            },
            aggression: {
              type: "score",
              instructions: "Combat aggression and tactical bomb deployment authorization.",
              criteria: ["Cautious standoff", "Standard patrol", "Aggressive tactical dogfight", "Full combat assault with heavy bombs"],
            },
            mobility: {
              type: "score",
              instructions: "Thruster mobility and emergency evasive dash readiness.",
              criteria: ["Stationary drift", "Gentle maneuvers", "Active evasive thrusting", "High-mobility tactical dashing"],
            },
            precision: {
              type: "score",
              instructions: "Marksman targeting discipline and ballistic lead calculation.",
              criteria: ["Wide spread fire", "Focused burst fire", "Pinpoint marksman precision"],
            },
            lead_aiming: {
              type: "score",
              instructions: "Ballistic trajectory deflection prediction.",
              criteria: ["Direct aim without lead", "Moderate lead estimation", "Full predictive trajectory intercept calculation"],
            },
          },
        });

        const latencyMs = Date.now() - start;
        if (decisionResult.available && decisionResult.answers) {
          const answers = decisionResult.answers as Record<string, { choice?: string; score?: number }>;
          const targetChoice = String(answers["target_preference"]?.choice ?? "");
          const validPrefs = ["nearest", "threat", "rocks", "enemies"] as const;
          const targetPref = validPrefs.includes(targetChoice as any)
            ? (targetChoice as TacticalDoctrine["targetPreference"])
            : fallbackTactic.targetPreference;

          const aggScore = Number(answers["aggression"]?.score);
          const mobScore = Number(answers["mobility"]?.score);
          const precScore = Number(answers["precision"]?.score);
          const leadScore = Number(answers["lead_aiming"]?.score);

          const agg = Number.isFinite(aggScore) ? Math.min(0.95, Math.max(0.4, 0.45 + (aggScore / 3) * 0.5)) : fallbackTactic.aggression;
          const mob = Number.isFinite(mobScore) ? Math.min(0.95, Math.max(0.4, 0.45 + (mobScore / 3) * 0.45)) : fallbackTactic.mobility;
          const prec = Number.isFinite(precScore) ? Math.max(0.4, Math.min(0.95, 0.45 + (precScore / 2) * 0.45)) : fallbackTactic.precision;
          const lead = Number.isFinite(leadScore) ? Math.max(0.4, Math.min(0.95, 0.45 + (leadScore / 2) * 0.45)) : fallbackTactic.leadAiming;

          const style = String(answers["combat_style"]?.choice ?? "");
          const tacticLines: Record<string, string> = {
            blitz: "JEV: High-speed blitz assault",
            interceptor: "JEV: Precision interceptor lock",
            kiting: "JEV: Standoff evasive deflection",
            defensive: "JEV: Perimeter defensive sweep",
          };
          const tactic = tacticLines[style] ?? "JEV: Tactical doctrine active";

          return {
            aggression: Math.round(agg * 100) / 100,
            precision: Math.round(prec * 100) / 100,
            mobility: Math.round(mob * 100) / 100,
            leadAiming: Math.round(lead * 100) / 100,
            targetPreference: targetPref,
            tactic,
            latencyMs,
            source: "model",
          };
        }
      } catch {
        fallbackTactic.latencyMs = Date.now() - start;
        return fallbackTactic;
      }
    }

    const isCodex = modelId.startsWith("codex/");
    if (isCodex) {
      try {
        const bareModel = modelId.slice("codex/".length);
        const apiKey = await getCodexApiKey();
        if (apiKey) {
          const system = DOCTRINE_SYSTEM_PROMPT;

          const prompt =
            typeof situation === "object" && situation !== null
              ? `Battle situation: ${JSON.stringify(situation)}`
              : "Battle situation: rocks=8, difficulty=4, sector=Asteroids dogfight arena";

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 12000);
          const response = await fetch(`${CODEX_LB_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: bareModel,
              messages: [
                { role: "system", content: system },
                { role: "user", content: prompt },
              ],
              temperature: 0.2,
              max_tokens: 180,
            }),
          });
          clearTimeout(timer);

          if (response.ok) {
            const data = (await response.json()) as any;
            const content = data.choices?.[0]?.message?.content;
            const latencyMs = Date.now() - start;
            if (typeof content === "string") {
              const doctrine = doctrineFromModelJson(content, fallbackTactic, {
                prefix: "CODEX: ",
                fallbackTacticLine: `CODEX: ${bareModel.toUpperCase()} tactical lock`,
                latencyMs,
              });
              if (doctrine) return doctrine;
            }
          }
        }
      } catch {
        // Fall back to seed doctrine if network or model error
      }
    }

    const isOpenRouter = modelId.startsWith("openrouter/");
    if (isOpenRouter) {
      const bareModel = modelId.slice("openrouter/".length);
      const prompt =
        typeof situation === "object" && situation !== null
          ? `Battle situation: ${JSON.stringify(situation)}`
          : "Battle situation: rocks=8, difficulty=4, sector=Asteroids dogfight arena";
      const content = await requestOpenRouterDoctrine({
        modelId: bareModel,
        system: DOCTRINE_SYSTEM_PROMPT,
        prompt,
      }).catch(() => null);
      if (typeof content === "string") {
        const doctrine = doctrineFromModelJson(content, fallbackTactic, {
          prefix: "OR: ",
          fallbackTacticLine: `OR: ${bareModel.split("/").pop()?.toUpperCase()} tactical lock`,
          latencyMs: Date.now() - start,
        });
        if (doctrine) return doctrine;
      }
    }

    const command = await resolveNativeOpenCodeRuntime();
    if (!command) {
      fallbackTactic.latencyMs = Date.now() - start;
      return fallbackTactic;
    }

    const bareModelId = modelId.startsWith("opencode/") ? modelId.slice("opencode/".length) : modelId;
    // Check if the bare ID contains valid pattern
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(bareModelId)) {
      fallbackTactic.latencyMs = Date.now() - start;
      return fallbackTactic;
    }

    const system =
      "You are the combat pilot AI for a starship in an Asteroids dogfight arena. " +
      "Analyze the battle state and formulate your flight doctrine. Return strict JSON only (no markdown): " +
      '{"aggression": 0.2..1.0, "precision": 0.3..1.0, "mobility": 0.3..1.0, "leadAiming": 0.0..1.0, "targetPreference": "nearest"|"threat"|"rocks"|"enemies", "tactic": "short tactical radio line max 60 chars ASCII"}.';

    const prompt = typeof situation === "object" && situation !== null
      ? `Battle situation: ${JSON.stringify(situation)}`
      : "Battle situation: standard dogfight sector with moving asteroids and hostile gunships.";

    const signal = AbortSignal.timeout(10_000);
    const rawOutput = await generateNativeOpenCodeTitle({
      command,
      modelId: bareModelId,
      system,
      prompt,
      signal,
    });

    const parsed = extractJson(rawOutput) as Record<string, unknown> | null;
    const latencyMs = Date.now() - start;

    if (parsed && typeof parsed === "object") {
      const agg = Number(parsed.aggression);
      const prec = Number(parsed.precision);
      const mob = Number(parsed.mobility);
      const lead = Number(parsed.leadAiming);
      const pref = String(parsed.targetPreference ?? "");
      const validPrefs = ["nearest", "threat", "rocks", "enemies"] as const;
      const targetPref = validPrefs.includes(pref as any) ? (pref as TacticalDoctrine["targetPreference"]) : fallbackTactic.targetPreference;
      const rawTactic = typeof parsed.tactic === "string" ? parsed.tactic.trim() : "";
      const tactic = rawTactic && /^[\x20-\x7E]{1,60}$/.test(rawTactic) ? rawTactic : "Tactical doctrine active";

      return {
        aggression: Number.isFinite(agg) ? Math.max(0.2, Math.min(1.0, agg)) : fallbackTactic.aggression,
        precision: Number.isFinite(prec) ? Math.max(0.3, Math.min(1.0, prec)) : fallbackTactic.precision,
        mobility: Number.isFinite(mob) ? Math.max(0.3, Math.min(1.0, mob)) : fallbackTactic.mobility,
        leadAiming: Number.isFinite(lead) ? Math.max(0.0, Math.min(1.0, lead)) : fallbackTactic.leadAiming,
        targetPreference: targetPref,
        tactic,
        latencyMs,
        source: "model",
      };
    }

    fallbackTactic.latencyMs = latencyMs;
    return fallbackTactic;
  } catch {
    fallbackTactic.latencyMs = Date.now() - start;
    return fallbackTactic;
  }
}

export interface LivePilotDirective {
  action: "emergency_dash" | "tactical_bomb" | "lock_and_fire" | "strafe_circle" | "breakaway" | "full_assault";
  turnBias?: "left" | "right" | "direct";
  thrustOverride?: boolean;
  radioCallout: string;
  confidence: number;
  latencyMs: number;
}

export async function fetchModelLiveDirective(
  modelId: string,
  telemetry: {
    distanceToClosestHazard: number;
    hazardType?: string;
    hazardAngleDelta?: number;
    rocksCount?: number;
    enemiesCount?: number;
    hullHp?: number;
    shieldCharges?: number;
    bombsAvailable?: number;
    isImmune?: boolean;
    speed?: number;
    elapsedSeconds?: number;
  }
): Promise<LivePilotDirective> {
  const start = Date.now();
  const isJev = modelId === "openrouter/typesafe/jev-1.13" || modelId === "typesafe/jev-1.13" || modelId.endsWith("/jev-1.13");

  if (isJev) {
    try {
      const decisionsService = createDecisionsService();
      const decision = await decisionsService.decide({
        state: {
          hazardDistance: Math.round(telemetry.distanceToClosestHazard),
          hazardType: telemetry.hazardType ?? "rock",
          relativeAngle: Math.round((telemetry.hazardAngleDelta ?? 0) * 100) / 100,
          hullIntegrity: telemetry.hullHp ?? 3,
          shields: telemetry.shieldCharges ?? 0,
          bombs: telemetry.bombsAvailable ?? 0,
          nearbyHostiles: telemetry.enemiesCount ?? 0,
        },
        questions: {
          reaction: {
            type: "choice",
            instructions: "Select immediate starship reaction for next 1-2 seconds of dogfight.",
            criteria: {
              emergency_dash: "Execute emergency thruster dash to escape lethal collision trajectory",
              tactical_bomb: "Trigger tactical antimatter bomb to obliterate surrounding cluster",
              lock_and_fire: "Lock fire control and discharge full weapon salvos on priority target",
              strafe_circle: "Perform high-speed orbital strafe around the hazard zone",
              breakaway: "Disengage thrusters and reverse vector to establish safe firing range",
            },
          },
          urgency: {
            type: "score",
            instructions: "Rate urgent evasive necessity.",
            criteria: ["Safe space", "Caution", "High threat", "Critical imminent impact"],
          },
        },
      });

      const latencyMs = Date.now() - start;
      if (decision.available && decision.answers) {
        const answers = decision.answers as Record<string, { choice?: string; score?: number }>;
        const choice = String(answers["reaction"]?.choice ?? "");
        const validActions: LivePilotDirective["action"][] = [
          "emergency_dash",
          "tactical_bomb",
          "lock_and_fire",
          "strafe_circle",
          "breakaway",
          "full_assault",
        ];
        const action = validActions.includes(choice as any) ? (choice as LivePilotDirective["action"]) : "lock_and_fire";
        const callouts: Record<string, string> = {
          emergency_dash: "⚡ JEV: EVASIVE DASH VECTOR",
          tactical_bomb: "💥 JEV: ANTIMATTER BOMB RELEASE",
          lock_and_fire: "🎯 JEV: TARGET LOCK CONFIRMED",
          strafe_circle: "🔄 JEV: ORBITAL STRAFE MANEUVER",
          breakaway: "🚀 JEV: REVERSE THRUST VECTOR",
          full_assault: "⚔️ JEV: MAXIMUM ASSAULT VECTOR",
        };

        return {
          action,
          turnBias: telemetry.hazardAngleDelta && telemetry.hazardAngleDelta > 0 ? "left" : "right",
          thrustOverride: action === "emergency_dash" || action === "strafe_circle",
          radioCallout: callouts[action] ?? "JEV: REACTIVE DIRECTIVE",
          confidence: 0.95,
          latencyMs,
        };
      }
    } catch {}
  }

  const latencyMs = Date.now() - start;
  const dist = telemetry.distanceToClosestHazard ?? 200;
  const bombs = telemetry.bombsAvailable ?? 0;
  const enemies = telemetry.enemiesCount ?? 0;
  const isCodex = modelId.startsWith("codex/");
  const prefix = isJev
    ? "JEV"
    : isCodex
    ? `CODEX-${modelId.split("/").pop()?.slice(0, 8).toUpperCase()}`
    : modelId.split("/").pop()?.slice(0, 10).toUpperCase() ?? "PILOT";

  if (dist < 100 && (telemetry.shieldCharges ?? 0) === 0 && !telemetry.isImmune) {
    return {
      action: "emergency_dash",
      turnBias: telemetry.hazardAngleDelta && telemetry.hazardAngleDelta > 0 ? "left" : "right",
      thrustOverride: true,
      radioCallout: `⚡ ${prefix}: EVASIVE DASH`,
      confidence: 0.88,
      latencyMs,
    };
  }

  if (bombs > 0 && (enemies >= 2 || (telemetry.rocksCount ?? 0) >= 8)) {
    return {
      action: "tactical_bomb",
      radioCallout: `💥 ${prefix}: ORDNANCE RELEASE`,
      confidence: 0.92,
      latencyMs,
    };
  }

  if (dist > 150) {
    return {
      action: "lock_and_fire",
      thrustOverride: true,
      radioCallout: `🎯 ${prefix}: TARGET ACQUIRED`,
      confidence: 0.85,
      latencyMs,
    };
  }

  return {
    action: "strafe_circle",
    turnBias: "right",
    thrustOverride: true,
    radioCallout: `🔄 ${prefix}: COMBAT DRIFT`,
    confidence: 0.8,
    latencyMs,
  };
}

export interface BenchmarkTaskResult {
  taskId: string;
  category: string;
  title: string;
  durationMs?: number;
  turnStatus?: string;
  tokens?: { total?: number; input?: number; output?: number } | null;
  deterministic?: { score: number; checks: Array<{ id: string; pass: boolean }> };
  judge?: { score: number | null; skipped?: boolean; criteria: Array<{ criterion: string; score: number | null }> };
  finalScore: number | null;
  error?: string;
}

export interface BenchmarkRunRecord {
  runTs: string;
  runId: string;
  model: string;
  runtime: string;
  judgeModel?: string | null;
  noJudge?: boolean;
  tasks: BenchmarkTaskResult[];
}

export interface BenchmarkLeaderboardResponse {
  available: boolean;
  resultsDir: string;
  generatedAt: string;
  runs: BenchmarkRunRecord[];
}

function resultsDir(): string {
  const configured = process.env.SPACE_BENCHMARK_RESULTS_DIR;
  return configured && configured.trim() ? configured.trim() : DEFAULT_RESULTS_DIR;
}

async function loadRunFiles(dir: string): Promise<Array<{ runId: string; record: BenchmarkRunRecord }>> {
  const entries = await readdir(dir);
  const jsonFiles = entries
    .filter((name) => name.endsWith(".json") && name !== "leaderboard.json")
    .sort()
    .slice(0, MAX_RUN_FILES);
  const runs: Array<{ runId: string; record: BenchmarkRunRecord }> = [];
  for (const name of jsonFiles) {
    const fullPath = join(dir, name);
    const info = await stat(fullPath).catch(() => null);
    if (!info || !info.isFile() || info.size > MAX_FILE_BYTES) continue;
    const text = await readFile(fullPath, "utf8");
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      continue;
    }
    const candidate = record as Partial<BenchmarkRunRecord> | null;
    if (!candidate || typeof candidate.runId !== "string" || typeof candidate.model !== "string") continue;
    runs.push({ runId: candidate.runId, record: candidate as BenchmarkRunRecord });
  }
  runs.sort((left, right) => right.record.runTs.localeCompare(left.record.runTs));
  return runs;
}

export function registerBenchmarkRoutes(app: FastifyInstance, rateLimitOptions: RouteShorthandOptions): void {
  app.get("/api/asteroids/benchmark/models", rateLimitOptions, async () => {
    let opencodeModels: Array<{ id: string; displayName: string; providerId: string; status: string }> = [];
    try {
      const command = await resolveNativeOpenCodeRuntime();
      if (command) {
        const catalog = await nativeOpenCodeModelCatalog(command);
        opencodeModels = Object.entries(catalog.providers.find((provider) => provider.id === "opencode")?.models ?? {})
          .filter(([, raw]) => {
            const model = raw as { cost?: { input?: number; output?: number }; status?: string };
            return model.cost?.input === 0 && model.cost?.output === 0 && !model.status?.toLowerCase().includes("deprecated");
          })
          .map(([id]) => ({
            id,
            displayName: id,
            providerId: "opencode",
            status: "VERIFIED",
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
      }
    } catch {}
    const codexModels = await loadCodexModels();
    const antigravityModels = await loadAntigravityModels();
    const openRouterModels = await loadOpenRouterBenchmarkModels().catch(() => []);
    const allModels = [
      ...codexModels,
      ...opencodeModels,
      ...antigravityModels,
      ...openRouterModels,
      JEV_MODEL,
      GITHUB_AUTO_MODEL,
    ];
    return { available: allModels.length > 0, models: [...new Map(allModels.map((model) => [model.id, model])).values()] };
  });

  app.get<{ Querystring: { mode?: AsteroidsBenchmarkMode } }>("/api/asteroids/benchmark/championship", rateLimitOptions, async (request, reply) => {
    const mode = request.query?.mode ?? "championship";
    if (!Object.hasOwn(CHAMPIONSHIP_FILES, mode)) {
      return reply.code(400).send({ error: { code: "INVALID_MODE", message: "Unknown benchmark mode." } });
    }
    return { mode, championship: await loadChampionship(mode) };
  });

  app.post<{ Body: { modelId?: string; models?: string[]; situation?: unknown } }>(
    "/api/asteroids/benchmark/tactics",
    rateLimitOptions,
    async (request, reply) => {
      const { modelId, models, situation } = request.body ?? {};
      if (Array.isArray(models) && models.length > 0) {
        const ids = [...new Set(models.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(id)))].slice(
          0,
          TACTICS_BATCH_LIMIT
        );
        const results = await mapWithDeadline(ids, TACTICS_BATCH_CONCURRENCY, Date.now() + TACTICS_BATCH_DEADLINE_MS, (id) =>
          fetchModelTactics(id, situation)
        );
        const doctrines: Record<string, TacticalDoctrine> = {};
        results.forEach((doctrine, index) => {
          const id = ids[index];
          if (doctrine && id) doctrines[id] = doctrine;
        });
        return { doctrines };
      }
      if (!modelId || typeof modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(modelId)) {
        return reply.code(400).send({ error: { code: "INVALID_MODEL_ID", message: "Valid modelId or models array is required." } });
      }
      const tactics = await fetchModelTactics(modelId, situation);
      return { modelId, tactics };
    }
  );

  app.post<{
    Body: {
      modelId: string;
      telemetry: {
        distanceToClosestHazard: number;
        hazardType?: string;
        hazardAngleDelta?: number;
        rocksCount?: number;
        enemiesCount?: number;
        hullHp?: number;
        shieldCharges?: number;
        bombsAvailable?: number;
        isImmune?: boolean;
        speed?: number;
        elapsedSeconds?: number;
      };
    };
  }>(
    "/api/asteroids/benchmark/live-directive",
    rateLimitOptions,
    async (request, reply) => {
      const { modelId, telemetry } = request.body ?? {};
      if (!modelId || typeof modelId !== "string" || !telemetry) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "modelId and telemetry are required." } });
      }
      const directive = await fetchModelLiveDirective(modelId, telemetry);
      return { modelId, directive };
    }
  );

  app.post<{
    Body: {
      round: number;
      totalRounds: number;
      mode: AsteroidsBenchmarkMode;
      winnerId: string;
      results: Array<{
        modelId: string;
        displayName: string;
        providerId: string;
        score: number;
        kills: number;
        accuracy: number;
        survival: number;
        tactic?: string;
        latencyMs?: number;
        source: "model";
      }>;
    };
  }>("/api/asteroids/benchmark/record-match", rateLimitOptions, async (request, reply) => {
    const { round, totalRounds, mode, winnerId, results } = request.body ?? {};
    if (!Object.hasOwn(CHAMPIONSHIP_FILES, mode)) {
      return reply.code(400).send({ error: { code: "INVALID_MODE", message: "A valid benchmark mode is required." } });
    }
    if (!Array.isArray(results) || results.length === 0) {
      return reply.code(400).send({ error: { code: "INVALID_RESULTS", message: "Results array is required." } });
    }
    if (!Number.isInteger(round) || round < 1 || !Number.isInteger(totalRounds) || totalRounds < round || totalRounds > 20) {
      return reply.code(400).send({ error: { code: "INVALID_ROUND", message: "Round values are invalid." } });
    }
    if (results.length < 2 || results.some((result) =>
      !result || typeof result.modelId !== "string" || result.source !== "model" ||
      !Number.isFinite(result.score) || result.score < 0 ||
      !Number.isFinite(result.kills) || result.kills < 0 ||
      !Number.isFinite(result.accuracy) || result.accuracy < 0 || result.accuracy > 100 ||
      !Number.isFinite(result.survival) || result.survival < 0 || result.survival > 3600
    )) {
      return reply.code(400).send({ error: { code: "INVALID_METRICS", message: "Only finite model-backed metrics are accepted." } });
    }

    const existing = (await loadChampionship(mode)) ?? {
      id: `asteroids-${Date.now()}`,
      status: "running",
      startedAt: new Date().toISOString(),
      games: totalRounds || round || 1,
      currentGame: round || 1,
      models: [],
      gamesPlayed: [],
    };

    existing.currentGame = round || existing.currentGame + 1;
    existing.games = Math.max(existing.games, totalRounds || existing.currentGame);
    if (existing.currentGame >= existing.games) {
      existing.status = "completed";
      existing.completedAt = new Date().toISOString();
    } else {
      existing.status = "running";
    }

    // Map existing stats by id
    const statsMap = new Map<string, AsteroidsModelStats>(
      existing.models.map((m) => [m.id, m])
    );

    const roundScores: Record<string, { score: number; kills: number; accuracy: number; survival: number; tactic?: string; source?: "model" | "fallback" }> = {};

    for (const res of results) {
      if (!res.modelId) continue;
      const prev = statsMap.get(res.modelId) ?? {
        id: res.modelId,
        displayName: res.displayName || res.modelId,
        providerId: res.providerId || "opencode",
        wins: 0,
        gamesPlayed: 0,
        totalScore: 0,
        bestScore: 0,
        totalKills: 0,
        avgAccuracy: 0,
        totalSurvivalSeconds: 0,
      };

      const isWinner = res.modelId === winnerId;
      prev.wins += isWinner ? 1 : 0;
      prev.gamesPlayed += 1;
      prev.totalScore += Math.max(0, Math.round(res.score || 0));
      prev.bestScore = Math.max(prev.bestScore, Math.round(res.score || 0));
      prev.totalKills += Math.max(0, Math.round(res.kills || 0));
      prev.totalSurvivalSeconds += Math.max(0, Math.round(res.survival || 0));
      prev.avgAccuracy = Math.round(((prev.avgAccuracy * (prev.gamesPlayed - 1) + res.accuracy) / prev.gamesPlayed) * 100) / 100;
      if (res.tactic) prev.lastTactic = res.tactic;
      if (res.latencyMs !== undefined) prev.lastLatencyMs = res.latencyMs;
      prev.lastSource = res.source;

      statsMap.set(res.modelId, prev);
      roundScores[res.modelId] = {
        score: Math.round(res.score || 0),
        kills: Math.round(res.kills || 0),
        accuracy: res.accuracy,
        survival: Math.round(res.survival || 0),
        tactic: res.tactic,
        source: res.source,
      };
    }

    existing.models = [...statsMap.values()].sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins);
    existing.gamesPlayed.push({
      game: round || existing.gamesPlayed.length + 1,
      winner: winnerId || "",
      scores: roundScores,
    });

    await saveChampionship(existing, mode);
    return { recorded: true, mode, championship: existing };
  });

  app.post<{ Body: { mode?: AsteroidsBenchmarkMode } }>("/api/asteroids/benchmark/championship/reset", rateLimitOptions, async (request, reply) => {
    const mode = request.body?.mode ?? "championship";
    if (!Object.hasOwn(CHAMPIONSHIP_FILES, mode)) {
      return reply.code(400).send({ error: { code: "INVALID_MODE", message: "Unknown benchmark mode." } });
    }
    const file = championshipFile(mode);
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { reset: true, mode };
  });

  app.get("/api/benchmark/leaderboard", rateLimitOptions, async () => {
    const dir = resultsDir();
    let runs: Array<{ runId: string; record: BenchmarkRunRecord }> = [];
    let available = false;
    try {
      runs = await loadRunFiles(dir);
      available = true;
    } catch {
      available = false;
    }
    return {
      available,
      resultsDir: dir,
      generatedAt: new Date().toISOString(),
      runs: runs.map((entry) => entry.record)
    } satisfies BenchmarkLeaderboardResponse;
  });

  app.get<{ Params: { runId: string } }>("/api/benchmark/runs/:runId", rateLimitOptions, async (request, reply) => {
    const runId = request.params?.runId ?? "";
    if (!RUN_ID_PATTERN.test(runId) || runId.includes("..")) {
      return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Invalid run id." } });
    }
    const dir = resultsDir();
    const fullPath = join(dir, `${runId}.json`);
    try {
      const info = await stat(fullPath);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Benchmark run not found." } });
      }
      const text = await readFile(fullPath, "utf8");
      return JSON.parse(text) as BenchmarkRunRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Benchmark run not found." } });
      }
      return reply.code(500).send({ error: { code: "INTERNAL", message: "Benchmark results could not be read." } });
    }
  });
}
