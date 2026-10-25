import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARENA_PROTOCOL_VERSION, type ArenaMode, type ScoreBreakdown } from "./sim.js";
import type { ArenaProviderId } from "./providers.js";

export const DEFAULT_ARENA_RESULTS_DIR = "/opt/spaceapp/var/asteroids-benchmark";
const MAX_RUN_FILES = 40;
const RUN_ID_PATTERN = /^arena-[a-z0-9-]{6,80}$/;

export type DecisionOutcome = "ok" | "invalid" | "timeout" | "error";

export interface DecisionRecord {
  /** Decision index within the round (0-based). */
  k: number;
  /** Game time (s) of the snapshot the decision answered. */
  t: number;
  outcome: DecisionOutcome;
  latencyMs: number;
  command: string;
  note?: string;
  reason?: string;
  /** First characters of an unusable reply, kept for audit. */
  reply?: string;
  tokens?: number;
}

export interface DecisionTally { total: number; ok: number; invalid: number; timeout: number; error: number }

export interface ArenaContestant {
  id: string;
  displayName: string;
  providerId: ArenaProviderId;
  slot: number;
  color: string;
  /** The scripted baseline: shown for reference, never crowned champion. */
  reference: boolean;
}

export interface RoundResult {
  contestantId: string;
  score: number;
  breakdown: ScoreBreakdown;
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
  /** More than a quarter of the decisions failed on the provider side: excluded from the leaderboard. */
  degraded: boolean;
}

export interface RoundRecord {
  round: number;
  seed: number;
  durationS: number;
  winnerId: string;
  bestModelId: string | null;
  results: RoundResult[];
  decisions: Record<string, DecisionRecord[]>;
}

export type RunStatus = "running" | "completed" | "stopped" | "failed" | "interrupted";

export interface RunRecord {
  schemaVersion: 2;
  protocol: string;
  id: string;
  mode: ArenaMode;
  origin: "ui" | "cli" | "control";
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  config: { rounds: number; decisionIntervalS: number; roundSeconds: number; realtime: boolean; claudeAccount: string; seed: number; decisionTimeoutS: number };
  contestants: ArenaContestant[];
  skipped: Array<{ id: string; displayName: string; providerId: ArenaProviderId; reason: string }>;
  rounds: RoundRecord[];
  championId: string | null;
  error?: string;
}

export interface LeaderboardEntry {
  id: string;
  displayName: string;
  providerId: ArenaProviderId;
  reference: boolean;
  rounds: number;
  wins: number;
  totalScore: number;
  bestScore: number;
  worstScore: number;
  kills: { rocks: number; drones: number; pilots: number };
  shotsFired: number;
  shotsHit: number;
  hullLost: number;
  survivedRounds: number;
  survivalSeconds: number;
  pickups: number;
  decisions: DecisionTally;
  latencySamples: number[];
  latencyTotalMs: number;
  latencyCount: number;
  tokens: number;
  baselineRounds: number;
  baselineDeltaSum: number;
  degradedRounds: number;
  lastPlayedAt: string;
  lastRunId: string;
}

export interface Leaderboard {
  schemaVersion: 2;
  protocol: string;
  mode: ArenaMode;
  updatedAt: string;
  runs: string[];
  roundsRecorded: number;
  entries: LeaderboardEntry[];
}

export interface LeaderboardRow {
  rank: number;
  id: string;
  displayName: string;
  providerId: ArenaProviderId;
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
  origin: RunRecord["origin"];
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

export function emptyTally(): DecisionTally {
  return { total: 0, ok: 0, invalid: 0, timeout: 0, error: 0 };
}

export function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

export function leaderboardView(board: Leaderboard | null, mode: ArenaMode): LeaderboardView {
  if (!board) return { mode, protocol: ARENA_PROTOCOL_VERSION, updatedAt: null, runs: 0, roundsRecorded: 0, championId: null, rows: [] };
  const rows = board.entries
    .filter((entry) => entry.rounds > 0)
    .map((entry): Omit<LeaderboardRow, "rank"> => {
      const latency = entry.latencyCount > 0 ? Math.round(entry.latencyTotalMs / entry.latencyCount) : null;
      const answered = entry.decisions.ok + entry.decisions.invalid + entry.decisions.timeout;
      return {
        id: entry.id,
        displayName: entry.displayName,
        providerId: entry.providerId,
        reference: entry.reference,
        rounds: entry.rounds,
        wins: entry.wins,
        winRate: Math.round((entry.wins / entry.rounds) * 100),
        avgScore: Math.round(entry.totalScore / entry.rounds),
        bestScore: entry.bestScore,
        totalScore: entry.totalScore,
        kills: entry.kills,
        accuracy: entry.shotsFired > 0 ? Math.round((entry.shotsHit / entry.shotsFired) * 100) : null,
        avgHullLost: round1(entry.hullLost / entry.rounds),
        survivalRate: Math.round((entry.survivedRounds / entry.rounds) * 100),
        avgSurvivalS: round1(entry.survivalSeconds / entry.rounds),
        validRate: entry.reference || answered === 0 ? null : Math.round((entry.decisions.ok / answered) * 100),
        decisions: entry.decisions,
        avgLatencyMs: entry.reference ? null : latency,
        p50LatencyMs: entry.reference ? null : percentile(entry.latencySamples, 0.5),
        p95LatencyMs: entry.reference ? null : percentile(entry.latencySamples, 0.95),
        vsBaseline: entry.reference || entry.baselineRounds === 0 ? null : Math.round(entry.baselineDeltaSum / entry.baselineRounds),
        degradedRounds: entry.degradedRounds,
        lastPlayedAt: entry.lastPlayedAt
      };
    })
    .sort((left, right) => right.avgScore - left.avgScore || right.wins - left.wins || left.displayName.localeCompare(right.displayName))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return {
    mode,
    protocol: board.protocol,
    updatedAt: board.updatedAt,
    runs: board.runs.length,
    roundsRecorded: board.roundsRecorded,
    championId: rows.find((row) => !row.reference)?.id ?? null,
    rows
  };
}

/** Folds one finished round into a mode leaderboard (degraded results are counted but not scored). */
export function applyRoundToLeaderboard(board: Leaderboard, run: RunRecord, round: RoundRecord, at: string): Leaderboard {
  const contestants = new Map(run.contestants.map((contestant) => [contestant.id, contestant]));
  const baseline = round.results.find((result) => contestants.get(result.contestantId)?.reference && !result.degraded) ?? null;
  const counted = round.results.filter((result) => !result.degraded);
  const winner = [...counted].sort((left, right) => left.rank - right.rank)[0]?.contestantId ?? null;
  const entries = new Map(board.entries.map((entry) => [entry.id, entry]));
  for (const result of round.results) {
    const contestant = contestants.get(result.contestantId);
    if (!contestant) continue;
    const entry: LeaderboardEntry = entries.get(contestant.id) ?? {
      id: contestant.id,
      displayName: contestant.displayName,
      providerId: contestant.providerId,
      reference: contestant.reference,
      rounds: 0,
      wins: 0,
      totalScore: 0,
      bestScore: 0,
      worstScore: 0,
      kills: { rocks: 0, drones: 0, pilots: 0 },
      shotsFired: 0,
      shotsHit: 0,
      hullLost: 0,
      survivedRounds: 0,
      survivalSeconds: 0,
      pickups: 0,
      decisions: emptyTally(),
      latencySamples: [],
      latencyTotalMs: 0,
      latencyCount: 0,
      tokens: 0,
      baselineRounds: 0,
      baselineDeltaSum: 0,
      degradedRounds: 0,
      lastPlayedAt: at,
      lastRunId: run.id
    };
    entry.displayName = contestant.displayName;
    entry.lastPlayedAt = at;
    entry.lastRunId = run.id;
    if (result.degraded) {
      entry.degradedRounds += 1;
      entries.set(entry.id, entry);
      continue;
    }
    entry.rounds += 1;
    if (result.contestantId === winner) entry.wins += 1;
    entry.totalScore += result.score;
    entry.bestScore = entry.rounds === 1 ? result.score : Math.max(entry.bestScore, result.score);
    entry.worstScore = entry.rounds === 1 ? result.score : Math.min(entry.worstScore, result.score);
    entry.kills.rocks += result.kills.rocks;
    entry.kills.drones += result.kills.drones;
    entry.kills.pilots += result.kills.pilots;
    entry.shotsFired += result.shotsFired;
    entry.shotsHit += result.shotsHit;
    entry.hullLost += result.hullLost;
    entry.survivedRounds += result.destroyed ? 0 : 1;
    entry.survivalSeconds += result.survivedS;
    entry.pickups += result.pickups;
    for (const key of ["total", "ok", "invalid", "timeout", "error"] as const) entry.decisions[key] += result.decisions[key];
    entry.tokens += result.tokens ?? 0;
    const samples = (round.decisions[result.contestantId] ?? [])
      .filter((decision) => decision.outcome === "ok" || decision.outcome === "invalid")
      .map((decision) => decision.latencyMs);
    entry.latencySamples = [...entry.latencySamples, ...samples].slice(-400);
    entry.latencyTotalMs += samples.reduce((sum, value) => sum + value, 0);
    entry.latencyCount += samples.length;
    if (baseline && !contestant.reference) {
      entry.baselineRounds += 1;
      entry.baselineDeltaSum += result.score - baseline.score;
    }
    entries.set(entry.id, entry);
  }
  return {
    ...board,
    updatedAt: at,
    runs: board.runs.includes(run.id) ? board.runs : [...board.runs, run.id].slice(-200),
    roundsRecorded: board.roundsRecorded + 1,
    entries: [...entries.values()]
  };
}

export function emptyLeaderboard(mode: ArenaMode): Leaderboard {
  return { schemaVersion: 2, protocol: ARENA_PROTOCOL_VERSION, mode, updatedAt: new Date(0).toISOString(), runs: [], roundsRecorded: 0, entries: [] };
}

export function runSummary(run: RunRecord): RunSummary {
  const champion = run.contestants.find((contestant) => contestant.id === run.championId) ?? null;
  return {
    id: run.id,
    mode: run.mode,
    origin: run.origin,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    rounds: run.config.rounds,
    roundsPlayed: run.rounds.length,
    contestants: run.contestants.length,
    skipped: run.skipped.length,
    championId: run.championId,
    championName: champion?.displayName ?? null
  };
}

export interface ArenaStore {
  readonly dir: string;
  loadLeaderboard(mode: ArenaMode): Promise<Leaderboard | null>;
  /** Read-modify-write under a lock file shared by the API and the headless runner. */
  updateLeaderboard(mode: ArenaMode, update: (board: Leaderboard) => Leaderboard): Promise<Leaderboard>;
  resetLeaderboard(mode: ArenaMode): Promise<void>;
  saveRun(run: RunRecord): Promise<void>;
  loadRun(id: string): Promise<RunRecord | null>;
  listRuns(mode: ArenaMode | null, limit: number): Promise<RunSummary[]>;
}

export function isArenaRunId(value: unknown): value is string {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, data, { encoding: "utf8", mode: 0o664 });
  await rename(temp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 30_000) await unlink(path).catch(() => undefined);
      if (Date.now() > deadline) throw new Error("The Asteroids leaderboard is locked by another writer.");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await task();
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

export function createArenaFileStore(dir: string = process.env.SPACE_ASTEROIDS_BENCHMARK_DIR?.trim() || DEFAULT_ARENA_RESULTS_DIR): ArenaStore {
  const runsDir = join(dir, "runs");
  const boardPath = (mode: ArenaMode) => join(dir, `leaderboard-${mode}.json`);
  const ensure = async () => {
    await mkdir(runsDir, { recursive: true, mode: 0o775 });
  };
  const validBoard = (board: Leaderboard | null, mode: ArenaMode) =>
    board && board.schemaVersion === 2 && board.mode === mode && Array.isArray(board.entries) ? board : null;
  return {
    dir,
    async loadLeaderboard(mode) {
      return validBoard(await readJson<Leaderboard>(boardPath(mode)), mode);
    },
    async updateLeaderboard(mode, update) {
      await ensure();
      return withLock(join(dir, `leaderboard-${mode}.lock`), async () => {
        const current = validBoard(await readJson<Leaderboard>(boardPath(mode)), mode) ?? emptyLeaderboard(mode);
        const next = update(current);
        await writeAtomic(boardPath(mode), JSON.stringify(next));
        return next;
      });
    },
    async resetLeaderboard(mode) {
      await ensure();
      await withLock(join(dir, `leaderboard-${mode}.lock`), async () => {
        await unlink(boardPath(mode)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      });
    },
    async saveRun(run) {
      await ensure();
      await writeAtomic(join(runsDir, `${run.id}.json`), JSON.stringify(run));
      const files = (await readdir(runsDir)).filter((name) => name.endsWith(".json")).sort();
      for (const name of files.slice(0, Math.max(0, files.length - MAX_RUN_FILES))) await unlink(join(runsDir, name)).catch(() => undefined);
    },
    async loadRun(id) {
      if (!isArenaRunId(id)) return null;
      const run = await readJson<RunRecord>(join(runsDir, `${id}.json`));
      return run && run.schemaVersion === 2 ? run : null;
    },
    async listRuns(mode, limit) {
      let names: string[] = [];
      try {
        names = (await readdir(runsDir)).filter((name) => name.endsWith(".json")).sort().reverse();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const summaries: RunSummary[] = [];
      for (const name of names) {
        if (summaries.length >= limit) break;
        const run = await readJson<RunRecord>(join(runsDir, name));
        if (!run || run.schemaVersion !== 2 || (mode && run.mode !== mode)) continue;
        summaries.push(runSummary(run));
      }
      return summaries;
    }
  };
}
