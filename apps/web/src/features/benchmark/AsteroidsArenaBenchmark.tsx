import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { benchmarkGet, benchmarkPost } from "./benchmark-api.js";
import { drawArenaFrame, drawIdleArena, fxColor, type ActiveFx, type PilotLook } from "./arena-renderer.js";
import {
  ARENA_MODE_ORDER,
  type ArenaCatalog,
  type ArenaMode,
  type ArenaModel,
  type ArenaProtocol,
  type LeaderboardView,
  type LiveEvent,
  type LiveFrame,
  type LivePilot,
  type LiveResponse,
  type LiveRunState,
  type RunRecord,
  type RunSummary
} from "./arena-types.js";
import "./asteroids-arena.css";

const BASELINE_ID = "baseline/scripted-pilot";
const MAX_PILOTS = 8;
const FRAME_MS = 100;
const POLL_ACTIVE_MS = 400;
const POLL_IDLE_MS = 4000;

// OpenCode leads provider lists (clean-setup rule); the rest keep their order.
const PROVIDERS: Array<{ id: string; name: string }> = [
  { id: "opencode", name: "OpenCode" },
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
  { id: "antigravity", name: "Antigravity" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "github", name: "GitHub CLI" }
];

const MODE_FALLBACK: Record<ArenaMode, { title: string; tests: string; timing: string }> = {
  championship: { title: "Championship", tests: "Decision quality on an identical seeded gauntlet.", timing: "Lockstep: the game waits for every decision." },
  duel: { title: "Real-Time Duel", tests: "Decision quality under time pressure.", timing: "Real time: the game never waits." },
  shared_arena: { title: "All-in-One Arena", tests: "Multi-agent adversarial play in one shared arena.", timing: "Lockstep: simultaneous decisions." }
};

const PREFERRED_DEFAULTS = ["claude/claude-opus-5-5", "claude/claude-sonnet-5-5", "codex/gpt-6.1-sol", "codex/gpt-6-astra"];
const BASE_CLAUDE_ACCOUNTS = [
  { id: "auto", label: "Auto · most quota left" },
  { id: "main", label: "main" }
];

function modeTitle(protocol: ArenaProtocol | null, mode: ArenaMode): string {
  return protocol?.modes[mode]?.title ?? MODE_FALLBACK[mode].title;
}

function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value >= 10_000 ? `${(value / 1000).toFixed(0)} s` : value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${value} ms`;
}

function signed(value: number | null): string {
  if (value === null) return "—";
  return value > 0 ? `+${value}` : String(value);
}

function shortLabel(name: string): string {
  return name.length > 18 ? `${name.slice(0, 17)}…` : name;
}

function providerName(id: string): string {
  if (id === "baseline") return "reference";
  if (id === "jev") return "Jev";
  return PROVIDERS.find((provider) => provider.id === id)?.name ?? id;
}

function estimateMinutes(mode: ArenaMode, rounds: number, protocol: ArenaProtocol | null): number {
  const decisions = protocol?.decisionsPerRound ?? 30;
  const roundSeconds = mode === "duel" ? protocol?.roundSeconds ?? 45 : decisions * 3.5;
  return Math.max(1, Math.round(((roundSeconds + 6) * rounds + 30) / 60));
}

function statusLabel(pilot: LivePilot, realtime: boolean): string {
  if (pilot.status === "destroyed") return "Destroyed";
  if (pilot.reference) return "Scripted";
  if (pilot.status === "thinking") return realtime ? "Flying · thinking" : "Thinking…";
  if (pilot.status === "flying") return "Flying";
  return "Ready";
}

interface PlaybackState {
  index: number;
  acc: number;
  last: number;
}

export function AsteroidsArenaBenchmark({ visible = true }: { visible?: boolean }) {
  const [catalog, setCatalog] = useState<ArenaCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [protocol, setProtocol] = useState<ArenaProtocol | null>(null);
  const [mode, setMode] = useState<ArenaMode>("championship");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(PROVIDERS.map((provider) => [provider.id, true])));
  const [selected, setSelected] = useState<string[]>([]);
  const [includeBaseline, setIncludeBaseline] = useState(true);
  const [rounds, setRounds] = useState(3);
  const [claudeAccount, setClaudeAccount] = useState("auto");
  const [claudeAccounts, setClaudeAccounts] = useState<Array<{ id: string; label: string }>>(BASE_CLAUDE_ACCOUNTS);
  const [live, setLive] = useState<LiveRunState | null>(null);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [board, setBoard] = useState<LeaderboardView | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [openRun, setOpenRun] = useState<RunRecord | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const framesRef = useRef<LiveFrame[]>([]);
  const cursorRef = useRef(-1);
  const playRef = useRef<PlaybackState>({ index: 0, acc: 0, last: 0 });
  const fxRef = useRef(new Map<string, ActiveFx[]>());
  const canvasesRef = useRef(new Map<string, HTMLCanvasElement>());
  const liveRef = useRef<LiveRunState | null>(null);
  const runIdRef = useRef<string | null>(null);
  const shownModeRef = useRef<ArenaMode>("championship");
  const canvasRefs = useRef(new Map<string, (node: HTMLCanvasElement | null) => void>());

  const running = live?.status === "running";
  const liveMode = live?.mode ?? mode;

  const refreshResults = useCallback(async (target: ArenaMode) => {
    const [leaderboard, history] = await Promise.all([
      benchmarkGet<LeaderboardView>(`/api/asteroids/benchmark/leaderboard?mode=${target}`).catch(() => null),
      benchmarkGet<{ runs: RunSummary[] }>(`/api/asteroids/benchmark/runs?mode=${target}&limit=10`).catch(() => ({ runs: [] }))
    ]);
    setBoard(leaderboard);
    setRuns(history.runs);
  }, []);

  useEffect(() => {
    if (!visible || catalog) return;
    void benchmarkGet<ArenaCatalog>("/api/asteroids/benchmark/models", 30_000)
      .then((loaded) => {
        setCatalog(loaded);
        setSelected((current) => {
          if (current.length > 0) return current;
          const ids = new Set(loaded.models.map((model) => model.id));
          const picks = PREFERRED_DEFAULTS.filter((id) => ids.has(id));
          for (const model of loaded.models) {
            if (picks.length >= 4) break;
            if (model.id !== BASELINE_ID && !picks.includes(model.id)) picks.push(model.id);
          }
          return picks;
        });
      })
      .catch((error: unknown) => setCatalogError(error instanceof Error ? error.message : "Models could not be loaded."));
    void benchmarkGet<ArenaProtocol>("/api/asteroids/benchmark/protocol").then(setProtocol).catch(() => undefined);
    void benchmarkGet<{ profiles?: Array<{ profileId: string; displayName: string }> }>("/api/cli/runtimes/cli:claude/account-profiles")
      .then((payload) => {
        const extra = (payload.profiles ?? []).filter((profile) => profile.profileId !== "main").map((profile) => ({ id: profile.profileId, label: `${profile.displayName} (${profile.profileId})` }));
        setClaudeAccounts([...BASE_CLAUDE_ACCOUNTS, ...extra]);
      })
      .catch(() => undefined);
  }, [visible, catalog]);

  useEffect(() => {
    if (!visible) return;
    void refreshResults(mode);
  }, [visible, mode, refreshResults]);

  const ingest = useCallback(
    (data: LiveResponse) => {
      const run = data.run;
      if (run && run.id !== runIdRef.current) {
        runIdRef.current = run.id;
        framesRef.current = [];
        playRef.current = { index: 0, acc: 0, last: 0 };
        fxRef.current = new Map();
        setEvents([]);
        if (run.status === "running") setMode(run.mode);
      }
      const previous = liveRef.current;
      liveRef.current = run;
      setLive(run);
      if (data.frames.length > 0) {
        const queue = framesRef.current;
        const lastSeq = queue.at(-1)?.seq ?? -1;
        for (const frame of data.frames) if (frame.seq > lastSeq) queue.push(frame);
        if (queue.length > 900) {
          const drop = queue.length - 900;
          queue.splice(0, drop);
          playRef.current.index = Math.max(0, playRef.current.index - drop);
        }
      }
      if (data.events.length > 0) {
        setEvents((current) => {
          const seen = new Set(current.map((event) => event.seq));
          return [...current, ...data.events.filter((event) => !seen.has(event.seq))].slice(-80);
        });
      }
      cursorRef.current = data.frames.length >= 80 ? data.frames.at(-1)!.seq : data.latestSeq;
      if (previous?.status === "running" && run && run.status !== "running") void refreshResults(run.mode);
      if (previous && run && previous.round !== run.round && run.round > 1) void refreshResults(run.mode);
    },
    [refreshResults]
  );

  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          ingest(await benchmarkGet<LiveResponse>(`/api/asteroids/benchmark/live?after=${cursorRef.current}`, 10_000));
        } catch {}
      }
      if (!stopped) timer = window.setTimeout(tick, liveRef.current?.status === "running" ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [visible, ingest]);

  const looksFor = useCallback((arenaKey: string): PilotLook[] => {
    const pilots = liveRef.current?.pilots ?? [];
    if (arenaKey === "shared") {
      return [...pilots].sort((left, right) => left.slot - right.slot).map((pilot) => ({ color: pilot.color, label: shortLabel(pilot.displayName) }));
    }
    const pilot = pilots.find((entry) => entry.id === arenaKey);
    return [{ color: pilot?.color ?? "#8ee6ff", label: shortLabel(pilot?.displayName ?? arenaKey) }];
  }, []);

  useEffect(() => {
    if (!visible) return;
    let handle = 0;
    const loop = (now: number) => {
      const queue = framesRef.current;
      const play = playRef.current;
      const elapsed = play.last ? Math.min(250, now - play.last) : 0;
      play.last = now;
      const runState = liveRef.current;
      if (queue.length > 0 && runState?.mode === shownModeRef.current) {
        const ahead = queue.length - 1 - play.index;
        if (ahead > 0) {
          play.acc += elapsed * (ahead > 40 ? 4 : ahead > 20 ? 1.6 : 1);
          while (play.acc >= FRAME_MS && play.index < queue.length - 1) {
            play.acc -= FRAME_MS;
            play.index += 1;
            const shown = queue[play.index]!;
            for (const arena of shown.arenas) {
              if (arena.fx.length === 0) continue;
              const looks = looksFor(arena.k);
              const list = fxRef.current.get(arena.k) ?? [];
              for (const [kind = 0, x = 0, y = 0, slot = -1] of arena.fx) list.push({ kind, x, y, color: fxColor(kind, slot, looks), born: now });
              fxRef.current.set(arena.k, list.slice(-60));
            }
          }
        } else {
          play.acc = 0;
        }
        if (play.index > 120) {
          queue.splice(0, play.index - 20);
          play.index = 20;
        }
        const current = queue[play.index]!;
        const next = queue[play.index + 1] ?? null;
        const overlay = runState?.phase === "intermission" && play.index >= queue.length - 2
          ? `Round ${runState.round} complete`
          : runState && runState.status !== "running" && play.index >= queue.length - 1
            ? runState.status === "completed" ? "Run complete" : `Run ${runState.status}`
            : null;
        for (const arena of current.arenas) {
          const canvas = canvasesRef.current.get(arena.k);
          if (!canvas) continue;
          const ratio = Math.min(2, window.devicePixelRatio || 1);
          const width = Math.max(320, Math.round(canvas.clientWidth * ratio));
          const height = Math.round((width * 9) / 16);
          if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
          }
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          const effects = (fxRef.current.get(arena.k) ?? []).filter((effect) => now - effect.born < 900);
          fxRef.current.set(arena.k, effects);
          const target = next?.arenas.find((candidate) => candidate.k === arena.k) ?? null;
          drawArenaFrame(ctx, arena, next && next.round === current.round ? target : null, play.acc / FRAME_MS, looksFor(arena.k), {
            labels: arena.k === "shared",
            effects,
            now,
            overlay
          });
        }
      }
      handle = window.requestAnimationFrame(loop);
    };
    handle = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(handle);
  }, [visible, looksFor]);

  const modelsById = useMemo(() => new Map((catalog?.models ?? []).map((model) => [model.id, model])), [catalog]);
  const grouped = useMemo(() => {
    const groups = new Map<string, ArenaModel[]>();
    for (const model of catalog?.models ?? []) {
      if (model.id === BASELINE_ID) continue;
      const list = groups.get(model.providerId) ?? [];
      list.push(model);
      groups.set(model.providerId, list);
    }
    return groups;
  }, [catalog]);

  const roster = useMemo(() => {
    const ids = selected.filter((id) => modelsById.has(id) && enabled[modelsById.get(id)!.providerId] !== false);
    return includeBaseline ? [...ids, BASELINE_ID] : ids;
  }, [selected, modelsById, enabled, includeBaseline]);
  const modelCount = roster.filter((id) => id !== BASELINE_ID).length;
  const canLaunch = !running && !pending && modelCount >= 1 && roster.length >= 2 && roster.length <= MAX_PILOTS;

  const toggleModel = (id: string) => {
    if (running) return;
    setSelected((current) => {
      if (current.includes(id)) return current.filter((entry) => entry !== id);
      if (current.length + (includeBaseline ? 1 : 0) >= MAX_PILOTS) {
        setNotice({ tone: "error", text: `A run takes at most ${MAX_PILOTS} pilots (the Scripted Baseline counts as one).` });
        return current;
      }
      return [...current, id];
    });
  };

  const preset = (ids: string[]) => {
    if (running) return;
    const available = ids.filter((id) => modelsById.has(id));
    setSelected(available.slice(0, MAX_PILOTS - (includeBaseline ? 1 : 0)));
  };

  const launch = async () => {
    if (!canLaunch) return;
    setPending(true);
    setNotice(null);
    try {
      const response = await benchmarkPost<{ run: LiveRunState }>("/api/asteroids/benchmark/runs", {
        mode,
        rounds,
        claudeAccount,
        contestants: roster.map((id) => ({ id, displayName: modelsById.get(id)?.displayName ?? id }))
      });
      ingest({ run: response.run, frames: [], events: [], latestSeq: cursorRef.current });
      setNotice({ tone: "info", text: "Run started. Every model first answers one snapshot so unavailable providers can be skipped." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The run could not start." });
    } finally {
      setPending(false);
    }
  };

  const stop = async () => {
    try {
      await benchmarkPost("/api/asteroids/benchmark/runs/stop", {});
      setNotice({ tone: "info", text: "Stopping… completed rounds stay recorded." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "The run could not be stopped." });
    }
  };

  const reset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    try {
      await benchmarkPost("/api/asteroids/benchmark/championship/reset", { mode });
      await refreshResults(mode);
      setNotice({ tone: "info", text: `${modeTitle(protocol, mode)} leaderboard cleared. Run history is kept.` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Reset failed." });
    }
  };

  const openDetails = async (id: string) => {
    if (openRun?.id === id) {
      setOpenRun(null);
      return;
    }
    try {
      setOpenRun(await benchmarkGet<RunRecord>(`/api/asteroids/benchmark/runs/${id}`));
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Run details could not be loaded." });
    }
  };

  const livePilots = live?.pilots ?? [];
  const shownMode: ArenaMode = live && (running || live.mode === mode) ? live.mode : mode;
  const arenaKeys = shownMode === "shared_arena" ? ["shared"] : live && live.mode === shownMode ? livePilots.map((pilot) => pilot.id) : roster;
  const championRow = board?.rows.find((row) => row.id === board.championId) ?? null;
  const baselineRow = board?.rows.find((row) => row.reference) ?? null;
  const scoring = protocol?.scoring;
  shownModeRef.current = shownMode;

  // Stable per-mode ref callbacks: a canvas mounts once and starts with an idle picture.
  const setCanvas = (key: string) => {
    const refKey = `${shownMode}:${key}`;
    let callback = canvasRefs.current.get(refKey);
    if (!callback) {
      const title = key === "shared" ? "All-in-One Arena" : shortLabel(modelsById.get(key)?.displayName ?? liveRef.current?.pilots.find((pilot) => pilot.id === key)?.displayName ?? (key === BASELINE_ID ? "Scripted Baseline" : key));
      callback = (node: HTMLCanvasElement | null) => {
        if (!node) {
          if (canvasesRef.current.get(key)?.isConnected === false) canvasesRef.current.delete(key);
          return;
        }
        canvasesRef.current.set(key, node);
        const ctx = node.getContext("2d");
        node.width = 960;
        node.height = 540;
        if (ctx) drawIdleArena(ctx, title, "Waiting for launch");
      };
      canvasRefs.current.set(refKey, callback);
    }
    return callback;
  };

  return (
    <section className="benchmark-game-panel arena-panel">
      <div className="benchmark-game-heading">
        <div>
          <h2>Asteroids Agent Arena</h2>
          <p>
            A closed-loop benchmark for AI agents: every {protocol?.decisionIntervalS ?? 1.5} s of game time each model reads a JSON sensor snapshot and
            answers with one command. The server runs the game and keeps the score.
          </p>
        </div>
        <span className="benchmark-phase-badge">
          {running ? `${modeTitle(protocol, liveMode)} · round ${live?.round || 1}/${live?.rounds}` : `Protocol ${protocol?.protocol ?? "agent-arena/2"}`}
        </span>
      </div>

      <details className="arena-method" open>
        <summary>What this benchmark measures</summary>
        <div className="arena-method-grid">
          <div>
            <h4>Capabilities tested</h4>
            <ul>
              <li><b>Situational awareness</b> — reading up to 10 contacts with distance, bearing, closing speed and predicted closest approach.</li>
              <li><b>Threat prediction</b> — acting on time-to-impact and miss-distance forecasts before a collision happens.</li>
              <li><b>Prioritization</b> — rocks, hunter and gunship drones and pickups are worth very different points and risks.</li>
              <li><b>Resource management</b> — one bomb, a dash with cooldown, shield and repair pickups.</li>
              <li><b>Protocol discipline</b> — a valid JSON command with real target ids, every window.</li>
              <li><b>Speed</b> (Real-Time Duel) — the game never waits; slow answers act on stale data.</li>
              <li><b>Adversarial play</b> (All-in-One Arena) — models fight each other in one arena.</li>
            </ul>
          </div>
          <div>
            <h4>Data recorded</h4>
            <ul>
              <li><b>Every decision:</b> snapshot time, command, outcome (valid, invalid, timeout, provider error), latency, radio note, and the start of any unusable reply.</li>
              <li><b>Every round:</b> score breakdown (rocks, drones, pilots, pickups, survival, damage, placement), kills, shots fired and hit, hull lost, shields absorbed, survival time, maneuvers used, tokens when the provider reports them.</li>
              <li><b>Leaderboard:</b> average score per round, wins, accuracy, survival rate, valid-reply rate, latency p50/p95, and the score difference against the Scripted Baseline in the same rounds.</li>
            </ul>
          </div>
          <div>
            <h4>Why it is fair</h4>
            <ul>
              <li>Every pilot in a round faces the identical seeded scenario; no randomness happens during play.</li>
              <li>Same system prompt, snapshot and action space for every model; the flight computer only executes orders and never dodges on its own.</li>
              <li>The server simulates and scores. Browsers only watch; results cannot be submitted from the client.</li>
              <li>Lockstep modes pause the game while models think. Only the Real-Time Duel turns latency into a handicap.</li>
              <li>Provider outages are not model mistakes: failed preflights are skipped and rounds with over 25% provider errors are marked degraded and left out.</li>
              <li>Validity is tested in CI: the Scripted Baseline beats a naive pilot, which beats a random one, which beats an idle one.</li>
            </ul>
          </div>
        </div>
        {scoring && (
          <div className="arena-scoring" aria-label="Scoring">
            <span>Rock +{scoring.rock["3"]}/+{scoring.rock["2"]}/+{scoring.rock["1"]}</span>
            <span>Hunter +{scoring.hunter}</span>
            <span>Gunship +{scoring.gunship}</span>
            <span>Pilot hit +{scoring.pilotHit}</span>
            <span>Pilot destroyed +{scoring.pilotKill}</span>
            <span>Pickup +{scoring.pickup}</span>
            <span>Alive +{scoring.survivalPerSecond}/s</span>
            <span className="negative">Hull lost {scoring.hullLost}</span>
            <span>Placement +{scoring.placement.join("/+")}</span>
          </div>
        )}
        <button type="button" className="benchmark-quick-btn" onClick={() => setShowPrompt((current) => !current)}>
          {showPrompt ? "Hide the exact prompt" : "Show the exact prompt, snapshot and provider paths"}
        </button>
        {showPrompt && protocol && (
          <div className="arena-prompt">
            <h4>System prompt · {modeTitle(protocol, mode)}</h4>
            <pre>{protocol.modes[mode]?.systemPrompt}</pre>
            <h4>Sample sensor snapshot</h4>
            <pre>{JSON.stringify(protocol.sampleSnapshot, null, 1)}</pre>
            <h4>Provider paths</h4>
            <ul>
              {Object.entries(protocol.providers).map(([id, path]) => (
                <li key={id}><b>{providerName(id)}</b>: {path}</li>
              ))}
            </ul>
          </div>
        )}
      </details>

      <div className="benchmark-mode-nav" role="tablist" aria-label="Benchmark mode">
        {ARENA_MODE_ORDER.map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            aria-selected={mode === entry}
            className={`benchmark-mode-btn ${mode === entry ? "active" : ""}`}
            onClick={() => {
              if (!running) setMode(entry);
            }}
            disabled={running && mode !== entry}
          >
            {modeTitle(protocol, entry)}
          </button>
        ))}
      </div>
      <div className="arena-mode-brief">
        <strong>{protocol?.modes[mode]?.tests ?? MODE_FALLBACK[mode].tests}</strong>
        <span>{protocol?.modes[mode]?.timing ?? MODE_FALLBACK[mode].timing}</span>
      </div>

      <div className="benchmark-game-settings arena-setup">
        <fieldset className="benchmark-provider-picker">
          <legend>Providers</legend>
          {PROVIDERS.map((provider) => {
            const count = grouped.get(provider.id)?.length ?? 0;
            return (
              <SpaceToggle
                key={provider.id}
                className="benchmark-provider-toggle"
                label={<strong>{provider.name}</strong>}
                detail={`${count} model${count === 1 ? "" : "s"}`}
                checked={Boolean(enabled[provider.id]) && count > 0}
                disabled={running || count === 0}
                onChange={() => setEnabled((current) => ({ ...current, [provider.id]: !current[provider.id] }))}
              />
            );
          })}
          <SpaceToggle
            className="benchmark-provider-toggle"
            label={<strong>Scripted Baseline</strong>}
            detail="Reference pilot"
            checked={includeBaseline}
            disabled={running}
            onChange={() => setIncludeBaseline((current) => !current)}
          />
        </fieldset>

        <div className="benchmark-contestants-picker">
          <div className="benchmark-contestants-bar">
            <span>Pilots ({roster.length}/{MAX_PILOTS}):</span>
            <button type="button" className="benchmark-quick-btn" disabled={running} onClick={() => preset(PREFERRED_DEFAULTS)}>Claude vs Codex</button>
            <button type="button" className="benchmark-quick-btn" disabled={running} onClick={() => preset((grouped.get("claude") ?? []).map((model) => model.id))}>All Claude</button>
            <button type="button" className="benchmark-quick-btn" disabled={running} onClick={() => setSelected([])}>Clear</button>
          </div>
          <div className="arena-model-groups">
            {PROVIDERS.filter((provider) => enabled[provider.id] && (grouped.get(provider.id)?.length ?? 0) > 0).map((provider) => (
              <div key={provider.id} className="arena-model-group">
                <span className="arena-model-group-name">{provider.name}</span>
                <div className="benchmark-chips-wrap">
                  {(grouped.get(provider.id) ?? []).map((model) => (
                    <button
                      key={model.id}
                      type="button"
                      className={`benchmark-chip ${selected.includes(model.id) ? "selected" : ""}`}
                      aria-pressed={selected.includes(model.id)}
                      onClick={() => toggleModel(model.id)}
                      disabled={running}
                    >
                      {model.displayName}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="benchmark-action-row arena-actions">
          <label className="chess-setting">
            <span>Rounds (1–10)</span>
            <input
              className="benchmark-games-input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={rounds}
              onChange={(event) => setRounds(Math.max(1, Math.min(10, Number(event.target.value) || 1)))}
              disabled={running}
            />
          </label>
          {enabled.claude && roster.some((id) => id.startsWith("claude/")) && (
            <label className="chess-setting">
              <span>Claude account</span>
              <select value={claudeAccount} onChange={(event) => setClaudeAccount(event.target.value)} disabled={running}>
                {claudeAccounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.label}</option>
                ))}
              </select>
            </label>
          )}
          {running ? (
            <button type="button" className="benchmark-reset" onClick={() => void stop()}>Stop run</button>
          ) : (
            <button type="button" className="benchmark-launch-btn" onClick={() => void launch()} disabled={!canLaunch}>
              {pending ? "Starting…" : `Launch ${modeTitle(protocol, mode)} · ${roster.length} pilots × ${rounds} round${rounds === 1 ? "" : "s"}`}
            </button>
          )}
          <button type="button" className="benchmark-reset" onClick={() => void reset()} disabled={running}>
            {confirmReset ? "Confirm: clear this leaderboard" : "Reset leaderboard"}
          </button>
          {!running && <span className="chess-estimate">About {estimateMinutes(mode, rounds, protocol)} min, depending on model speed.</span>}
        </div>
      </div>

      {catalogError && <p className="benchmark-status benchmark-error">Models could not be loaded: {catalogError}</p>}
      {!catalog && !catalogError && <p className="benchmark-status">Loading available models…</p>}
      {notice && <p className={`chess-notice ${notice.tone === "error" ? "error" : ""}`} role="status">{notice.text}</p>}

      {live && (
        <div className="arena-live">
          <div className="arena-live-bar" role="status">
            <strong>
              {live.status === "running"
                ? live.phase === "preflight"
                  ? "Preflight: checking that every model answers…"
                  : `${modeTitle(protocol, live.mode)} · Round ${live.round}/${live.rounds} · t ${live.t.toFixed(1)} s · ${live.realtime ? "real time" : `decision ${Math.min(live.decisionIndex + 1, live.decisionsPerRound)}/${live.decisionsPerRound}`}`
                : `${modeTitle(protocol, live.mode)} · ${live.message}`}
            </strong>
            <span>{live.origin === "cli" ? "Started from the headless runner" : live.origin === "control" ? "Started by Room Agent" : "Started from this page"} · {new Date(live.startedAt).toLocaleString()}</span>
          </div>
          {live.skipped.length > 0 && (
            <p className="chess-notice warning">
              Skipped (provider unavailable, not scored): {live.skipped.map((entry) => `${entry.displayName} — ${entry.reason}`).join("; ")}
            </p>
          )}
          {live.roundWinners.length > 0 && (
            <div className="arena-round-chips">
              {live.roundWinners.map((entry) => {
                const winner = livePilots.find((pilot) => pilot.id === entry.winnerId);
                return (
                  <span key={entry.round} style={{ borderColor: winner?.color }}>
                    Round {entry.round}: <b>{winner?.displayName ?? entry.winnerId}</b> ({entry.scores[entry.winnerId] ?? 0})
                  </span>
                );
              })}
              {live.championId && live.status !== "running" && (
                <span className="arena-champion-chip">Run champion: <b>{livePilots.find((pilot) => pilot.id === live.championId)?.displayName ?? live.championId}</b></span>
              )}
            </div>
          )}
        </div>
      )}

      {shownMode === "shared_arena" ? (
        <div className="arena-shared">
          <div className="arena-canvas-box">
            <canvas key={shownMode} ref={setCanvas("shared")} aria-label="Shared arena" />
          </div>
          <div className="arena-scoreboard">
            {(live && live.mode === "shared_arena" ? [...livePilots].sort((left, right) => right.roundScore - left.roundScore) : []).map((pilot) => (
              <PilotCard key={pilot.id} pilot={pilot} realtime={false} />
            ))}
            {!(live && live.mode === "shared_arena") && <p className="chess-notice">Launch the All-in-One Arena to see every model fly in one shared space.</p>}
          </div>
        </div>
      ) : (
        <div className="arena-grid">
          {arenaKeys.map((key) => {
            const pilot = livePilots.find((entry) => entry.id === key);
            return (
              <figure key={`${shownMode}:${key}`} className={`arena-figure ${pilot?.status === "destroyed" ? "is-destroyed" : ""}`}>
                {pilot ? (
                  <PilotCard pilot={pilot} realtime={Boolean(live?.realtime)} />
                ) : (
                  <div className="arena-pilot-head"><strong>{modelsById.get(key)?.displayName ?? (key === BASELINE_ID ? "Scripted Baseline" : key)}</strong></div>
                )}
                <div className="arena-canvas-box">
                  <canvas ref={setCanvas(key)} aria-label={`Arena of ${pilot?.displayName ?? key}`} />
                </div>
              </figure>
            );
          })}
        </div>
      )}

      {events.length > 0 && (
        <ol className="arena-events" aria-label="Run events">
          {events.slice(-8).reverse().map((event) => (
            <li key={event.seq} className={`arena-event ${event.kind}`}>
              <span>R{event.round} · {event.t.toFixed(1)} s</span> {event.text}
            </li>
          ))}
        </ol>
      )}

      <div className="benchmark-ranking">
        <div className="benchmark-ranking-heading">
          <h3>Leaderboard · {modeTitle(protocol, mode)}</h3>
          <span>
            {board?.roundsRecorded ? `${board.roundsRecorded} rounds from ${board.runs} runs · ranked by average score per round` : "No rounds recorded yet"}
          </span>
        </div>
        {championRow && (
          <div className="chess-champion">
            Champion: <b>{championRow.displayName}</b> · {championRow.avgScore} avg score over {championRow.rounds} rounds
            {championRow.vsBaseline !== null ? ` · ${signed(championRow.vsBaseline)} vs Scripted Baseline` : ""}
            {baselineRow && championRow.avgScore < baselineRow.avgScore ? " · the Scripted Baseline still scores higher" : ""}
          </div>
        )}
        <div className="benchmark-table-wrap">
          <table className="benchmark-table arena-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Model</th>
                <th title="Average final score per round">Avg score</th>
                <th>Wins</th>
                <th title="Rocks / drones / pilots destroyed">Kills R/D/P</th>
                <th title="Shots that hit / shots fired">Accuracy</th>
                <th title="Average hull points lost per round">Hull lost</th>
                <th title="Rounds survived to the end">Survival</th>
                <th title="Replies that were valid commands (timeouts count against it)">Valid replies</th>
                <th title="Average and 95th percentile decision latency">Latency avg / p95</th>
                <th title="Average score difference against the Scripted Baseline in the same rounds">vs Baseline</th>
              </tr>
            </thead>
            <tbody>
              {(board?.rows ?? []).map((row) => (
                <tr key={row.id} className={row.reference ? "arena-reference-row" : row.id === board?.championId ? "benchmark-selected" : undefined}>
                  <td><b>{row.rank}</b></td>
                  <td className="benchmark-model-cell">
                    <strong>{row.displayName}</strong>
                    <small>{providerName(row.providerId)} · {row.rounds} rds{row.degradedRounds > 0 ? ` · ${row.degradedRounds} degraded` : ""}</small>
                  </td>
                  <td className="benchmark-avg"><strong>{row.avgScore}</strong></td>
                  <td>{row.wins}/{row.rounds}</td>
                  <td>{row.kills.rocks}/{row.kills.drones}/{row.kills.pilots}</td>
                  <td>{row.accuracy === null ? "—" : `${row.accuracy}%`}</td>
                  <td>{row.avgHullLost}</td>
                  <td>{row.survivalRate}%</td>
                  <td>{row.validRate === null ? "—" : `${row.validRate}%`}{row.decisions.timeout + row.decisions.error > 0 ? <small> {row.decisions.timeout} t/o</small> : null}</td>
                  <td>{row.reference ? "—" : `${formatMs(row.avgLatencyMs)} / ${formatMs(row.p95LatencyMs)}`}</td>
                  <td className={row.vsBaseline !== null && row.vsBaseline > 0 ? "benchmark-good" : row.vsBaseline !== null && row.vsBaseline < 0 ? "benchmark-bad" : undefined}>
                    {row.reference ? "reference" : signed(row.vsBaseline)}
                  </td>
                </tr>
              ))}
              {(board?.rows.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={11} className="benchmark-muted">Launch a run to fill this leaderboard.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {runs.length > 0 && (
        <div className="arena-history">
          <h3>Recent runs · {modeTitle(protocol, mode)}</h3>
          <ul>
            {runs.map((run) => (
              <li key={run.id}>
                <button type="button" className="arena-history-row" onClick={() => void openDetails(run.id)} aria-expanded={openRun?.id === run.id}>
                  <span>{new Date(run.startedAt).toLocaleString()}</span>
                  <span>{run.roundsPlayed}/{run.rounds} rounds · {run.contestants} pilots{run.skipped ? ` · ${run.skipped} skipped` : ""}</span>
                  <span className={`arena-status ${run.status}`}>{run.status}</span>
                  <span>{run.championName ? `Champion: ${run.championName}` : ""}</span>
                </button>
                {openRun?.id === run.id && <RunDetails run={openRun} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PilotCard({ pilot, realtime }: { pilot: LivePilot; realtime: boolean }) {
  const last = pilot.last;
  return (
    <div className={`arena-pilot-head ${pilot.status}`} style={{ borderColor: pilot.color }}>
      <div className="arena-pilot-title">
        <i style={{ background: pilot.color }} aria-hidden="true" />
        <strong>{pilot.displayName}</strong>
        <small>{providerName(pilot.providerId)}</small>
        <span className="arena-pilot-score">{pilot.roundScore}</span>
      </div>
      <div className="arena-pilot-stats">
        <span className={`arena-pilot-status ${pilot.status}`}>{statusLabel(pilot, realtime)}</span>
        <span title="Hull">{"■".repeat(Math.max(0, pilot.hull))}{"□".repeat(Math.max(0, 5 - pilot.hull))}</span>
        <span title="Shield charges">⛨ {pilot.shield}</span>
        <span title="Bombs">✸ {pilot.bombs}</span>
        <span title="Valid decisions / decisions">{pilot.decisions.ok}/{pilot.decisions.total}</span>
        {!pilot.reference && <span title="Average decision latency">{formatMs(pilot.avgLatencyMs)}</span>}
      </div>
      <div className={`arena-pilot-last ${last?.outcome ?? "none"}`}>
        {last
          ? last.outcome === "ok"
            ? `${last.command}${last.note ? ` · “${last.note}”` : ""}`
            : `${last.outcome.toUpperCase()}${last.reason ? ` · ${last.reason}` : ""}`
          : "Waiting for the first command"}
      </div>
    </div>
  );
}

function RunDetails({ run }: { run: RunRecord }) {
  const names = new Map(run.contestants.map((contestant) => [contestant.id, contestant.displayName]));
  return (
    <div className="arena-run-details">
      <p className="chess-notice">
        Run {run.id} · seed {run.config.seed} · {run.config.realtime ? "real time" : `lockstep, ${run.config.decisionIntervalS} s windows`} · decision timeout {run.config.decisionTimeoutS} s · Claude account {run.config.claudeAccount}
        {run.error ? ` · error: ${run.error}` : ""}
      </p>
      {run.skipped.length > 0 && <p className="chess-notice warning">Skipped: {run.skipped.map((entry) => `${entry.displayName} (${entry.reason})`).join("; ")}</p>}
      {run.rounds.map((round) => (
        <div key={round.round} className="arena-round">
          <h4>Round {round.round} · seed {round.seed} · {round.durationS} s wall time · winner {names.get(round.winnerId) ?? round.winnerId}</h4>
          <div className="benchmark-table-wrap">
            <table className="benchmark-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Pilot</th>
                  <th>Score</th>
                  <th title="rocks / drones / pilots / pickups / survival / damage / placement">Breakdown</th>
                  <th>Accuracy</th>
                  <th>Hull lost</th>
                  <th>Survived</th>
                  <th>Decisions ok/total</th>
                  <th>Latency avg / p95</th>
                  <th>Maneuvers</th>
                </tr>
              </thead>
              <tbody>
                {[...round.results].sort((left, right) => left.rank - right.rank).map((result) => (
                  <tr key={result.contestantId}>
                    <td>{result.rank}</td>
                    <td className="benchmark-model-cell">{names.get(result.contestantId) ?? result.contestantId}{result.degraded ? <small>degraded</small> : null}</td>
                    <td><b>{result.score}</b></td>
                    <td className="arena-breakdown">
                      {result.breakdown.rocks}/{result.breakdown.drones}/{result.breakdown.pilots}/{result.breakdown.pickups}/{result.breakdown.survival}/{result.breakdown.damage}/{result.breakdown.placement}
                    </td>
                    <td>{result.accuracy === null ? "—" : `${result.accuracy}%`}</td>
                    <td>{result.hullLost}</td>
                    <td>{result.destroyed ? `destroyed at ${result.survivedS} s` : "yes"}</td>
                    <td>
                      {result.decisions.ok}/{result.decisions.total}
                      {result.decisions.invalid + result.decisions.timeout + result.decisions.error > 0 && (
                        <small> {result.decisions.invalid} invalid · {result.decisions.timeout} t/o · {result.decisions.error} err</small>
                      )}
                    </td>
                    <td>{result.latency ? `${formatMs(result.latency.avgMs)} / ${formatMs(result.latency.p95Ms)}` : "—"}</td>
                    <td className="arena-breakdown">{Object.entries(result.maneuvers).map(([name, count]) => `${name} ${count}`).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {Object.entries(round.decisions).map(([id, decisions]) => (
            <details key={id} className="arena-decisions">
              <summary>Decision log · {names.get(id) ?? id} ({decisions.length})</summary>
              <ol>
                {decisions.slice(0, 120).map((decision, index) => (
                  <li key={index} className={decision.outcome}>
                    <span>t {decision.t.toFixed(1)} s</span>
                    <span>{decision.outcome}</span>
                    <span>{decision.command}</span>
                    <span>{formatMs(decision.latencyMs)}</span>
                    <span>{decision.note ?? decision.reason ?? ""}{decision.reply ? ` · reply: ${decision.reply}` : ""}</span>
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      ))}
    </div>
  );
}
