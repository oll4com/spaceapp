import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  generateNativeOpenCodeTitle,
  nativeOpenCodeModelCatalog,
  resolveNativeOpenCodeRuntime,
} from "./task-title-opencode.js";
import { createDecisionsService } from "./decisions-service.js";
import {
  AgentArena,
  ARENA_HEIGHT,
  ARENA_MODES,
  ARENA_PROTOCOL_VERSION,
  ARENA_WIDTH,
  DECISION_INTERVAL_TICKS,
  ROUND_SECONDS,
  ROUND_TICKS,
  SCORING,
  SHIP,
  TICK_HZ,
  generateScenario,
  type ArenaMode,
} from "./asteroids-arena/sim.js";
import { MANEUVERS, buildSensorSnapshot, buildSystemPrompt } from "./asteroids-arena/protocol.js";
import { BASELINE_MODEL_ID, CLAUDE_BENCHMARK_MODELS, CODEX_LB_BASE_URL, PROVIDER_PATHS, codexAuthHeaders, getCodexApiKey } from "./asteroids-arena/providers.js";
import { ArenaBenchmarkRunner, ArenaRunError, isArenaModelId, type ArenaContestantInput } from "./asteroids-arena/runner.js";
import { createArenaFileStore, isArenaRunId, leaderboardView, type ArenaStore } from "./asteroids-arena/store.js";
import { loadOpenRouterBenchmarkModels, requestOpenRouterDoctrine } from "./openrouter-benchmark-models.js";

/**
 * Benchmark API.
 *
 * Asteroids Agent Arena (/api/asteroids/benchmark/*): the server runs every
 * benchmark round itself (asteroids-arena/runner.ts) and is the only
 * scorekeeper; browsers start runs, watch live frames and read leaderboards.
 * /tactics and /live-directive stay for the arcade game's AI pilot.
 *
 * Model benchmark results (/api/benchmark/*): read-only views over the
 * published space-model-benchmark results directory.
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
const GEMINI_MODELS_FILE = "/opt/spaceapp/var/gemini-models.last-good.json";
const CODEX_MODELS_CACHE_FILE = "/var/lib/spaceapp-user/.codex/models_cache.json";
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

export { CODEX_LB_BASE_URL, codexAuthHeaders, getCodexApiKey };

async function loadCodexModels(): Promise<Array<{ id: string; displayName: string; providerId: string; status: string }>> {
  // 1. Try the live Codex catalog in Space Gateway
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${CODEX_LB_BASE_URL}/v1/models`, { signal: controller.signal, headers: await codexAuthHeaders() });
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
 * Shared parser for provider chat completions (Space Gateway, OpenRouter): turns a
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
        const outcome = await decisionsService.decideTacticalMovement(
          typeof situation === "object" && situation !== null
            ? { ...situation, hostiles: "Alien gunships deploying lasers and collision hazards", objective: "Maximum dogfight score with lethal accuracy and evasive dashing" }
            : { rocks: 8, difficulty: 4, sector: "Asteroids dogfight arena", hostiles: "Alien gunships deploying lasers", objective: "Maximum combat score with lethal accuracy" }
        );
        return {
          aggression: outcome.aggression,
          precision: outcome.precision,
          mobility: outcome.mobility,
          leadAiming: outcome.leadAiming,
          targetPreference: outcome.targetPreference,
          tactic: outcome.tactic,
          latencyMs: outcome.latencyMs ?? (Date.now() - start),
          source: outcome.source,
        };
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

export interface BenchmarkModel {
  id: string;
  displayName: string;
  providerId: string;
  status: string;
}

const BASELINE_MODEL: BenchmarkModel = { id: BASELINE_MODEL_ID, displayName: "Scripted Baseline", providerId: "baseline", status: "VERIFIED" };

function arenaMode(value: unknown): ArenaMode | undefined {
  const mode = value === undefined || value === null || value === "" ? "championship" : value;
  return typeof mode === "string" && (ARENA_MODES as readonly string[]).includes(mode) ? (mode as ArenaMode) : undefined;
}

function parseContestants(value: unknown): ArenaContestantInput[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const contestants: ArenaContestantInput[] = [];
  for (const entry of value) {
    const raw = typeof entry === "string" ? { id: entry } : (entry as { id?: unknown; displayName?: unknown } | null);
    if (!raw || !isArenaModelId(raw.id)) return null;
    const displayName = typeof raw.displayName === "string" ? raw.displayName.replace(/[^\x20-\x7E\u00A0-\u024F]/g, "").trim().slice(0, 60) : "";
    contestants.push(displayName ? { id: raw.id, displayName } : { id: raw.id });
  }
  return contestants;
}

const MODE_DESCRIPTIONS: Record<ArenaMode, { title: string; tests: string; timing: string }> = {
  championship: {
    title: "Championship",
    tests: "Decision quality: every model flies an identical seeded gauntlet alone, so scores are directly comparable.",
    timing: "Lockstep: the game pauses while the model thinks, so response time never changes the score.",
  },
  duel: {
    title: "Real-Time Duel",
    tests: "Decision quality under time pressure: the same gauntlet, but the game never waits for the model.",
    timing: "Real time: a command applies when it arrives; slow models act on stale snapshots and get fewer decisions.",
  },
  shared_arena: {
    title: "All-in-One Arena",
    tests: "Multi-agent adversarial play: all models share one arena, can shoot each other, and score placement bonuses.",
    timing: "Lockstep: all pilots decide simultaneously on the same tick, then the window plays out.",
  },
};

export function arenaProtocolDescription() {
  const sample = new AgentArena({ key: "sample", mode: "championship", scenario: generateScenario(7, "championship"), pilots: ["sample"] });
  for (let tick = 0; tick < 12 * TICK_HZ; tick += 1) sample.step([null]);
  return {
    protocol: ARENA_PROTOCOL_VERSION,
    tickHz: TICK_HZ,
    roundSeconds: ROUND_SECONDS,
    decisionIntervalS: DECISION_INTERVAL_TICKS / TICK_HZ,
    decisionsPerRound: Math.ceil(ROUND_TICKS / DECISION_INTERVAL_TICKS),
    decisionTimeoutS: 60,
    realtimeDecisionTimeoutS: 30,
    arena: { width: ARENA_WIDTH, height: ARENA_HEIGHT },
    scoring: SCORING,
    ship: SHIP,
    maneuvers: MANEUVERS,
    modes: Object.fromEntries(ARENA_MODES.map((mode) => [mode, { ...MODE_DESCRIPTIONS[mode], systemPrompt: buildSystemPrompt(mode) }])),
    sampleSnapshot: buildSensorSnapshot(sample, 0, { decisionIndex: 8, decisionsTotal: 30 }),
    providers: PROVIDER_PATHS,
  };
}

/** Every model the arena can fly, grouped by provider (also used by the headless runner). */
export async function loadArenaModelCatalog(): Promise<{ available: boolean; models: BenchmarkModel[]; providers: Array<{ id: string; path: string }> }> {
  let opencodeModels: BenchmarkModel[] = [];
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
          id: `opencode/${id}`,
          displayName: id,
          providerId: "opencode",
          status: "VERIFIED",
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    }
  } catch {}
  const [codexModels, antigravityModels, openRouterModels] = await Promise.all([
    loadCodexModels(),
    loadAntigravityModels(),
    loadOpenRouterBenchmarkModels().catch(() => []),
  ]);
  const claudeModels = CLAUDE_BENCHMARK_MODELS.map((model) => ({ ...model, providerId: "claude", status: "VERIFIED" }));
  const allModels: BenchmarkModel[] = [
    ...codexModels,
    ...claudeModels,
    ...opencodeModels,
    ...antigravityModels,
    ...openRouterModels,
    JEV_MODEL,
    GITHUB_AUTO_MODEL,
    BASELINE_MODEL,
  ];
  return {
    available: allModels.length > 0,
    models: [...new Map(allModels.map((model) => [model.id, model])).values()],
    providers: Object.entries(PROVIDER_PATHS).map(([id, path]) => ({ id, path })),
  };
}

/** Starting, stopping and resetting runs spends model quota: ADMIN or OPERATOR only (same rule as chess). */
function canControlArena(request: FastifyRequest): boolean {
  const role = request.user?.role;
  return role === "ADMIN" || role === "OPERATOR";
}

export function registerBenchmarkRoutes(
  app: FastifyInstance,
  rateLimitOptions: RouteShorthandOptions,
  arena: { store?: ArenaStore; runner?: ArenaBenchmarkRunner; claudeProfile?: () => Promise<string | null> } = {}
): void {
  const arenaStore = arena.store ?? createArenaFileStore();
  const arenaRunner = arena.runner ?? new ArenaBenchmarkRunner({ store: arenaStore, ...(arena.claudeProfile ? { claudeProfile: arena.claudeProfile } : {}) });
  app.get("/api/asteroids/benchmark/models", rateLimitOptions, async () => loadArenaModelCatalog());

  app.get("/api/asteroids/benchmark/protocol", rateLimitOptions, async () => arenaProtocolDescription());

  app.get<{ Querystring: { mode?: string } }>("/api/asteroids/benchmark/leaderboard", rateLimitOptions, async (request, reply) => {
    const mode = arenaMode(request.query?.mode);
    if (!mode) return reply.code(400).send({ error: { code: "INVALID_MODE", message: "Unknown benchmark mode." } });
    return leaderboardView(await arenaStore.loadLeaderboard(mode), mode);
  });

  // Compatibility view for Room Agent telemetry (asteroids.control).
  app.get<{ Querystring: { mode?: string } }>("/api/asteroids/benchmark/championship", rateLimitOptions, async (request, reply) => {
    const mode = arenaMode(request.query?.mode);
    if (!mode) return reply.code(400).send({ error: { code: "INVALID_MODE", message: "Unknown benchmark mode." } });
    return { mode, championship: leaderboardView(await arenaStore.loadLeaderboard(mode), mode), live: arenaRunner.liveSince(Number.MAX_SAFE_INTEGER).run };
  });

  app.post<{ Body: { mode?: string; models?: unknown; contestants?: unknown; rounds?: unknown; claudeAccount?: unknown } }>(
    "/api/asteroids/benchmark/runs",
    rateLimitOptions,
    async (request, reply) => {
      if (!canControlArena(request)) {
        return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Only an admin can start a benchmark run." } });
      }
      const body = request.body ?? {};
      const mode = arenaMode(body.mode);
      if (!mode) return reply.code(400).send({ error: { code: "INVALID_MODE", message: "Unknown benchmark mode." } });
      const contestants = parseContestants(body.contestants ?? body.models);
      if (!contestants) {
        return reply.code(400).send({ error: { code: "INVALID_RUN", message: "contestants must be a list of model ids." } });
      }
      const rounds = typeof body.rounds === "number" ? body.rounds : 3;
      const claudeAccount = typeof body.claudeAccount === "string" && body.claudeAccount.trim() ? body.claudeAccount.trim() : undefined;
      try {
        const run = arenaRunner.start({ mode, contestants, rounds, ...(claudeAccount ? { claudeAccount } : {}), origin: "ui" });
        return reply.code(202).send({ run });
      } catch (error) {
        if (error instanceof ArenaRunError) {
          return reply.code(error.code === "RUN_ACTIVE" ? 409 : 400).send({ error: { code: error.code, message: error.message } });
        }
        throw error;
      }
    }
  );

  app.post("/api/asteroids/benchmark/runs/stop", rateLimitOptions, async (request, reply) => {
    if (!canControlArena(request)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Only an admin can stop a benchmark run." } });
    }
    return { stopped: arenaRunner.stop() };
  });

  app.get<{ Querystring: { after?: string } }>("/api/asteroids/benchmark/live", rateLimitOptions, async (request) => {
    const after = Number(request.query?.after ?? -1);
    return arenaRunner.liveSince(Number.isFinite(after) ? Math.trunc(after) : -1);
  });

  app.get<{ Querystring: { mode?: string; limit?: string } }>("/api/asteroids/benchmark/runs", rateLimitOptions, async (request, reply) => {
    const modeInput = request.query?.mode;
    const mode = modeInput === undefined || modeInput === "" ? null : arenaMode(modeInput);
    if (mode === undefined) return reply.code(400).send({ error: { code: "INVALID_MODE", message: "Unknown benchmark mode." } });
    const limit = Math.max(1, Math.min(40, Number(request.query?.limit ?? 12) || 12));
    const activeId = arenaRunner.active ? arenaRunner.liveSince(Number.MAX_SAFE_INTEGER).run?.id : null;
    const runs = (await arenaStore.listRuns(mode, limit)).map((run) =>
      run.status === "running" && run.id !== activeId ? { ...run, status: "interrupted" as const } : run
    );
    return { runs };
  });

  app.get<{ Params: { id: string } }>("/api/asteroids/benchmark/runs/:id", rateLimitOptions, async (request, reply) => {
    const id = request.params?.id;
    if (!isArenaRunId(id)) return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Invalid run id." } });
    const run = await arenaStore.loadRun(id);
    if (!run) return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Benchmark run not found." } });
    return run;
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

  app.post<{ Body: { mode?: string } }>("/api/asteroids/benchmark/championship/reset", rateLimitOptions, async (request, reply) => {
    if (!canControlArena(request)) {
      return reply.code(403).send({ error: { code: "FORBIDDEN", message: "Only an admin can reset the leaderboard." } });
    }
    const mode = arenaMode(request.body?.mode);
    if (!mode) return reply.code(400).send({ error: { code: "INVALID_MODE", message: "Unknown benchmark mode." } });
    await arenaStore.resetLeaderboard(mode);
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
