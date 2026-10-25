// Mirrors apps/api/src/asteroids-arena (the demo bundle boundary keeps this page self-contained).

export type ArenaMode = "championship" | "duel" | "shared_arena";
export const ARENA_MODE_ORDER: ArenaMode[] = ["championship", "duel", "shared_arena"];

export interface ArenaModel {
  id: string;
  displayName: string;
  providerId: string;
  status?: string;
}

export interface ArenaCatalog {
  available: boolean;
  models: ArenaModel[];
  providers: Array<{ id: string; path: string }>;
}

export interface ArenaFrameState {
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

export interface LiveFrame {
  seq: number;
  round: number;
  tick: number;
  arenas: ArenaFrameState[];
}

export interface LiveEvent {
  seq: number;
  round: number;
  t: number;
  kind: "run" | "round" | "decision" | "combat";
  contestantId?: string;
  text: string;
}

export type DecisionOutcome = "ok" | "invalid" | "timeout" | "error";

export interface DecisionTally {
  total: number;
  ok: number;
  invalid: number;
  timeout: number;
  error: number;
}

export interface LivePilot {
  id: string;
  slot: number;
  displayName: string;
  providerId: string;
  color: string;
  reference: boolean;
  status: "ready" | "thinking" | "flying" | "destroyed";
  hull: number;
  shield: number;
  bombs: number;
  roundScore: number;
  runScore: number;
  roundWins: number;
  decisions: DecisionTally;
  avgLatencyMs: number | null;
  last: { outcome: DecisionOutcome; command: string; note?: string; reason?: string; latencyMs: number; t: number } | null;
}

export type RunStatus = "running" | "completed" | "stopped" | "failed" | "interrupted";

export interface LiveRunState {
  id: string;
  mode: ArenaMode;
  origin: "ui" | "cli" | "control";
  status: RunStatus;
  phase: "preflight" | "playing" | "intermission" | "finished";
  message: string;
  round: number;
  rounds: number;
  t: number;
  tLeft: number;
  decisionIndex: number;
  decisionsPerRound: number;
  realtime: boolean;
  startedAt: string;
  completedAt?: string;
  pilots: LivePilot[];
  skipped: Array<{ id: string; displayName: string; providerId: string; reason: string }>;
  roundWinners: Array<{ round: number; winnerId: string; bestModelId: string | null; scores: Record<string, number> }>;
  championId: string | null;
}

export interface LiveResponse {
  run: LiveRunState | null;
  frames: LiveFrame[];
  events: LiveEvent[];
  latestSeq: number;
}

export interface LeaderboardRow {
  rank: number;
  id: string;
  displayName: string;
  providerId: string;
  reference: boolean;
  rounds: number;
  wins: number;
  winRate: number;
  avgScore: number;
  bestScore: number;
  totalScore: number;
  kills: { rocks: number; drones: number; pilots: number };
  accuracy: number | null;
  avgHullLost: number;
  survivalRate: number;
  avgSurvivalS: number;
  validRate: number | null;
  decisions: DecisionTally;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  vsBaseline: number | null;
  degradedRounds: number;
  lastPlayedAt: string;
}

export interface LeaderboardView {
  mode: ArenaMode;
  protocol: string;
  updatedAt: string | null;
  runs: number;
  roundsRecorded: number;
  championId: string | null;
  rows: LeaderboardRow[];
}

export interface RunSummary {
  id: string;
  mode: ArenaMode;
  origin: "ui" | "cli" | "control";
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  rounds: number;
  roundsPlayed: number;
  contestants: number;
  skipped: number;
  championId: string | null;
  championName: string | null;
}

export interface DecisionRecord {
  k: number;
  t: number;
  outcome: DecisionOutcome;
  latencyMs: number;
  command: string;
  note?: string;
  reason?: string;
  reply?: string;
  tokens?: number;
}

export interface RoundResult {
  contestantId: string;
  score: number;
  breakdown: { rocks: number; drones: number; pilots: number; pickups: number; survival: number; damage: number; placement: number };
  kills: { rocks: number; drones: number; pilots: number };
  shotsFired: number;
  shotsHit: number;
  accuracy: number | null;
  hullLost: number;
  shieldAbsorbed: number;
  pickups: number;
  bombsUsed: number;
  dashesUsed: number;
  survivedS: number;
  destroyed: boolean;
  placement: number | null;
  rank: number;
  decisions: DecisionTally;
  latency: { avgMs: number; p50Ms: number; p95Ms: number; maxMs: number } | null;
  maneuvers: Record<string, number>;
  tokens: number | null;
  degraded: boolean;
}

export interface RunRecord {
  id: string;
  mode: ArenaMode;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  config: { rounds: number; decisionIntervalS: number; roundSeconds: number; realtime: boolean; claudeAccount: string; seed: number; decisionTimeoutS: number };
  contestants: Array<{ id: string; displayName: string; providerId: string; slot: number; color: string; reference: boolean }>;
  skipped: Array<{ id: string; displayName: string; providerId: string; reason: string }>;
  rounds: Array<{ round: number; seed: number; durationS: number; winnerId: string; bestModelId: string | null; results: RoundResult[]; decisions: Record<string, DecisionRecord[]> }>;
  championId: string | null;
  error?: string;
}

export interface ArenaProtocol {
  protocol: string;
  tickHz: number;
  roundSeconds: number;
  decisionIntervalS: number;
  decisionsPerRound: number;
  decisionTimeoutS: number;
  scoring: {
    rock: Record<string, number>;
    hunter: number;
    gunship: number;
    pilotHit: number;
    pilotKill: number;
    pickup: number;
    survivalPerSecond: number;
    hullLost: number;
    placement: number[];
  };
  maneuvers: string[];
  modes: Record<ArenaMode, { title: string; tests: string; timing: string; systemPrompt: string }>;
  sampleSnapshot: unknown;
  providers: Record<string, string>;
}
