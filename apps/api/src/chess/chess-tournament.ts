import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  START_FEN,
  findMoveInText,
  gameOutcome,
  legalMoves,
  makeMove,
  materialBalance,
  moveToSan,
  moveToUci,
  parseFen,
  positionKey,
  toFen,
  type ChessColor,
  type ChessEndReason,
  type ChessMove,
  type ChessPosition,
  type ChessResult,
} from "./chess-rules.js";
import {
  CLI_CONCURRENCY_LIMIT,
  CLI_SLOT_GROUP,
  PROVIDER_REQUEST_LIMITS,
  isCliProvider,
  type ChessContestant,
  type ChessMoveRequester,
} from "./chess-players.js";

/**
 * Server-side chess tournament for the Benchmark page. One tournament exists
 * at a time; it keeps running when the page is closed and its state survives
 * API restarts (a restart marks it interrupted, Resume continues it).
 *
 * High speed comes from parallel games, a time limit per move, a ply cap with
 * material adjudication and strikes: a timeout, provider error or a second
 * illegal answer plays a random legal move for that side and counts a strike;
 * the third strike forfeits the game.
 */

export type ChessFormat = "swiss" | "round_robin";
export type ChessTournamentStatus = "running" | "stopped" | "interrupted" | "completed";
export type ChessGameEndReason = ChessEndReason | "adjudication" | "forfeit" | "bye";

export interface ChessTournamentSettings {
  format: ChessFormat;
  rounds: number;
  moveTimeoutMs: number;
  maxPlies: number;
  concurrency: number;
}

export interface ChessStanding {
  id: string;
  seed: number;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  games: number;
  elo: number;
  buchholz: number;
  whiteGames: number;
  blackGames: number;
  modelMoves: number;
  illegalReplies: number;
  fallbackMoves: number;
  forfeits: number;
  totalLatencyMs: number;
  tokens: number;
  opponents: string[];
}

export interface ChessGame {
  id: string;
  round: number;
  white: string;
  /** null for a bye. */
  black: string | null;
  status: "pending" | "running" | "finished";
  result: ChessResult | null;
  reason: ChessGameEndReason | null;
  fen: string;
  san: string[];
  uci: string[];
  thinking: ChessColor | null;
  /** The side to move is waiting for a free provider slot; its clock has not started. */
  queued: boolean;
  strikes: { w: number; b: number };
  lastNote: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Per-side move statistics of an unfinished game; committed to the standings when it ends. */
  stats?: { w: SideStats; b: SideStats };
}

export interface ChessTournamentState {
  version: 1;
  id: string;
  status: ChessTournamentStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  settings: ChessTournamentSettings;
  contestants: ChessContestant[];
  standings: Record<string, ChessStanding>;
  /** Rounds paired so far. */
  round: number;
  totalRounds: number;
  games: ChessGame[];
  error: string | null;
}

export interface ChessStandingView extends Omit<ChessStanding, "opponents"> {
  rank: number;
  contestant: ChessContestant;
}

export interface ChessGameSummary extends Omit<ChessGame, "san" | "uci"> {
  plies: number;
  recentSan: string[];
  lastUci: string | null;
}

export interface ChessTournamentSnapshot {
  id: string;
  status: ChessTournamentStatus;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  settings: ChessTournamentSettings;
  error: string | null;
  round: number;
  totalRounds: number;
  totals: { games: number; finished: number; running: number; pending: number; plies: number };
  standings: ChessStandingView[];
  liveGames: ChessGameSummary[];
  recentGames: ChessGameSummary[];
}

export interface ChessTournamentDeps {
  requestMove: ChessMoveRequester;
  stateFile: string;
  /** Requests in flight per provider; games beyond it wait for a slot before their move clock starts. */
  providerLimits?: Partial<Record<string, number>>;
  now?: () => number;
  log?: (event: string, details: Record<string, unknown>) => void;
}

export class ChessTournamentConflictError extends Error {}

export const MAX_STRIKES = 3;
export const ADJUDICATION_MARGIN = 3;
const ELO_START = 1500;
const ELO_K = 24;
const RECENT_GAMES = 30;
const LIVE_SAN = 24;
const PAIRING_BUDGET = 50_000;
const PROGRESS_SAVE_MS = 10_000;
const AUTO_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
const FALLBACK_PROVIDER_LIMIT = 2;
const PROVIDER_RETRY_DELAY_MS = 750;

export const CHESS_SYSTEM_PROMPT =
  "You are a strong chess engine playing a fast tournament game. Pick the best legal move for the side to move. " +
  'Answer with strict JSON only, no markdown and no explanation: {"move":"<uci>"}. ' +
  "Copy the move exactly from the legal move list (UCI notation, for example e2e4, e1g1 or e7e8q).";

export function defaultSwissRounds(players: number): number {
  if (players < 2) return 1;
  return Math.max(1, Math.min(players - 1, Math.ceil(Math.log2(players)) + 1));
}

export function roundRobinSchedule(ids: string[]): Array<Array<[string, string]>> {
  const ring: Array<string | null> = ids.length % 2 === 1 ? [...ids, null] : [...ids];
  const size = ring.length;
  const rounds: Array<Array<[string, string]>> = [];
  let order = ring.slice();
  for (let round = 0; round < size - 1; round += 1) {
    const pairs: Array<[string, string]> = [];
    for (let index = 0; index < size / 2; index += 1) {
      const left = order[index];
      const right = order[size - 1 - index];
      if (!left || !right) continue;
      pairs.push((index + round) % 2 === 0 ? [left, right] : [right, left]);
    }
    rounds.push(pairs);
    order = [order[0]!, order[size - 1]!, ...order.slice(1, size - 1)];
  }
  return rounds;
}

function pairKey(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

export function compareStandings(left: ChessStanding, right: ChessStanding): number {
  return (
    right.points - left.points ||
    right.buchholz - left.buchholz ||
    right.wins - left.wins ||
    right.elo - left.elo ||
    left.fallbackMoves - right.fallbackMoves ||
    left.seed - right.seed
  );
}

/**
 * Swiss pairing: players ranked by points and rating, each paired with the
 * nearest-ranked opponent they have not met (backtracking when needed). An
 * odd field gives a one-point bye to the lowest-ranked player without one.
 */
export function swissPairings(
  standings: ChessStanding[],
  played: Set<string>,
  round: number,
  /** Order among equal scores; a per-tournament shuffle keeps one provider's models from meeting each other. */
  tiebreak: (id: string) => number = () => 0
): { pairs: Array<[string, string]>; bye: string | null } {
  const ranked = [...standings].sort(
    (left, right) =>
      right.points - left.points || right.elo - left.elo || tiebreak(left.id) - tiebreak(right.id) || left.seed - right.seed
  );
  const byId = new Map(ranked.map((standing) => [standing.id, standing]));
  let pool = ranked.map((standing) => standing.id);
  let bye: string | null = null;
  if (pool.length % 2 === 1) {
    bye = [...pool].reverse().find((id) => byId.get(id)!.byes === 0) ?? pool[pool.length - 1]!;
    pool = pool.filter((id) => id !== bye);
  }

  let budget = PAIRING_BUDGET;
  const solve = (list: string[]): Array<[string, string]> | null => {
    if (list.length === 0) return [];
    const [first, ...rest] = list;
    for (let index = 0; index < rest.length; index += 1) {
      if (--budget < 0) return null;
      const second = rest[index]!;
      if (played.has(pairKey(first!, second))) continue;
      const tail = solve(rest.filter((_, other) => other !== index));
      if (tail) return [[first!, second], ...tail];
    }
    return null;
  };
  let pairs = solve(pool);
  if (!pairs) {
    pairs = [];
    for (let index = 0; index + 1 < pool.length; index += 2) pairs.push([pool[index]!, pool[index + 1]!]);
  }

  return {
    bye,
    pairs: pairs.map(([higher, lower]) => {
      const balance = (id: string) => byId.get(id)!.whiteGames - byId.get(id)!.blackGames;
      const higherBalance = balance(higher);
      const lowerBalance = balance(lower);
      if (higherBalance < lowerBalance) return [higher, lower];
      if (higherBalance > lowerBalance) return [lower, higher];
      return round % 2 === 1 ? [higher, lower] : [lower, higher];
    }),
  };
}

export function eloAfter(rating: number, opponent: number, score: number): number {
  const expected = 1 / (1 + 10 ** ((opponent - rating) / 400));
  return rating + ELO_K * (score - expected);
}

export function stableHash(text: string): number {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

/**
 * The next game for a free worker: the one whose providers are least busy, so every provider
 * plays at once instead of one provider's games waiting in line for its few slots.
 */
export function pickGameIndex<T>(games: T[], load: (game: T) => number, scanLimit = 400): number {
  let best = 0;
  let bestLoad = Number.POSITIVE_INFINITY;
  for (let index = 0; index < Math.min(games.length, scanLimit); index += 1) {
    const value = load(games[index]!);
    if (value < bestLoad) {
      best = index;
      bestLoad = value;
      if (value <= 0) break;
    }
  }
  return best;
}

function seededRandom(seedText: string): () => number {
  let state = stableHash(seedText);
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

function recentMoveText(san: string[]): string {
  if (san.length === 0) return "(none)";
  const start = Math.max(0, san.length - LIVE_SAN);
  const parts: string[] = [];
  for (let index = start; index < san.length; index += 1) {
    const number = Math.floor(index / 2) + 1;
    if (index % 2 === 0) parts.push(`${number}. ${san[index]}`);
    else parts.push(index === start ? `${number}... ${san[index]}` : san[index]!);
  }
  return parts.join(" ");
}

export function buildMovePrompt(
  position: ChessPosition,
  legal: ChessMove[],
  san: string[],
  previousAnswer: string | null
): string {
  const lines = [
    `You play ${position.turn === "w" ? "White" : "Black"}.`,
    `Position (FEN): ${toFen(position)}`,
    `Moves so far (SAN): ${recentMoveText(san)}`,
    `Legal moves (UCI): ${legal.map(moveToUci).join(" ")}`,
  ];
  if (previousAnswer !== null) {
    const shown = previousAnswer.replace(/[^\x20-\x7E]/g, " ").replace(/"/g, "'").trim().slice(0, 60) || "(empty)";
    lines.push(`Your previous answer "${shown}" was not a legal move. Choose exactly one move from the legal list.`);
  }
  lines.push('Answer: {"move":"<uci>"}');
  return lines.join("\n");
}

function emptyStanding(id: string, seed: number): ChessStanding {
  return {
    id,
    seed,
    points: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    byes: 0,
    games: 0,
    elo: ELO_START,
    buchholz: 0,
    whiteGames: 0,
    blackGames: 0,
    modelMoves: 0,
    illegalReplies: 0,
    fallbackMoves: 0,
    forfeits: 0,
    totalLatencyMs: 0,
    tokens: 0,
    opponents: [],
  };
}

function newGame(id: string, round: number, white: string, black: string | null): ChessGame {
  return {
    id,
    round,
    white,
    black,
    status: "pending",
    result: null,
    reason: null,
    fen: START_FEN,
    san: [],
    uci: [],
    thinking: null,
    queued: false,
    strikes: { w: 0, b: 0 },
    lastNote: null,
    startedAt: null,
    finishedAt: null,
  };
}

function resetGame(game: ChessGame): void {
  delete game.stats;
  Object.assign(game, newGame(game.id, game.round, game.white, game.black));
}

/** An unfinished game waits for the next run with its moves, strikes and statistics kept. */
function pauseGame(game: ChessGame): void {
  game.status = "pending";
  game.thinking = null;
  game.queued = false;
}

/** Rebuilds a paused game's position from its moves; null when they no longer replay. */
function replayGame(game: ChessGame): { position: ChessPosition; seen: Map<string, number> } | null {
  let position = parseFen(START_FEN);
  const seen = new Map<string, number>([[positionKey(position), 1]]);
  for (const uci of game.uci) {
    const move = legalMoves(position).find((candidate) => moveToUci(candidate) === uci);
    if (!move) return null;
    position = makeMove(position, move);
    const key = positionKey(position);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return game.san.length === game.uci.length ? { position, seen } : null;
}

export interface SideStats {
  modelMoves: number;
  illegalReplies: number;
  fallbackMoves: number;
  totalLatencyMs: number;
  tokens: number;
}

const emptySideStats = (): SideStats => ({ modelMoves: 0, illegalReplies: 0, fallbackMoves: 0, totalLatencyMs: 0, tokens: 0 });

function abortError(): DOMException {
  return new DOMException("Stopped", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** First-come slots for one provider; release hands the slot to the next waiter. */
export class ProviderSlots {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw abortError();
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        };
        this.waiters.push(waiter);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    };
  }
}

export class ChessTournamentRunner {
  private state: ChessTournamentState | null = null;
  private loaded = false;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private lastProgressSave = 0;
  private readonly now: () => number;
  private readonly slots = new Map<string, ProviderSlots>();
  private readonly runningGames = new Map<string, number>();

  constructor(private readonly deps: ChessTournamentDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  get active(): boolean {
    return this.loop !== null;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  async load(): Promise<ChessTournamentState | null> {
    if (this.loaded) return this.state;
    this.loaded = true;
    try {
      const state = JSON.parse(await readFile(this.deps.stateFile, "utf8")) as ChessTournamentState;
      if (state?.version !== 1 || !Array.isArray(state.games) || !state.standings || !Array.isArray(state.contestants)) return null;
      if (state.status === "running") state.status = "interrupted";
      for (const game of state.games) if (game.status === "running") pauseGame(game);
      this.state = state;
    } catch {
      this.state = null;
    }
    return this.state;
  }

  async snapshot(): Promise<ChessTournamentSnapshot | null> {
    const state = await this.load();
    if (!state) return null;
    const contestants = new Map(state.contestants.map((contestant) => [contestant.id, contestant]));
    const summary = (game: ChessGame): ChessGameSummary => {
      const { san, uci, stats: _stats, ...rest } = game;
      return { ...rest, plies: san.length, recentSan: san.slice(-LIVE_SAN), lastUci: uci[uci.length - 1] ?? null };
    };
    const finished = state.games.filter((game) => game.status === "finished");
    const running = state.games.filter((game) => game.status === "running");
    const unfinishedRounds = state.games.filter((game) => game.status !== "finished").map((game) => game.round);
    return {
      id: state.id,
      status: state.status,
      active: this.active,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
      settings: state.settings,
      error: state.error,
      round: unfinishedRounds.length > 0 ? Math.min(...unfinishedRounds) : state.round,
      totalRounds: state.totalRounds,
      totals: {
        games: state.games.filter((game) => game.black !== null).length,
        finished: finished.filter((game) => game.black !== null).length,
        running: running.length,
        pending: state.games.filter((game) => game.status === "pending").length,
        plies: state.games.reduce((sum, game) => sum + game.san.length, 0),
      },
      standings: Object.values(state.standings)
        .sort(compareStandings)
        .flatMap((standing, index) => {
          const contestant = contestants.get(standing.id);
          if (!contestant) return [];
          const { opponents: _opponents, ...rest } = standing;
          return [{ ...rest, rank: index + 1, contestant }];
        }),
      liveGames: running.map(summary),
      recentGames: finished
        .filter((game) => game.black !== null)
        .sort((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))
        .slice(0, RECENT_GAMES)
        .map(summary),
    };
  }

  async game(id: string): Promise<ChessGame | null> {
    const state = await this.load();
    return state?.games.find((game) => game.id === id) ?? null;
  }

  async start(settings: ChessTournamentSettings, contestants: ChessContestant[]): Promise<void> {
    await this.load();
    if (this.active) throw new ChessTournamentConflictError("A chess tournament is already running.");
    if (contestants.length < 2) throw new ChessTournamentConflictError("At least two contestants are required.");
    const createdAt = this.iso();
    const ids = contestants.map((contestant) => contestant.id);
    const state: ChessTournamentState = {
      version: 1,
      id: `chess-${this.now().toString(36)}`,
      status: "running",
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      settings,
      contestants,
      standings: Object.fromEntries(ids.map((id, seed) => [id, emptyStanding(id, seed)])),
      round: 0,
      totalRounds: settings.format === "round_robin" ? roundRobinSchedule(ids).length : settings.rounds,
      games: [],
      error: null,
    };
    if (settings.format === "round_robin") {
      roundRobinSchedule(ids).forEach((pairs, roundIndex) => {
        pairs.forEach(([white, black], index) => {
          state.games.push(newGame(`r${roundIndex + 1}-g${index + 1}`, roundIndex + 1, white, black));
        });
      });
      state.round = state.totalRounds;
    }
    this.state = state;
    await this.persist();
    this.launch();
  }

  async resume(): Promise<void> {
    const state = await this.load();
    if (this.active) throw new ChessTournamentConflictError("A chess tournament is already running.");
    if (!state || state.status === "completed") throw new ChessTournamentConflictError("There is no tournament to resume.");
    state.status = "running";
    state.error = null;
    await this.persist();
    this.launch();
  }

  async stop(status: "stopped" | "interrupted" = "stopped"): Promise<void> {
    const loop = this.loop;
    if (!loop) return;
    this.controller?.abort();
    await loop;
    if (this.state && this.state.status === "running") {
      this.state.status = status;
      await this.persist();
    }
  }

  async reset(): Promise<void> {
    await this.load();
    if (this.active) throw new ChessTournamentConflictError("Stop the tournament before resetting it.");
    this.state = null;
    await this.saving;
    await unlink(this.deps.stateFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  /** Test seam: resolves when the current run has ended. */
  async idle(): Promise<void> {
    await this.loop;
  }

  private launch(): void {
    const controller = new AbortController();
    this.controller = controller;
    this.loop = this.run(controller.signal).finally(() => {
      this.loop = null;
      this.controller = null;
    });
  }

  /** Saves running games' progress at most every PROGRESS_SAVE_MS, so a restart loses little. */
  private persistSoon(): void {
    this.touch();
    if (this.now() - this.lastProgressSave < PROGRESS_SAVE_MS) return;
    this.lastProgressSave = this.now();
    void this.persist();
  }

  /**
   * Continues a tournament an API restart interrupted (deploys restart the API often). A tournament
   * someone stopped stays stopped, and one idle for a day is left alone.
   */
  async resumeIfInterrupted(): Promise<boolean> {
    const state = await this.load();
    if (!state || state.status !== "interrupted" || this.active) return false;
    if (this.now() - Date.parse(state.updatedAt) > AUTO_RESUME_WINDOW_MS) return false;
    await this.resume();
    this.deps.log?.("chess_tournament_auto_resumed", { id: state.id });
    return true;
  }

  private touch(): void {
    if (this.state) this.state.updatedAt = this.iso();
  }

  private persist(): Promise<void> {
    const state = this.state;
    if (!state) return this.saving;
    this.touch();
    const body = JSON.stringify(state);
    const file = this.deps.stateFile;
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, body, "utf8");
        await rename(temporary, file);
      });
    return this.saving.catch((error) => {
      this.deps.log?.("chess_state_save_failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async run(signal: AbortSignal): Promise<void> {
    const state = this.state!;
    this.deps.log?.("chess_tournament_running", { id: state.id, format: state.settings.format, players: state.contestants.length });
    try {
      while (!signal.aborted) {
        const pending = state.games.filter((game) => game.status === "pending").sort((left, right) => left.round - right.round);
        if (pending.length === 0) {
          if (state.settings.format === "swiss" && state.round < state.totalRounds) {
            this.pairNextSwissRound(state);
            await this.persist();
            continue;
          }
          state.status = "completed";
          state.completedAt = this.iso();
          await this.persist();
          this.deps.log?.("chess_tournament_completed", { id: state.id, games: state.games.length });
          return;
        }
        await this.runPool(pending, signal);
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.status = "stopped";
      for (const game of state.games) if (game.status === "running") pauseGame(game);
      await this.persist();
      this.deps.log?.("chess_tournament_failed", { id: state.id, error: state.error });
    }
  }

  private pairNextSwissRound(state: ChessTournamentState): void {
    const round = state.round + 1;
    const played = new Set(
      state.games.filter((game) => game.black !== null).map((game) => pairKey(game.white, game.black!))
    );
    const { pairs, bye } = swissPairings(Object.values(state.standings), played, round, (id) => stableHash(`${state.id}:${id}`));
    pairs.forEach(([white, black], index) => state.games.push(newGame(`r${round}-g${index + 1}`, round, white, black)));
    if (bye) {
      const game = newGame(`r${round}-bye`, round, bye, null);
      game.status = "finished";
      game.result = "1-0";
      game.reason = "bye";
      game.finishedAt = this.iso();
      state.games.push(game);
      const standing = state.standings[bye]!;
      standing.points += 1;
      standing.byes += 1;
      this.recomputeBuchholz(state);
    }
    state.round = round;
  }

  private async runPool(games: ChessGame[], signal: AbortSignal): Promise<void> {
    const queue = [...games];
    const workers = Array.from({ length: Math.max(1, Math.min(this.state!.settings.concurrency, queue.length)) }, async () => {
      while (!signal.aborted && queue.length > 0) {
        const [game] = queue.splice(pickGameIndex(queue, (candidate) => this.gameLoad(candidate)), 1);
        const providers = this.gameProviders(game!);
        for (const provider of providers) this.runningGames.set(provider, (this.runningGames.get(provider) ?? 0) + 1);
        try {
          await this.playGame(game!, signal);
        } finally {
          for (const provider of providers) this.runningGames.set(provider, (this.runningGames.get(provider) ?? 1) - 1);
        }
      }
    });
    await Promise.all(workers);
  }

  private gameProviders(game: ChessGame): Set<string> {
    const providerOf = (id: string | null) => (id ? this.state!.contestants.find((contestant) => contestant.id === id)?.providerId : undefined);
    return new Set([providerOf(game.white), providerOf(game.black)].filter((provider): provider is string => Boolean(provider)));
  }

  /** How busy a game's busiest provider is: its running games over the moves it takes at once. */
  private gameLoad(game: ChessGame): number {
    let load = 0;
    for (const provider of this.gameProviders(game)) {
      const limit = this.deps.providerLimits?.[provider] ?? PROVIDER_REQUEST_LIMITS[provider] ?? FALLBACK_PROVIDER_LIMIT;
      load = Math.max(load, (this.runningGames.get(provider) ?? 0) / Math.max(1, limit));
    }
    return load;
  }

  private providerSlots(group: string): ProviderSlots {
    let slots = this.slots.get(group);
    if (!slots) {
      const configured = this.deps.providerLimits?.[group];
      const known = group === CLI_SLOT_GROUP ? CLI_CONCURRENCY_LIMIT : PROVIDER_REQUEST_LIMITS[group];
      slots = new ProviderSlots(Math.max(1, configured ?? known ?? FALLBACK_PROVIDER_LIMIT));
      this.slots.set(group, slots);
    }
    return slots;
  }

  /** Provider slot first, then the shared CLI slot: one fixed order, so waiters never deadlock. */
  private async acquireSlots(providerId: string, signal: AbortSignal): Promise<() => void> {
    const releaseProvider = await this.providerSlots(providerId).acquire(signal);
    if (!isCliProvider(providerId)) return releaseProvider;
    try {
      const releaseCli = await this.providerSlots(CLI_SLOT_GROUP).acquire(signal);
      return () => {
        releaseCli();
        releaseProvider();
      };
    } catch (error) {
      releaseProvider();
      throw error;
    }
  }

  private contestant(id: string): ChessContestant {
    const contestant = this.state!.contestants.find((candidate) => candidate.id === id);
    if (!contestant) throw new Error(`Unknown contestant ${id}.`);
    return contestant;
  }

  private async playGame(game: ChessGame, signal: AbortSignal): Promise<void> {
    const settings = this.state!.settings;
    const players = { w: this.contestant(game.white), b: this.contestant(game.black!) };
    const random = seededRandom(`${this.state!.id}:${game.id}:${game.uci.length}`);
    // A game paused by a restart or Stop continues from its last move.
    const resumed = game.uci.length > 0 ? replayGame(game) : null;
    if (!resumed) resetGame(game);
    const stats = (game.stats ??= { w: emptySideStats(), b: emptySideStats() });
    game.status = "running";
    game.startedAt ??= this.iso();
    let position = resumed?.position ?? parseFen(START_FEN);
    const seen = resumed?.seen ?? new Map<string, number>([[positionKey(position), 1]]);

    try {
      for (;;) {
        if (signal.aborted) throw abortError();
        const legal = legalMoves(position);
        const outcome = gameOutcome(position, seen.get(positionKey(position)) ?? 1, legal);
        if (outcome) return this.finishGame(game, outcome.result, outcome.reason, stats);
        if (game.uci.length >= settings.maxPlies) {
          const balance = materialBalance(position);
          const result: ChessResult =
            balance >= ADJUDICATION_MARGIN ? "1-0" : balance <= -ADJUDICATION_MARGIN ? "0-1" : "1/2-1/2";
          return this.finishGame(game, result, "adjudication", stats);
        }

        const side = position.turn;
        game.thinking = side;
        const choice = await this.chooseMove(players[side], position, legal, game, signal, random);
        const sideStats = stats[side];
        sideStats.illegalReplies += choice.illegal;
        sideStats.totalLatencyMs += choice.latencyMs;
        sideStats.tokens += choice.tokens;
        if (choice.fallback) {
          sideStats.fallbackMoves += 1;
          game.strikes[side] += 1;
          game.lastNote = `${side === "w" ? "White" : "Black"} ${choice.fallback}: random legal move (strike ${game.strikes[side]}/${MAX_STRIKES})`;
          if (game.strikes[side] >= MAX_STRIKES) {
            return this.finishGame(game, side === "w" ? "0-1" : "1-0", "forfeit", stats, side);
          }
        } else {
          sideStats.modelMoves += 1;
        }

        game.san.push(moveToSan(position, choice.move, legal));
        game.uci.push(moveToUci(choice.move));
        position = makeMove(position, choice.move);
        game.fen = toFen(position);
        const key = positionKey(position);
        seen.set(key, (seen.get(key) ?? 0) + 1);
        this.persistSoon();
      }
    } catch (error) {
      if (signal.aborted) {
        pauseGame(game);
        return;
      }
      throw error;
    }
  }

  private async chooseMove(
    contestant: ChessContestant,
    position: ChessPosition,
    legal: ChessMove[],
    game: ChessGame,
    outer: AbortSignal,
    random: () => number
  ): Promise<{ move: ChessMove; fallback: string | null; illegal: number; latencyMs: number; tokens: number }> {
    const settings = this.state!.settings;
    game.queued = true;
    let release: () => void;
    try {
      release = await this.acquireSlots(contestant.providerId, outer);
    } finally {
      game.queued = false;
    }
    // The move clock starts once the request can actually go out.
    const started = this.now();
    const deadline = started + settings.moveTimeoutMs;
    let illegal = 0;
    let providerRetries = 0;
    let tokens = 0;
    let previous: string | null = null;
    let failure = "gave no legal move";

    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const remaining = deadline - this.now();
        if (attempt > 0 && remaining < 1_000) break;
        const timeout = AbortSignal.timeout(Math.max(1, remaining));
        try {
          const reply = await this.deps.requestMove({
            contestant,
            system: CHESS_SYSTEM_PROMPT,
            prompt: buildMovePrompt(position, legal, game.san, previous),
            signal: AbortSignal.any([outer, timeout]),
          });
          tokens += reply.tokens ?? 0;
          const move = findMoveInText(position, reply.text, legal);
          if (move) return { move, fallback: null, illegal, latencyMs: this.now() - started, tokens };
          illegal += 1;
          previous = reply.text;
          failure = "gave no legal move";
          if (illegal > 1) break;
        } catch (error) {
          if (outer.aborted) throw error;
          if (timeout.aborted) {
            failure = "timed out";
            break;
          }
          // A busy pool (HTTP 429/503, reset connection) gets one quick retry before it costs a strike.
          failure = "provider error";
          if (providerRetries > 0 || deadline - this.now() < PROVIDER_RETRY_DELAY_MS + 1_000) break;
          providerRetries += 1;
          await sleep(PROVIDER_RETRY_DELAY_MS, outer);
        }
      }
    } finally {
      release();
    }
    const move = legal[Math.floor(random() * legal.length)]!;
    return { move, fallback: failure, illegal, latencyMs: this.now() - started, tokens };
  }

  private finishGame(
    game: ChessGame,
    result: ChessResult,
    reason: ChessGameEndReason,
    stats: { w: SideStats; b: SideStats },
    forfeitedBy?: ChessColor
  ): void {
    const state = this.state!;
    game.status = "finished";
    game.result = result;
    game.reason = reason;
    game.thinking = null;
    game.queued = false;
    game.finishedAt = this.iso();
    delete game.stats;

    const white = state.standings[game.white]!;
    const black = state.standings[game.black!]!;
    const whiteScore = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
    const whiteElo = white.elo;
    const blackElo = black.elo;
    const apply = (standing: ChessStanding, score: number, opponent: string, side: ChessColor, own: number, other: number) => {
      standing.points += score;
      standing.games += 1;
      if (score === 1) standing.wins += 1;
      else if (score === 0) standing.losses += 1;
      else standing.draws += 1;
      if (side === "w") standing.whiteGames += 1;
      else standing.blackGames += 1;
      standing.opponents.push(opponent);
      standing.elo = Math.round(eloAfter(own, other, score) * 10) / 10;
      const sideStats = stats[side];
      standing.modelMoves += sideStats.modelMoves;
      standing.illegalReplies += sideStats.illegalReplies;
      standing.fallbackMoves += sideStats.fallbackMoves;
      standing.totalLatencyMs += sideStats.totalLatencyMs;
      standing.tokens += sideStats.tokens;
      if (forfeitedBy === side) standing.forfeits += 1;
    };
    apply(white, whiteScore, black.id, "w", whiteElo, blackElo);
    apply(black, 1 - whiteScore, white.id, "b", blackElo, whiteElo);
    this.recomputeBuchholz(state);
    this.deps.log?.("chess_game_finished", { id: state.id, game: game.id, result, reason, plies: game.san.length });
    void this.persist();
  }

  private recomputeBuchholz(state: ChessTournamentState): void {
    for (const standing of Object.values(state.standings)) {
      standing.buchholz = standing.opponents.reduce((sum, id) => sum + (state.standings[id]?.points ?? 0), 0);
    }
  }
}
