import { randomBytes } from "node:crypto";
import {
  AgentArena,
  ARENA_PROTOCOL_VERSION,
  DECISION_INTERVAL_TICKS,
  FRAME_INTERVAL_TICKS,
  ROUND_SECONDS,
  ROUND_TICKS,
  TICK_HZ,
  generateScenario,
  hashSeed,
  type ArenaFrameState,
  type ArenaMode
} from "./sim.js";
import {
  applyCommand,
  buildCombinedPrompt,
  buildSensorSnapshot,
  buildSystemPrompt,
  buildUserPrompt,
  commandLabel,
  computeControls,
  createExecutorState,
  parsePilotCommand,
  scriptedBaselineCommand,
  type ExecutorState,
  type PilotCommand
} from "./protocol.js";
import {
  AGENT_CHAT_PROMPT_LIMIT,
  BASELINE_MODEL_ID,
  CLAUDE_ACCOUNT_AUTO,
  CLAUDE_ACCOUNT_PATTERN,
  ProviderFailure,
  providerForModel,
  providerNoticeKind,
  requestAgentReply,
  type AgentRequester,
  type ArenaProviderId
} from "./providers.js";
import {
  applyRoundToLeaderboard,
  emptyTally,
  percentile,
  type ArenaContestant,
  type ArenaStore,
  type DecisionOutcome,
  type DecisionRecord,
  type RoundRecord,
  type RoundResult,
  type RunRecord,
  type RunStatus
} from "./store.js";

export const MAX_ARENA_CONTESTANTS = 8;
export const MAX_ARENA_ROUNDS = 10;
const DECISIONS_PER_ROUND = Math.ceil(ROUND_TICKS / DECISION_INTERVAL_TICKS);
/** Real-time duel: a pilot may not ask again sooner than 0.5 s of game time after its last request. */
const REALTIME_MIN_INTERVAL_TICKS = 15;
/** Lockstep waits long for a slow (queued) provider; the real-time duel cannot wait at all. */
const DEFAULT_DECISION_TIMEOUT_MS = 60_000;
const REALTIME_DECISION_TIMEOUT_MS = 30_000;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 60_000;
const FRAME_BUFFER = 600;
const EVENT_BUFFER = 300;
const DEGRADED_ERROR_SHARE = 0.25;
export const PILOT_COLORS = ["#4dd8ff", "#ff9d3d", "#7cf29a", "#c58bff", "#ff5c7a", "#ffe066", "#5c9dff", "#ff8ad8"];
export const BASELINE_COLOR = "#9aa4b2";

export class ArenaRunError extends Error {
  constructor(readonly code: "RUN_ACTIVE" | "INVALID_RUN", message: string) {
    super(message);
  }
}

export interface ArenaContestantInput {
  id: string;
  displayName?: string;
}

export interface StartArenaRunInput {
  mode: ArenaMode;
  contestants: ArenaContestantInput[];
  rounds: number;
  claudeAccount?: string;
  origin?: RunRecord["origin"];
  /** Lockstep modes wait for wall-clock time so viewers see the windows in real time. */
  pace?: boolean;
  seed?: number;
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

export interface LivePilot {
  id: string;
  slot: number;
  displayName: string;
  providerId: ArenaProviderId;
  color: string;
  reference: boolean;
  status: "ready" | "thinking" | "flying" | "destroyed";
  hull: number;
  shield: number;
  bombs: number;
  roundScore: number;
  runScore: number;
  roundWins: number;
  decisions: { total: number; ok: number; invalid: number; timeout: number; error: number };
  avgLatencyMs: number | null;
  last: { outcome: DecisionOutcome; command: string; note?: string; reason?: string; latencyMs: number; t: number } | null;
}

export interface LiveRunState {
  id: string;
  mode: ArenaMode;
  origin: RunRecord["origin"];
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
  skipped: RunRecord["skipped"];
  roundWinners: Array<{ round: number; winnerId: string; bestModelId: string | null; scores: Record<string, number> }>;
  championId: string | null;
}

export interface LiveResponse {
  run: LiveRunState | null;
  frames: LiveFrame[];
  events: LiveEvent[];
  latestSeq: number;
}

interface PilotRuntime {
  contestant: ArenaContestant;
  arena: AgentArena;
  slot: number;
  exec: ExecutorState;
  decisions: DecisionRecord[];
  last: { command: string; result: string } | null;
  inflight: AbortController | null;
  nextRequestTick: number;
  lastBaselineTick: number;
  runScore: number;
  roundWins: number;
  totals: { total: number; ok: number; invalid: number; timeout: number; error: number };
  latencyTotal: number;
  latencyCount: number;
  lastLive: LivePilot["last"];
}

export interface ArenaRunnerDeps {
  store: ArenaStore;
  requester?: AgentRequester;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  decisionTimeoutMs?: number;
  preflightTimeoutMs?: number;
  /** Real-time duel tick driver; tests replace it with an immediate loop. */
  realtimeTickMs?: number;
  /** Signed-in Claude account with the most quota left (null = main), for the "auto" account setting. */
  claudeProfile?: () => Promise<string | null>;
  log?: (line: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

function runId(mode: ArenaMode, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const slug = mode === "shared_arena" ? "shared" : mode;
  return `arena-${stamp}-${slug}-${randomBytes(3).toString("hex")}`;
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export function isArenaModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}

export class ArenaBenchmarkRunner {
  private readonly store: ArenaStore;
  private readonly requester: AgentRequester;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly decisionTimeoutMs: number;
  private readonly preflightTimeoutMs: number;
  private readonly realtimeTickMs: number;
  private readonly log: (line: string) => void;
  private readonly claudeProfile: (() => Promise<string | null>) | null;
  private claudeChoice: { account: string; until: number } | null = null;
  private run: RunRecord | null = null;
  private live: LiveRunState | null = null;
  private pilots: PilotRuntime[] = [];
  private frames: LiveFrame[] = [];
  private events: LiveEvent[] = [];
  private seq = 0;
  private cancelled = false;
  private wake: (() => void) | null = null;
  private completion: Promise<RunRecord> | null = null;
  private activeTimeoutMs = DEFAULT_DECISION_TIMEOUT_MS;
  private pendingDecisions = new Set<Promise<void>>();

  constructor(deps: ArenaRunnerDeps) {
    this.store = deps.store;
    this.requester = deps.requester ?? requestAgentReply;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.decisionTimeoutMs = deps.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.preflightTimeoutMs = deps.preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
    this.realtimeTickMs = deps.realtimeTickMs ?? 1000 / TICK_HZ;
    this.log = deps.log ?? (() => undefined);
    this.claudeProfile = deps.claudeProfile ?? null;
  }

  get active(): boolean {
    return this.run?.status === "running";
  }

  /** Resolves with the final run record (used by the headless runner and tests). */
  get done(): Promise<RunRecord> | null {
    return this.completion;
  }

  start(input: StartArenaRunInput): LiveRunState {
    if (this.active) throw new ArenaRunError("RUN_ACTIVE", "An Asteroids benchmark run is already in progress.");
    const ids = [...new Set(input.contestants.map((contestant) => contestant.id))];
    if (ids.some((id) => !isArenaModelId(id))) throw new ArenaRunError("INVALID_RUN", "Contestant ids are invalid.");
    if (ids.length < 2) throw new ArenaRunError("INVALID_RUN", "Choose at least two contestants.");
    if (ids.length > MAX_ARENA_CONTESTANTS) throw new ArenaRunError("INVALID_RUN", `Choose at most ${MAX_ARENA_CONTESTANTS} contestants.`);
    if (!ids.some((id) => id !== BASELINE_MODEL_ID)) throw new ArenaRunError("INVALID_RUN", "Choose at least one AI model.");
    if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > MAX_ARENA_ROUNDS) {
      throw new ArenaRunError("INVALID_RUN", `Rounds must be between 1 and ${MAX_ARENA_ROUNDS}.`);
    }
    const claudeAccount = input.claudeAccount ?? (this.claudeProfile ? CLAUDE_ACCOUNT_AUTO : "main");
    if (!CLAUDE_ACCOUNT_PATTERN.test(claudeAccount)) throw new ArenaRunError("INVALID_RUN", "The Claude account id is invalid.");
    const names = new Map(input.contestants.map((contestant) => [contestant.id, contestant.displayName?.trim().slice(0, 80)]));
    let colorIndex = 0;
    const contestants: ArenaContestant[] = ids.map((id, slot) => {
      const reference = id === BASELINE_MODEL_ID;
      const color = reference ? BASELINE_COLOR : PILOT_COLORS[colorIndex++ % PILOT_COLORS.length]!;
      return { id, slot, color, reference, providerId: providerForModel(id), displayName: names.get(id) || (reference ? "Scripted Baseline" : id) };
    });
    const startedAt = this.now();
    const seed = Number.isInteger(input.seed) ? (input.seed as number) >>> 0 : hashSeed(`${startedAt}:${randomBytes(4).toString("hex")}`);
    const realtime = input.mode === "duel";
    this.activeTimeoutMs = realtime ? Math.min(this.decisionTimeoutMs, REALTIME_DECISION_TIMEOUT_MS) : this.decisionTimeoutMs;
    this.run = {
      schemaVersion: 2,
      protocol: ARENA_PROTOCOL_VERSION,
      id: runId(input.mode, startedAt),
      mode: input.mode,
      origin: input.origin ?? "ui",
      status: "running",
      startedAt: new Date(startedAt).toISOString(),
      config: {
        rounds: input.rounds,
        decisionIntervalS: DECISION_INTERVAL_TICKS / TICK_HZ,
        roundSeconds: ROUND_SECONDS,
        realtime,
        claudeAccount,
        seed,
        decisionTimeoutS: Math.round(this.activeTimeoutMs / 1000)
      },
      contestants,
      skipped: [],
      rounds: [],
      championId: null
    };
    this.cancelled = false;
    this.claudeChoice = null;
    this.frames = [];
    this.events = [];
    this.pilots = [];
    this.live = {
      id: this.run.id,
      mode: input.mode,
      origin: this.run.origin,
      status: "running",
      phase: "preflight",
      message: "Checking that every model answers…",
      round: 0,
      rounds: input.rounds,
      t: 0,
      tLeft: ROUND_SECONDS,
      decisionIndex: 0,
      decisionsPerRound: DECISIONS_PER_ROUND,
      realtime,
      startedAt: this.run.startedAt,
      pilots: contestants.map((contestant) => this.idleLivePilot(contestant)),
      skipped: [],
      roundWinners: [],
      championId: null
    };
    this.event(0, 0, "run", `Run ${this.run.id} started: ${contestants.length} contestants, ${input.rounds} round(s).`);
    const pace = input.pace ?? true;
    this.completion = this.execute(pace).catch(async (error: unknown) => {
      const run = this.run!;
      run.status = "failed";
      run.error = error instanceof Error ? error.message.slice(0, 300) : "The run failed.";
      run.completedAt = new Date(this.now()).toISOString();
      this.finishLive(`Run failed: ${run.error}`);
      await this.store.saveRun(run).catch(() => undefined);
      return run;
    });
    return this.liveState();
  }

  stop(): boolean {
    if (!this.active) return false;
    this.cancelled = true;
    for (const pilot of this.pilots) pilot.inflight?.abort();
    this.wake?.();
    return true;
  }

  liveSince(afterSeq: number): LiveResponse {
    const latestSeq = this.seq;
    let frames: LiveFrame[];
    const oldest = this.frames[0]?.seq ?? latestSeq + 1;
    if (afterSeq < 0 || afterSeq < oldest - 1) frames = this.frames.slice(-20);
    else frames = this.frames.filter((frame) => frame.seq > afterSeq).slice(0, 80);
    const events = afterSeq < 0 ? this.events.slice(-40) : this.events.filter((event) => event.seq > afterSeq).slice(-80);
    return { run: this.live ? this.liveState() : null, frames, events, latestSeq };
  }

  private liveState(): LiveRunState {
    const live = this.live!;
    return { ...live, pilots: live.pilots.map((pilot) => ({ ...pilot })), skipped: [...live.skipped], roundWinners: [...live.roundWinners] };
  }

  private idleLivePilot(contestant: ArenaContestant): LivePilot {
    return {
      id: contestant.id,
      slot: contestant.slot,
      displayName: contestant.displayName,
      providerId: contestant.providerId,
      color: contestant.color,
      reference: contestant.reference,
      status: "ready",
      hull: 5,
      shield: 2,
      bombs: 1,
      roundScore: 0,
      runScore: 0,
      roundWins: 0,
      decisions: emptyTally(),
      avgLatencyMs: null,
      last: null
    };
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private event(round: number, t: number, kind: LiveEvent["kind"], text: string, contestantId?: string): void {
    this.events.push({ seq: this.nextSeq(), round, t: Math.round(t * 10) / 10, kind, text, ...(contestantId ? { contestantId } : {}) });
    if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
    this.log(`[${this.run?.mode ?? "arena"}] r${round} t=${t.toFixed(1)} ${text}`);
  }

  private pushFrame(round: number, arenas: AgentArena[]): void {
    const tick = Math.max(...arenas.map((arena) => arena.tick));
    this.frames.push({ seq: this.nextSeq(), round, tick, arenas: arenas.map((arena) => arena.snapshot()) });
    if (this.frames.length > FRAME_BUFFER) this.frames.splice(0, this.frames.length - FRAME_BUFFER);
  }

  private finishLive(message: string): void {
    const run = this.run!;
    const live = this.live!;
    live.status = run.status;
    live.phase = "finished";
    live.message = message;
    live.championId = run.championId;
    if (run.completedAt) live.completedAt = run.completedAt;
    for (const pilot of live.pilots) if (pilot.status === "thinking") pilot.status = "ready";
    this.event(run.rounds.length, 0, "run", message);
  }

  private async execute(pace: boolean): Promise<RunRecord> {
    const run = this.run!;
    await this.preflight();
    const flying = run.contestants;
    if (this.cancelled) return this.complete("stopped", "Run stopped before the first round.");
    if (flying.length < 2 || !flying.some((contestant) => !contestant.reference)) {
      throw new Error(`Not enough contestants answered the preflight check (${run.skipped.map((entry) => `${entry.displayName}: ${entry.reason}`).join("; ")}).`);
    }
    for (let round = 1; round <= run.config.rounds; round += 1) {
      if (this.cancelled) break;
      const record = await this.playRound(round, pace);
      if (!record) break;
      run.rounds.push(record);
      await this.store.saveRun(run);
      await this.store.updateLeaderboard(run.mode, (board) => applyRoundToLeaderboard(board, run, record, new Date(this.now()).toISOString()));
      if (round < run.config.rounds && !this.cancelled && pace) {
        this.live!.phase = "intermission";
        this.live!.message = `Round ${round} complete. Next round starts in 4 s.`;
        await this.interruptibleSleep(4000);
      }
    }
    return this.cancelled ? this.complete("stopped", "Run stopped by the operator.") : this.complete("completed", "Run complete.");
  }

  private async complete(status: RunStatus, message: string): Promise<RunRecord> {
    const run = this.run!;
    run.status = status;
    run.completedAt = new Date(this.now()).toISOString();
    run.championId = this.runChampion();
    const champion = run.contestants.find((contestant) => contestant.id === run.championId);
    this.finishLive(champion ? `${message} Champion: ${champion.displayName}.` : message);
    await this.store.saveRun(run);
    return run;
  }

  /** Best average score among AI models over the rounds of this run. */
  private runChampion(): string | null {
    const run = this.run!;
    const totals = new Map<string, { score: number; rounds: number; wins: number }>();
    for (const round of run.rounds) {
      for (const result of round.results) {
        const contestant = run.contestants.find((entry) => entry.id === result.contestantId);
        if (!contestant || contestant.reference || result.degraded) continue;
        const entry = totals.get(result.contestantId) ?? { score: 0, rounds: 0, wins: 0 };
        entry.score += result.score;
        entry.rounds += 1;
        entry.wins += round.bestModelId === result.contestantId ? 1 : 0;
        totals.set(result.contestantId, entry);
      }
    }
    return [...totals.entries()].sort(([, left], [, right]) => right.score / right.rounds - left.score / left.rounds || right.wins - left.wins)[0]?.[0] ?? null;
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    if (ms <= 0 || this.cancelled) return;
    await Promise.race([this.sleep(ms), new Promise<void>((resolve) => { this.wake = resolve; })]);
    this.wake = null;
  }

  /** Every model must answer one real snapshot; provider failures are skipped, bad answers are not. */
  private async preflight(): Promise<void> {
    const run = this.run!;
    const live = this.live!;
    const models = run.contestants.filter((contestant) => !contestant.reference);
    const scenario = generateScenario(hashSeed(`preflight:${run.mode}`), run.mode);
    const results = await Promise.all(
      models.map(async (contestant) => {
        const arena = new AgentArena({ key: contestant.id, mode: run.mode, scenario, pilots: [contestant.id] });
        for (let tick = 0; tick < TICK_HZ * 2; tick += 1) arena.step([null]);
        const snapshot = buildSensorSnapshot(arena, 0, { decisionIndex: 0, decisionsTotal: DECISIONS_PER_ROUND });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.preflightTimeoutMs);
        try {
          const claudeAccount = await this.claudeAccountFor(contestant.id);
          const reply = await this.requester({
            modelId: contestant.id,
            system: buildSystemPrompt(run.mode),
            user: buildUserPrompt(snapshot),
            snapshot,
            signal: controller.signal,
            ...(claudeAccount ? { claudeAccount } : {})
          });
          const notice = providerNoticeKind(reply.text);
          if (notice) return { contestant, reason: `Provider unavailable: ${reply.text.replace(/\s+/g, " ").trim().slice(0, 140)}` };
          return { contestant, reason: null };
        } catch (error) {
          if (error instanceof ProviderFailure) {
            return { contestant, reason: error.kind === "timeout" ? `No answer within ${Math.round(this.preflightTimeoutMs / 1000)} s` : error.message.slice(0, 160) };
          }
          return { contestant, reason: (error as Error).message?.slice(0, 160) || "Provider failed." };
        } finally {
          clearTimeout(timer);
        }
      })
    );
    const skippedIds = new Set<string>();
    for (const result of results) {
      if (!result.reason) continue;
      skippedIds.add(result.contestant.id);
      run.skipped.push({ id: result.contestant.id, displayName: result.contestant.displayName, providerId: result.contestant.providerId, reason: result.reason });
      this.event(0, 0, "run", `${result.contestant.displayName} skipped: ${result.reason}`, result.contestant.id);
    }
    run.contestants = run.contestants.filter((contestant) => !skippedIds.has(contestant.id)).map((contestant, slot) => ({ ...contestant, slot }));
    live.skipped = [...run.skipped];
    live.pilots = run.contestants.map((contestant) => this.idleLivePilot(contestant));
  }

  private async playRound(round: number, pace: boolean): Promise<RoundRecord | null> {
    const run = this.run!;
    const live = this.live!;
    const seed = hashSeed(`${ARENA_PROTOCOL_VERSION}|${run.mode}|${run.config.seed}|${round}`);
    const scenario = generateScenario(seed, run.mode);
    const shared = run.mode === "shared_arena";
    const arenas: AgentArena[] = shared
      ? [new AgentArena({ key: "shared", mode: run.mode, scenario, pilots: run.contestants.map((contestant) => contestant.id) })]
      : run.contestants.map((contestant) => new AgentArena({ key: contestant.id, mode: run.mode, scenario, pilots: [contestant.id] }));
    const previous = new Map(this.pilots.map((pilot) => [pilot.contestant.id, pilot]));
    this.pilots = run.contestants.map((contestant, index) => {
      const earlier = previous.get(contestant.id);
      return {
        contestant,
        arena: shared ? arenas[0]! : arenas[index]!,
        slot: shared ? index : 0,
        exec: createExecutorState(),
        decisions: [],
        last: null,
        inflight: null,
        nextRequestTick: 0,
        lastBaselineTick: -DECISION_INTERVAL_TICKS,
        runScore: earlier?.runScore ?? 0,
        roundWins: earlier?.roundWins ?? 0,
        totals: earlier?.totals ?? emptyTally(),
        latencyTotal: earlier?.latencyTotal ?? 0,
        latencyCount: earlier?.latencyCount ?? 0,
        lastLive: null
      };
    });
    live.round = round;
    live.phase = "playing";
    live.decisionIndex = 0;
    live.message = `Round ${round}/${run.config.rounds} under way.`;
    this.event(round, 0, "round", `Round ${round} begins (seed ${seed}).`);
    this.pushFrame(round, arenas);
    this.refreshLive(arenas);
    const startedWall = this.now();
    if (run.config.realtime) await this.playRealtime(round, arenas);
    else await this.playLockstep(round, arenas, pace);
    for (const pilot of this.pilots) pilot.inflight?.abort();
    // Let aborted real-time requests settle so their outcome lands in this round's tally.
    await Promise.allSettled([...this.pendingDecisions]);
    if (this.cancelled && arenas.some((arena) => !arena.over)) return null;
    const record = this.finalizeRound(round, seed, arenas, (this.now() - startedWall) / 1000);
    this.refreshLive(arenas);
    return record;
  }

  private names(): Record<number, string> {
    return Object.fromEntries(this.pilots.map((pilot) => [pilot.slot, pilot.contestant.displayName]));
  }

  private async playLockstep(round: number, arenas: AgentArena[], pace: boolean): Promise<void> {
    const live = this.live!;
    const windowMs = (DECISION_INTERVAL_TICKS / TICK_HZ) * 1000;
    let windowStarted = this.now() - windowMs;
    let decisionIndex = 0;
    while (!this.cancelled && arenas.some((arena) => !arena.over)) {
      live.decisionIndex = decisionIndex;
      const active = this.pilots.filter((pilot) => !pilot.arena.over && pilot.arena.ships[pilot.slot]?.alive);
      const windowAsked = this.now();
      await Promise.all(active.map((pilot) => this.decide(pilot, decisionIndex, round)));
      if (this.cancelled) return;
      this.log(
        `[${this.run!.mode}] r${round} decision ${decisionIndex + 1} answered in ${((this.now() - windowAsked) / 1000).toFixed(1)} s: ` +
          active.map((pilot) => `${pilot.contestant.displayName}=${pilot.lastLive?.outcome === "ok" ? pilot.lastLive.command : pilot.lastLive?.outcome ?? "-"}(${pilot.arena.ships[pilot.slot]?.stats.score ?? 0})`).join(", ")
      );
      if (pace) await this.interruptibleSleep(windowStarted + windowMs - this.now());
      windowStarted = this.now();
      for (let step = 0; step < DECISION_INTERVAL_TICKS; step += 1) {
        this.stepArenas(arenas);
        if ((decisionIndex * DECISION_INTERVAL_TICKS + step + 1) % FRAME_INTERVAL_TICKS === 0) this.pushFrame(round, arenas);
        if (arenas.every((arena) => arena.over)) {
          this.pushFrame(round, arenas);
          break;
        }
      }
      this.refreshLive(arenas);
      decisionIndex += 1;
    }
  }

  private async playRealtime(round: number, arenas: AgentArena[]): Promise<void> {
    const started = this.now();
    let processed = 0;
    while (!this.cancelled && arenas.some((arena) => !arena.over)) {
      const due = Math.min(ROUND_TICKS, Math.floor((this.now() - started) / this.realtimeTickMs) + 1);
      let budget = 10;
      while (processed < due && budget > 0 && arenas.some((arena) => !arena.over)) {
        const tick = processed;
        for (const pilot of this.pilots) {
          if (pilot.arena.over || !pilot.arena.ships[pilot.slot]?.alive) continue;
          if (pilot.contestant.reference) {
            if (tick - pilot.lastBaselineTick >= DECISION_INTERVAL_TICKS) {
              pilot.lastBaselineTick = tick;
              this.track(this.decide(pilot, pilot.decisions.length, round));
            }
          } else if (!pilot.inflight && tick >= pilot.nextRequestTick) {
            pilot.nextRequestTick = tick + REALTIME_MIN_INTERVAL_TICKS;
            this.track(this.decide(pilot, pilot.decisions.length, round));
          }
        }
        this.stepArenas(arenas);
        processed += 1;
        budget -= 1;
        if (processed % FRAME_INTERVAL_TICKS === 0) {
          this.pushFrame(round, arenas);
          this.refreshLive(arenas);
        }
      }
      this.live!.decisionIndex = Math.floor(processed / DECISION_INTERVAL_TICKS);
      if (arenas.some((arena) => !arena.over)) await this.interruptibleSleep(this.realtimeTickMs);
    }
    this.pushFrame(round, arenas);
  }

  private track(decision: Promise<void>): void {
    this.pendingDecisions.add(decision);
    void decision.finally(() => this.pendingDecisions.delete(decision));
  }

  private stepArenas(arenas: AgentArena[]): void {
    for (const arena of arenas) {
      if (arena.over) continue;
      const controls = arena.ships.map((ship) => {
        const pilot = this.pilots.find((entry) => entry.arena === arena && entry.slot === ship.slot);
        return pilot ? computeControls(arena, ship.slot, pilot.exec) : null;
      });
      arena.step(controls);
    }
  }

  private record(pilot: PilotRuntime, decision: DecisionRecord, round: number): void {
    pilot.decisions.push(decision);
    pilot.totals.total += 1;
    pilot.totals[decision.outcome] += 1;
    if (!pilot.contestant.reference && (decision.outcome === "ok" || decision.outcome === "invalid")) {
      pilot.latencyTotal += decision.latencyMs;
      pilot.latencyCount += 1;
    }
    pilot.lastLive = {
      outcome: decision.outcome,
      command: decision.command,
      latencyMs: decision.latencyMs,
      t: decision.t,
      ...(decision.note ? { note: decision.note } : {}),
      ...(decision.reason ? { reason: decision.reason } : {})
    };
    pilot.last = { command: decision.command, result: decision.outcome === "ok" ? "accepted" : `${decision.outcome}: ${decision.reason ?? ""}`.trim() };
    if (decision.outcome !== "ok" && !pilot.contestant.reference) {
      this.event(round, decision.t, "decision", `${pilot.contestant.displayName}: ${decision.outcome}${decision.reason ? ` (${decision.reason})` : ""}`, pilot.contestant.id);
    }
  }

  private async decide(pilot: PilotRuntime, decisionIndex: number, round: number): Promise<void> {
    const run = this.run!;
    const snapshot = buildSensorSnapshot(pilot.arena, pilot.slot, {
      decisionIndex,
      decisionsTotal: DECISIONS_PER_ROUND,
      pilotNames: this.names(),
      last: pilot.last
    });
    const t = snapshot.t;
    if (pilot.contestant.reference) {
      const command = scriptedBaselineCommand(snapshot);
      applyCommand(pilot.exec, command);
      this.record(pilot, { k: decisionIndex, t, outcome: "ok", latencyMs: 0, command: commandLabel(command), note: command.note }, round);
      return;
    }
    const controller = new AbortController();
    pilot.inflight = controller;
    this.setPilotStatus(pilot, "thinking");
    const timer = setTimeout(() => controller.abort(), this.activeTimeoutMs);
    const started = this.now();
    let decision: DecisionRecord;
    let command: PilotCommand | null = null;
    const realtime = run.config.realtime;
    try {
      const system = buildSystemPrompt(run.mode);
      let user = buildUserPrompt(snapshot);
      if (buildCombinedPrompt(run.mode, snapshot).length > AGENT_CHAT_PROMPT_LIMIT) {
        user = buildUserPrompt({ ...snapshot, contacts: snapshot.contacts.slice(0, 6), events: snapshot.events.slice(-3) });
      }
      const claudeAccount = await this.claudeAccountFor(pilot.contestant.id);
      const reply = await this.requester({ modelId: pilot.contestant.id, system, user, snapshot, signal: controller.signal, ...(claudeAccount ? { claudeAccount } : {}) });
      const latencyMs = this.now() - started;
      const notice = providerNoticeKind(reply.text);
      const tokens = typeof reply.tokens === "number" ? { tokens: reply.tokens } : {};
      if (notice) {
        decision = { k: decisionIndex, t, outcome: "error", latencyMs, command: "coast", reason: reply.text.replace(/\s+/g, " ").trim().slice(0, 120), ...tokens };
      } else {
        const parsed = parsePilotCommand(reply.text);
        if (parsed.ok) {
          command = parsed.command;
          decision = { k: decisionIndex, t, outcome: "ok", latencyMs, command: commandLabel(command), ...(command.note ? { note: command.note } : {}), ...tokens };
        } else {
          decision = {
            k: decisionIndex,
            t,
            outcome: "invalid",
            latencyMs,
            command: "coast",
            reason: parsed.reason,
            reply: reply.text.replace(/\s+/g, " ").trim().slice(0, 160),
            ...tokens
          };
        }
      }
    } catch (error) {
      const latencyMs = this.now() - started;
      const failure = error instanceof ProviderFailure ? error : new ProviderFailure("error", (error as Error)?.message ?? "Provider failed.");
      const outcome: DecisionOutcome = failure.kind === "timeout" ? "timeout" : "error";
      decision = { k: decisionIndex, t, outcome, latencyMs, command: realtime ? commandLabel(pilot.exec.command) : "coast", reason: failure.message.slice(0, 140) };
    } finally {
      clearTimeout(timer);
      if (pilot.inflight === controller) pilot.inflight = null;
    }
    const destroyed = !pilot.arena.ships[pilot.slot]?.alive;
    if (destroyed && !this.cancelled && pilot.decisions.length === 0) {
      // Real time only: the ship died before the model's first answer, so no command ever flew.
      // Later answers cut off by the destruction are dropped, like answers cut off by the round end.
      this.record(pilot, { ...decision, outcome: "timeout", command: "coast", reason: `No usable answer before the ship was destroyed (${((this.now() - started) / 1000).toFixed(1)} s)` }, round);
      return;
    }
    // A cancelled round (stop or round time up) never counts as a model failure.
    if (controller.signal.aborted && (this.cancelled || pilot.arena.over)) return;
    if (pilot.arena.over) return;
    if (decision.outcome === "ok") applyCommand(pilot.exec, command);
    else if (!realtime || decision.outcome === "invalid") applyCommand(pilot.exec, null);
    this.record(pilot, decision, round);
    this.setPilotStatus(pilot, "flying");
  }

  /** The account a Claude call uses: the run's choice, or the one with most quota left (re-checked every minute). */
  private async claudeAccountFor(modelId: string): Promise<string | undefined> {
    const configured = this.run!.config.claudeAccount;
    if (!modelId.startsWith("claude/")) return undefined;
    if (configured !== CLAUDE_ACCOUNT_AUTO) return configured;
    if (!this.claudeProfile) return "main";
    const now = this.now();
    if (!this.claudeChoice || this.claudeChoice.until < now) {
      const account = (await this.claudeProfile().catch(() => null)) ?? "main";
      this.claudeChoice = { account, until: now + 60_000 };
    }
    return this.claudeChoice.account;
  }

  private setPilotStatus(pilot: PilotRuntime, status: LivePilot["status"]): void {
    const live = this.live?.pilots.find((entry) => entry.id === pilot.contestant.id);
    if (live && live.status !== "destroyed") live.status = status;
  }

  private refreshLive(arenas: AgentArena[]): void {
    const live = this.live!;
    live.t = Math.round(Math.max(...arenas.map((arena) => arena.timeS)) * 10) / 10;
    live.tLeft = Math.round(Math.max(0, ROUND_SECONDS - live.t) * 10) / 10;
    for (const pilot of this.pilots) {
      const entry = live.pilots.find((candidate) => candidate.id === pilot.contestant.id);
      const ship = pilot.arena.ships[pilot.slot];
      if (!entry || !ship) continue;
      entry.hull = ship.hull;
      entry.shield = ship.shield;
      entry.bombs = ship.bombs;
      entry.roundScore = ship.stats.score;
      entry.runScore = pilot.runScore;
      entry.roundWins = pilot.roundWins;
      entry.decisions = { ...pilot.totals };
      entry.avgLatencyMs = pilot.latencyCount > 0 ? Math.round(pilot.latencyTotal / pilot.latencyCount) : null;
      entry.last = pilot.lastLive;
      if (!ship.alive) entry.status = "destroyed";
      else if (entry.status === "destroyed" || entry.status === "ready") entry.status = "flying";
    }
  }

  private finalizeRound(round: number, seed: number, arenas: AgentArena[], durationS: number): RoundRecord {
    const run = this.run!;
    const shared = run.mode === "shared_arena";
    const placement = shared ? arenas[0]!.placementOrder().map((ship) => ship.slot) : [];
    const results: RoundResult[] = this.pilots.map((pilot) => {
      const ship = pilot.arena.ships[pilot.slot]!;
      const stats = ship.stats;
      const latencies = pilot.decisions.filter((decision) => decision.outcome === "ok" || decision.outcome === "invalid").map((decision) => decision.latencyMs);
      const tally = emptyTally();
      const maneuvers: Record<string, number> = {};
      let tokens = 0;
      let tokenSeen = false;
      for (const decision of pilot.decisions) {
        tally.total += 1;
        tally[decision.outcome] += 1;
        if (decision.outcome === "ok") {
          const maneuver = decision.command.split(" ")[0] ?? "coast";
          maneuvers[maneuver] = (maneuvers[maneuver] ?? 0) + 1;
        }
        if (typeof decision.tokens === "number") {
          tokens += decision.tokens;
          tokenSeen = true;
        }
      }
      const latency = latencies.length > 0 && !pilot.contestant.reference
        ? {
            avgMs: Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
            p50Ms: percentile(latencies, 0.5) ?? 0,
            p95Ms: percentile(latencies, 0.95) ?? 0,
            maxMs: Math.max(...latencies)
          }
        : null;
      return {
        contestantId: pilot.contestant.id,
        score: stats.score,
        breakdown: { ...stats.breakdown },
        kills: { ...stats.kills },
        shotsFired: stats.shotsFired,
        shotsHit: stats.shotsHit,
        accuracy: stats.shotsFired > 0 ? Math.round((stats.shotsHit / stats.shotsFired) * 100) : null,
        hullLost: stats.hullLost,
        shieldAbsorbed: stats.shieldAbsorbed,
        pickups: stats.pickups,
        bombsUsed: stats.bombsUsed,
        dashesUsed: stats.dashesUsed,
        survivedS: Math.round((stats.aliveTicks / TICK_HZ) * 10) / 10,
        destroyed: !ship.alive,
        placement: shared ? placement.indexOf(pilot.slot) + 1 : null,
        rank: 0,
        decisions: tally,
        latency,
        maneuvers,
        tokens: tokenSeen ? tokens : null,
        degraded: tally.total > 0 && tally.error / tally.total > DEGRADED_ERROR_SHARE
      };
    });
    const ranked = [...results].sort(
      (left, right) =>
        right.score - left.score ||
        left.hullLost - right.hullLost ||
        (this.pilots.find((pilot) => pilot.contestant.id === left.contestantId)?.contestant.slot ?? 0) -
          (this.pilots.find((pilot) => pilot.contestant.id === right.contestantId)?.contestant.slot ?? 0)
    );
    ranked.forEach((result, index) => {
      result.rank = index + 1;
    });
    const contestants = new Map(run.contestants.map((contestant) => [contestant.id, contestant]));
    const winnerId = ranked[0]?.contestantId ?? "";
    const bestModelId = ranked.find((result) => !contestants.get(result.contestantId)?.reference && !result.degraded)?.contestantId ?? null;
    for (const pilot of this.pilots) {
      const result = results.find((entry) => entry.contestantId === pilot.contestant.id)!;
      pilot.runScore += result.score;
      if (pilot.contestant.id === winnerId) pilot.roundWins += 1;
    }
    const winner = contestants.get(winnerId);
    this.live!.roundWinners.push({ round, winnerId, bestModelId, scores: Object.fromEntries(results.map((result) => [result.contestantId, result.score])) });
    this.event(round, Math.max(...arenas.map((arena) => arena.timeS)), "round", `Round ${round} winner: ${winner?.displayName ?? "none"} (${ranked[0]?.score ?? 0} pts).`, winnerId);
    return {
      round,
      seed,
      durationS: Math.round(durationS * 10) / 10,
      winnerId,
      bestModelId,
      results,
      decisions: Object.fromEntries(this.pilots.map((pilot) => [pilot.contestant.id, pilot.decisions]))
    };
  }
}
