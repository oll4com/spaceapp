import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { benchmarkGet, benchmarkPost } from "./benchmark-api.js";
import { ChessBoard } from "./ChessBoard.js";
import "./chess-benchmark.css";

type ProviderId = string;
type Format = "swiss" | "round_robin";
type TournamentStatus = "running" | "stopped" | "interrupted" | "completed";

interface ChessContestant {
  id: string;
  modelId: string;
  providerId: ProviderId;
  modelName: string;
  reasoningEffort: string;
  displayName: string;
}

interface ChessProviderCheck {
  ok: boolean;
  latencyMs: number;
  contestantId: string;
  error: string | null;
  checkedAt: string;
}

interface ChessProviderSummary {
  id: ProviderId;
  name: string;
  available: boolean;
  count: number;
  requestLimit?: number;
  note?: string;
  check?: ChessProviderCheck;
}

interface ChessCatalog {
  contestants: ChessContestant[];
  providers: ChessProviderSummary[];
  generatedAt: string;
  checking?: boolean;
}

interface ChessStanding {
  id: string;
  rank: number;
  contestant: ChessContestant;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  games: number;
  elo: number;
  buchholz: number;
  modelMoves: number;
  illegalReplies: number;
  fallbackMoves: number;
  forfeits: number;
  totalLatencyMs: number;
}

interface ChessGameSummary {
  id: string;
  round: number;
  white: string;
  black: string | null;
  status: "pending" | "running" | "finished";
  result: "1-0" | "0-1" | "1/2-1/2" | null;
  reason: string | null;
  fen: string;
  thinking: "w" | "b" | null;
  queued?: boolean;
  strikes: { w: number; b: number };
  lastNote: string | null;
  plies: number;
  recentSan: string[];
  lastUci: string | null;
}

interface ChessGameDetail extends Omit<ChessGameSummary, "plies" | "recentSan" | "lastUci"> {
  san: string[];
  uci: string[];
}

interface ChessSettings {
  format: Format;
  rounds: number;
  moveTimeoutMs: number;
  maxPlies: number;
  concurrency: number;
}

interface ChessSnapshot {
  id: string;
  status: TournamentStatus;
  active: boolean;
  createdAt: string;
  completedAt: string | null;
  settings: ChessSettings;
  error: string | null;
  round: number;
  totalRounds: number;
  totals: { games: number; finished: number; running: number; pending: number; plies: number };
  standings: ChessStanding[];
  liveGames: ChessGameSummary[];
  recentGames: ChessGameSummary[];
}

const EFFORT_ORDER = ["default", "auto", "disabled", "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const TIME_CONTROLS = [
  { label: "Bullet", ms: 15_000 },
  { label: "Blitz", ms: 30_000 },
  { label: "Rapid", ms: 60_000 },
  { label: "Classical", ms: 120_000 },
];
const MOVE_CAPS = [40, 60, 80, 120, 200];
const PARALLEL_GAMES = [4, 8, 16, 24, 32];
const MAX_CONTESTANTS = 128;
// Providers with more models than this start with only their first model selected.
const FULL_SELECTION_MODELS = 12;
const CHECK_POLL_MS = 2_000;
const POLL_MS = 1_500;
// Typical Codex move latency measured on 2026-10-11 (low ~2-10 s, medium to xhigh ~20 s).
const TYPICAL_MOVE_SECONDS = 8;

const REASON_LABELS: Record<string, string> = {
  checkmate: "Checkmate",
  stalemate: "Stalemate",
  threefold: "Threefold repetition",
  fifty_move: "50-move rule",
  insufficient_material: "Insufficient material",
  adjudication: "Adjudicated on material",
  forfeit: "Forfeit (3 strikes)",
  bye: "Bye",
};

function effortRank(effort: string): number {
  const index = EFFORT_ORDER.indexOf(effort);
  return index < 0 ? EFFORT_ORDER.length : index;
}

function effortLabel(effort: string): string {
  return effort === "default" ? "Provider default" : effort;
}

/** Every small catalog in full; from large catalogs (Cursor, Hermes, Copilot) only the first model. */
export function defaultChessSelection(contestants: ChessContestant[]): Set<string> {
  const models = new Map<string, string[]>();
  for (const contestant of contestants) {
    const ids = models.get(contestant.providerId) ?? [];
    if (!ids.includes(contestant.modelId)) ids.push(contestant.modelId);
    models.set(contestant.providerId, ids);
  }
  return new Set(
    contestants
      .filter((contestant) => {
        const ids = models.get(contestant.providerId)!;
        return ids.length <= FULL_SELECTION_MODELS || ids[0] === contestant.modelId;
      })
      .map((contestant) => contestant.id)
  );
}

/** Reasoning levels a Quick tournament keeps: provider defaults and the lightest effort. */
const QUICK_EFFORTS = new Set(["default", "auto", "disabled", "off", "none", "minimal", "low"]);

function defaultRounds(players: number): number {
  if (players < 2) return 1;
  return Math.max(1, Math.min(players - 1, Math.ceil(Math.log2(players)) + 1));
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function formatPoints(points: number): string {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

function moveList(san: string[]): string {
  return san
    .map((move, index) => (index % 2 === 0 ? `${index / 2 + 1}. ${move}` : move))
    .join(" ");
}

function GameCard({
  game,
  name,
  onOpen,
}: {
  game: ChessGameSummary;
  name: (id: string | null) => string;
  onOpen: (id: string) => void;
}) {
  const side = (color: "w" | "b") => {
    const id = color === "w" ? game.white : game.black;
    const strikes = game.strikes[color];
    return (
      <div className={`chess-game-side ${game.thinking === color ? "thinking" : ""}`}>
        <span className={`chess-side-dot ${color === "w" ? "white" : "black"}`} aria-hidden="true" />
        <span className="chess-side-name" title={name(id)}>{name(id)}</span>
        {strikes > 0 ? <span className="chess-strikes" title={`${strikes} strike${strikes === 1 ? "" : "s"}`}>{"✕".repeat(strikes)}</span> : null}
        {game.thinking === color ? <span className="chess-thinking">{game.queued ? "queued" : "thinking"}</span> : null}
      </div>
    );
  };
  return (
    <button type="button" className="chess-game-card" onClick={() => onOpen(game.id)} aria-label={`Open game ${name(game.white)} vs ${name(game.black)}`}>
      {side("b")}
      <ChessBoard fen={game.fen} lastMove={game.lastUci} label={`${name(game.white)} vs ${name(game.black)}`} />
      {side("w")}
      <div className="chess-game-meta">
        <span>Round {game.round} · ply {game.plies}</span>
        <span>{game.recentSan.length > 0 ? `last ${game.recentSan[game.recentSan.length - 1]}` : "opening"}</span>
      </div>
      {game.lastNote ? <div className="chess-game-note">{game.lastNote}</div> : null}
    </button>
  );
}

export function ChessBenchmark({ visible = true }: { visible?: boolean }) {
  const [catalog, setCatalog] = useState<ChessCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [providerOn, setProviderOn] = useState<Record<string, boolean>>({});
  const [effortOn, setEffortOn] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<Format>("swiss");
  const [rounds, setRounds] = useState<number | null>(null);
  const [moveTimeoutMs, setMoveTimeoutMs] = useState(30_000);
  const [maxPlies, setMaxPlies] = useState(60);
  const [concurrency, setConcurrency] = useState(16);
  const [snapshot, setSnapshot] = useState<ChessSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [openGameId, setOpenGameId] = useState<string | null>(null);
  const [openGame, setOpenGame] = useState<ChessGameDetail | null>(null);
  const [query, setQuery] = useState("");
  const [checking, setChecking] = useState(false);
  const openGameRef = useRef<string | null>(null);
  openGameRef.current = openGameId;

  useEffect(() => {
    let cancelled = false;
    benchmarkGet<ChessCatalog>("/api/chess/benchmark/contestants", 60_000)
      .then((loaded) => {
        if (cancelled) return;
        setCatalog(loaded);
        setChecking(Boolean(loaded.checking));
        setProviderOn(Object.fromEntries(loaded.providers.map((provider) => [provider.id, provider.available && provider.check?.ok !== false])));
        setEffortOn(Object.fromEntries(loaded.contestants.map((contestant) => [contestant.reasoningEffort, true])));
        setSelected(defaultChessSelection(loaded.contestants));
      })
      .catch((reason) => {
        if (!cancelled) setCatalogError(reason instanceof Error ? reason.message : "Contestants could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A provider check runs on the server; poll the catalog until it is done, then switch failed providers off.
  useEffect(() => {
    if (!checking || !visible) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      try {
        const loaded = await benchmarkGet<ChessCatalog>("/api/chess/benchmark/contestants", 60_000);
        if (stopped) return;
        setCatalog(loaded);
        if (!loaded.checking) {
          setChecking(false);
          setProviderOn((current) => {
            const next = { ...current };
            for (const provider of loaded.providers) if (provider.check && !provider.check.ok) next[provider.id] = false;
            return next;
          });
        }
      } catch {}
    }, CHECK_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [checking, visible]);

  // Presets set every option at once; providers keep their on/off state (and check results).
  const applyPreset = (preset: "quick" | "full") => {
    if (!catalog) return;
    setEffortOn(Object.fromEntries(efforts.map((effort) => [effort, preset === "full" || QUICK_EFFORTS.has(effort)])));
    setSelected(defaultChessSelection(catalog.contestants));
    setQuery("");
    setFormat("swiss");
    setRounds(preset === "quick" ? 5 : null);
    setMoveTimeoutMs(30_000);
    setMaxPlies(preset === "quick" ? 40 : 60);
    setConcurrency(16);
  };

  const checkProviders = async () => {
    setError("");
    try {
      const loaded = await benchmarkPost<ChessCatalog>("/api/chess/benchmark/providers/check", {});
      setCatalog(loaded);
      setChecking(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The provider check could not start.");
    }
  };

  const loadGame = useCallback(async (id: string) => {
    try {
      const { game } = await benchmarkGet<{ game: ChessGameDetail }>(`/api/chess/benchmark/games/${encodeURIComponent(id)}`);
      if (openGameRef.current === id) setOpenGame(game);
    } catch {}
  }, []);

  const refresh = useCallback(async () => {
    const { tournament } = await benchmarkGet<{ tournament: ChessSnapshot | null }>("/api/chess/benchmark/tournament");
    setSnapshot(tournament);
    const gameId = openGameRef.current;
    if (gameId && tournament?.liveGames.some((game) => game.id === gameId)) void loadGame(gameId);
  }, [loadGame]);

  useEffect(() => {
    if (!visible) return;
    void refresh().catch(() => undefined);
  }, [visible, refresh]);

  const active = Boolean(snapshot?.active);
  useEffect(() => {
    if (!visible || !active) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await refresh().catch(() => undefined);
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    timer = window.setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [visible, active, refresh]);

  const contestantsById = useMemo(() => {
    const map = new Map<string, ChessContestant>();
    for (const contestant of catalog?.contestants ?? []) map.set(contestant.id, contestant);
    for (const row of snapshot?.standings ?? []) map.set(row.id, row.contestant);
    return map;
  }, [catalog, snapshot]);
  const name = useCallback((id: string | null) => (id ? contestantsById.get(id)?.displayName ?? id : "Bye"), [contestantsById]);

  const efforts = useMemo(
    () => [...new Set((catalog?.contestants ?? []).map((contestant) => contestant.reasoningEffort))].sort((a, b) => effortRank(a) - effortRank(b)),
    [catalog]
  );
  const shown = useMemo(
    () => (catalog?.contestants ?? []).filter((contestant) => providerOn[contestant.providerId] && effortOn[contestant.reasoningEffort]),
    [catalog, providerOn, effortOn]
  );
  const chosen = useMemo(() => shown.filter((contestant) => selected.has(contestant.id)), [shown, selected]);
  const providerGroups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, Map<string, ChessContestant[]>>();
    for (const contestant of shown) {
      if (needle && !`${contestant.modelName} ${contestant.modelId}`.toLowerCase().includes(needle)) continue;
      const rows = groups.get(contestant.providerId) ?? new Map<string, ChessContestant[]>();
      rows.set(contestant.modelId, [...(rows.get(contestant.modelId) ?? []), contestant]);
      groups.set(contestant.providerId, rows);
    }
    return (catalog?.providers ?? []).flatMap((provider) => {
      const rows = groups.get(provider.id);
      if (!rows) return [];
      const models = [...rows.values()].map((row) => row.sort((a, b) => effortRank(a.reasoningEffort) - effortRank(b.reasoningEffort)));
      return [{ provider, models, contestants: models.flat() }];
    });
  }, [shown, query, catalog]);

  const count = chosen.length;
  const plannedRounds = format === "swiss" ? Math.min(rounds ?? defaultRounds(count), Math.max(1, count - 1)) : Math.max(1, count % 2 ? count : count - 1);
  const games = format === "swiss" ? plannedRounds * Math.floor(count / 2) : (count * (count - 1)) / 2;
  // Only one side of a game thinks at a time, and each provider takes a bounded number of moves at once.
  const providerSlots = [...new Set(chosen.map((contestant) => contestant.providerId))].reduce(
    (sum, id) => sum + (catalog?.providers.find((provider) => provider.id === id)?.requestLimit ?? concurrency),
    0
  );
  const inFlight = Math.max(1, Math.min(concurrency, providerSlots || concurrency));
  const roughMinutes = Math.max(1, Math.round((games * maxPlies * Math.min(TYPICAL_MOVE_SECONDS, moveTimeoutMs / 1000)) / inFlight / 60));
  const slowLevelsChosen = chosen.some((contestant) => contestant.reasoningEffort === "max" || contestant.reasoningEffort === "ultra");

  const toggleContestant = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError("");
    try {
      const response = await benchmarkPost<{ tournament: ChessSnapshot | null }>(path, body);
      setSnapshot(response.tournament);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The request failed.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const unfinished = snapshot && !snapshot.active && (snapshot.status === "stopped" || snapshot.status === "interrupted");
  const launch = async () => {
    if (unfinished && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setConfirmReplace(false);
    setOpenGameId(null);
    setOpenGame(null);
    await act("/api/chess/benchmark/tournament/start", {
      contestantIds: chosen.map((contestant) => contestant.id),
      format,
      ...(format === "swiss" ? { rounds: plannedRounds } : {}),
      moveTimeoutMs,
      maxPlies,
      concurrency,
    });
  };

  const openDetail = (id: string) => {
    setOpenGameId(id);
    setOpenGame(null);
    openGameRef.current = id;
    void loadGame(id);
  };

  const champion = snapshot?.status === "completed" ? snapshot.standings[0] : undefined;
  const canLaunch = !busy && !active && count >= 2 && count <= MAX_CONTESTANTS;
  const statusText = !snapshot
    ? "No tournament yet"
    : snapshot.active
    ? `Live · round ${snapshot.round}/${snapshot.totalRounds}`
    : snapshot.status === "interrupted"
    ? "Interrupted by an API restart"
    : snapshot.status === "stopped"
    ? "Stopped"
    : "Completed";

  return (
    <section className="benchmark-game-panel chess-panel" aria-label="Chess AI Tournament">
      <div className="benchmark-game-heading">
        <div>
          <h2>Chess AI Tournament</h2>
          <p>
            Every model and reasoning level plays real chess. The server checks every move, and parallel games, a time limit per
            move and a move cap keep the tournament fast.
          </p>
        </div>
        <span className="benchmark-phase-badge" role="status">{statusText}</span>
      </div>

      <div className="chess-setup">
        {!active && (
          <>
          <div className="chess-presets" role="group" aria-label="Presets">
            <span>Presets</span>
            <button type="button" className="benchmark-quick-btn" disabled={!catalog} onClick={() => applyPreset("quick")}>
              Quick
            </button>
            <button type="button" className="benchmark-quick-btn" disabled={!catalog} onClick={() => applyPreset("full")}>
              Full
            </button>
            <small>
              Quick: provider defaults and low reasoning, 5 Swiss rounds, 20 moves each. Full: every reasoning level, automatic rounds,
              30 moves each.
            </small>
          </div>
          <fieldset className="benchmark-provider-picker chess-provider-picker">
            <legend>Providers</legend>
            {(catalog?.providers ?? []).map((provider) => {
              const id = provider.id;
              const check = provider.check;
              const detail = !provider.available
                ? provider.note ?? "Unavailable"
                : check
                ? check.ok
                  ? `${provider.count} contestants · check ok in ${seconds(check.latencyMs)}`
                  : `Check failed: ${check.error ?? "no answer"}`
                : `${provider.count} contestants`;
              return (
                <SpaceToggle
                  key={id}
                  className={`benchmark-provider-toggle${check && !check.ok ? " chess-provider-failed" : ""}`}
                  label={<strong>{provider.name}</strong>}
                  ariaLabel={`${provider.name} provider`}
                  detail={detail}
                  title={detail}
                  checked={Boolean(providerOn[id])}
                  disabled={active || !provider.available}
                  onChange={() => setProviderOn((current) => ({ ...current, [id]: !current[id] }))}
                />
              );
            })}
            <div className="chess-provider-actions">
              <button type="button" className="benchmark-quick-btn" disabled={active || checking || !catalog} onClick={() => void checkProviders()}>
                {checking ? "Checking providers…" : "Check providers"}
              </button>
              <span>One real move per provider proves sign-in, quota and answers. Failed providers are switched off.</span>
            </div>
          </fieldset>

          {efforts.length > 0 && (
            <fieldset className="benchmark-provider-picker">
              <legend>Reasoning levels</legend>
              {efforts.map((effort) => (
                <SpaceToggle
                  key={effort}
                  className="benchmark-provider-toggle chess-effort-toggle"
                  label={<strong>{effortLabel(effort)}</strong>}
                  ariaLabel={`Reasoning level ${effortLabel(effort)}`}
                  detail={`${(catalog?.contestants ?? []).filter((contestant) => contestant.reasoningEffort === effort).length} contestants`}
                  checked={Boolean(effortOn[effort])}
                  disabled={active}
                  onChange={() => setEffortOn((current) => ({ ...current, [effort]: !current[effort] }))}
                />
              ))}
            </fieldset>
          )}

          <div className="benchmark-contestants-picker">
            <div className="benchmark-contestants-bar">
              <span>Contestants ({count} selected of {shown.length} shown)</span>
              <button type="button" className="benchmark-quick-btn" disabled={active} onClick={() => setSelected(new Set(shown.map((contestant) => contestant.id)))}>
                All shown
              </button>
              <button type="button" className="benchmark-quick-btn" disabled={active} onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
            <input
              type="search"
              className="chess-model-search"
              placeholder="Filter models"
              aria-label="Filter models"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {catalogError && <p className="chess-notice error">{catalogError}</p>}
            {!catalog && !catalogError && <p className="chess-notice">Loading models and reasoning levels from every provider…</p>}
            <div className="chess-model-rows">
              {providerGroups.map(({ provider, models, contestants: groupContestants }) => {
                const picked = groupContestants.filter((contestant) => selected.has(contestant.id)).length;
                const setGroup = (on: boolean) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const contestant of groupContestants) {
                      if (on) next.add(contestant.id);
                      else next.delete(contestant.id);
                    }
                    return next;
                  });
                return (
                  <details key={provider.id} className="chess-provider-group" open={models.length <= FULL_SELECTION_MODELS || query.trim() !== ""}>
                    <summary>
                      <strong>{provider.name}</strong>
                      <span>
                        {picked} of {groupContestants.length} selected · {models.length} model{models.length === 1 ? "" : "s"}
                      </span>
                    </summary>
                    <div className="chess-provider-group-actions">
                      <button type="button" className="benchmark-quick-btn" onClick={() => setGroup(true)}>
                        Select all {provider.name}
                      </button>
                      <button type="button" className="benchmark-quick-btn" onClick={() => setGroup(false)}>
                        None
                      </button>
                    </div>
                    {models.map((row) => (
                      <div key={row[0]!.modelId} className="chess-model-row">
                        <span className="chess-model-name" title={row[0]!.modelId}>
                          {row[0]!.modelName}
                          <small>{row[0]!.modelId}</small>
                        </span>
                        <span className="chess-model-levels">
                          {row.map((contestant) => (
                            <button
                              type="button"
                              key={contestant.id}
                              className={`benchmark-chip ${selected.has(contestant.id) ? "selected" : ""}`}
                              aria-pressed={selected.has(contestant.id)}
                              aria-label={contestant.displayName}
                              onClick={() => toggleContestant(contestant.id)}
                            >
                              {effortLabel(contestant.reasoningEffort)}
                            </button>
                          ))}
                        </span>
                      </div>
                    ))}
                  </details>
                );
              })}
            </div>
          </div>

          <div className="chess-settings">
            <div className="chess-setting">
              <span>Format</span>
              <div className="chess-segmented" role="group" aria-label="Format">
                {(["swiss", "round_robin"] as const).map((value) => (
                  <button key={value} type="button" className={format === value ? "active" : ""} aria-pressed={format === value} disabled={active} onClick={() => setFormat(value)}>
                    {value === "swiss" ? "Swiss" : "Round robin"}
                  </button>
                ))}
              </div>
            </div>
            {format === "swiss" && (
              <label className="chess-setting">
                <span>Rounds</span>
                <input
                  className="benchmark-games-input"
                  type="number"
                  min={1}
                  max={Math.max(1, Math.min(30, count - 1))}
                  value={plannedRounds}
                  disabled={active}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setRounds(Number.isFinite(value) && value >= 1 ? Math.min(30, Math.round(value)) : null);
                  }}
                />
              </label>
            )}
            <div className="chess-setting">
              <span>Time per move</span>
              <div className="chess-segmented" role="group" aria-label="Time per move">
                {TIME_CONTROLS.map((control) => (
                  <button
                    key={control.ms}
                    type="button"
                    className={moveTimeoutMs === control.ms ? "active" : ""}
                    aria-pressed={moveTimeoutMs === control.ms}
                    disabled={active}
                    onClick={() => setMoveTimeoutMs(control.ms)}
                  >
                    {control.label} {control.ms / 1000}s
                  </button>
                ))}
              </div>
            </div>
            <label className="chess-setting">
              <span>Move cap</span>
              <select value={maxPlies} disabled={active} onChange={(event) => setMaxPlies(Number(event.target.value))}>
                {MOVE_CAPS.map((plies) => (
                  <option key={plies} value={plies}>{plies / 2} moves each</option>
                ))}
              </select>
            </label>
            <label className="chess-setting">
              <span>Parallel games</span>
              <select value={concurrency} disabled={active} onChange={(event) => setConcurrency(Number(event.target.value))}>
                {PARALLEL_GAMES.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>

          <p className="chess-estimate">
            {count} contestants · {games} games · {format === "swiss" ? `${plannedRounds} rounds · ` : ""}
            up to {(games * maxPlies).toLocaleString("en-US")} model calls · {inFlight} moves at a time · at most about {roughMinutes} min at{" "}
          {TYPICAL_MOVE_SECONDS} s per move. The move clock starts when the provider takes the request.
            At the move cap a game is decided on material (3 points or more), otherwise drawn.
          </p>
          {slowLevelsChosen && (
            <p className="chess-notice warning">
              max and ultra levels can need more than a minute per move. Under a short time limit they often lose on strikes.
            </p>
          )}
          {count > MAX_CONTESTANTS && <p className="chess-notice error">Choose at most {MAX_CONTESTANTS} contestants.</p>}
          </>
        )}

        <div className="benchmark-action-row">
          {confirmReplace ? (
            <div className="chess-confirm" role="alert">
              <span>An unfinished tournament exists. Launching a new one replaces it.</span>
              <button type="button" className="benchmark-launch-btn" disabled={!canLaunch} onClick={() => void launch()}>
                Replace and launch
              </button>
              <button type="button" className="benchmark-quick-btn" onClick={() => setConfirmReplace(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="benchmark-launch-btn" disabled={!canLaunch} onClick={() => void launch()}>
              {active ? "Tournament in progress…" : `Launch tournament (${count})`}
            </button>
          )}
          {active && (
            <button type="button" className="benchmark-reset" disabled={busy} onClick={() => void act("/api/chess/benchmark/tournament/stop")}>
              Stop
            </button>
          )}
          {unfinished && (
            <button type="button" className="benchmark-quick-btn" disabled={busy} onClick={() => void act("/api/chess/benchmark/tournament/resume")}>
              Resume
            </button>
          )}
          {snapshot && !active && (
            <button
              type="button"
              className="benchmark-reset"
              disabled={busy}
              onClick={() => {
                setOpenGameId(null);
                setOpenGame(null);
                void act("/api/chess/benchmark/tournament/reset");
              }}
            >
              Reset
            </button>
          )}
        </div>
        {error && <p className="chess-notice error" role="alert">{error}</p>}
      </div>

      {snapshot && (
        <>
          <div className="benchmark-live-match chess-progress">
            <strong>
              {snapshot.settings.format === "swiss" ? "Swiss" : "Round robin"} · round {snapshot.round}/{snapshot.totalRounds} ·{" "}
              {snapshot.totals.finished}/{snapshot.totals.games} games finished · {snapshot.totals.running} live ·{" "}
              {snapshot.totals.plies.toLocaleString("en-US")} moves played
            </strong>
            <span>
              {seconds(snapshot.settings.moveTimeoutMs)} per move · cap {snapshot.settings.maxPlies / 2} moves each ·{" "}
              {snapshot.settings.concurrency} parallel games
              {snapshot.error ? ` · Error: ${snapshot.error}` : ""}
            </span>
          </div>

          {champion && (
            <div className="chess-champion" role="status">
              Champion: <strong>{champion.contestant.displayName}</strong> · {formatPoints(champion.points)} points · Elo {Math.round(champion.elo)}
            </div>
          )}

          {openGameId && (
            <div className="chess-detail">
              <div className="chess-detail-board">
                <ChessBoard
                  fen={openGame?.fen ?? snapshot.liveGames.find((game) => game.id === openGameId)?.fen ?? "8/8/8/8/8/8/8/8 w - - 0 1"}
                  lastMove={openGame?.uci[openGame.uci.length - 1] ?? null}
                  label="Selected game"
                  coordinates
                />
              </div>
              <div className="chess-detail-info">
                <div className="chess-detail-head">
                  <strong>{openGame ? `${name(openGame.white)} vs ${name(openGame.black)}` : "Game"}</strong>
                  <button type="button" className="benchmark-quick-btn" onClick={() => setOpenGameId(null)}>
                    Close
                  </button>
                </div>
                {openGame ? (
                  <>
                    <span className="chess-detail-result">
                      Round {openGame.round} ·{" "}
                      {openGame.status === "finished"
                        ? `${openGame.result} · ${REASON_LABELS[openGame.reason ?? ""] ?? openGame.reason}`
                        : openGame.status === "running"
                        ? "In progress"
                        : "Waiting"}
                      {" · "}
                      {openGame.san.length} plies
                    </span>
                    <p className="chess-detail-moves">{openGame.san.length > 0 ? moveList(openGame.san) : "No moves yet."}</p>
                  </>
                ) : (
                  <span className="chess-detail-result">Loading game…</span>
                )}
              </div>
            </div>
          )}

          {snapshot.liveGames.length > 0 && (
            <div className="chess-live-grid" aria-label="Live games">
              {snapshot.liveGames.map((game) => (
                <GameCard key={game.id} game={game} name={name} onOpen={openDetail} />
              ))}
            </div>
          )}

          <div className="benchmark-ranking">
            <div className="benchmark-ranking-heading">
              <h3>Standings</h3>
              <span>Points, then Buchholz, wins and Elo</span>
            </div>
            <div className="benchmark-table-wrap">
              <table className="benchmark-table chess-standings">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Contestant</th>
                    <th>Points</th>
                    <th>W / D / L</th>
                    <th>Elo</th>
                    <th>Buchholz</th>
                    <th>Avg move</th>
                    <th>Illegal</th>
                    <th>Random moves</th>
                    <th>Forfeits</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.standings.map((row) => {
                    const moves = row.modelMoves + row.fallbackMoves;
                    return (
                      <tr key={row.id}>
                        <td><b>#{row.rank}</b></td>
                        <td className="benchmark-model-cell">
                          <strong>{row.contestant.modelName}</strong>
                          <small className="chess-effort-badge">{effortLabel(row.contestant.reasoningEffort)}</small>
                          <small className="chess-provider-label">{row.contestant.providerId}</small>
                        </td>
                        <td className="benchmark-avg"><strong>{formatPoints(row.points)}</strong></td>
                        <td>
                          {row.wins} / {row.draws} / {row.losses}
                          {row.byes > 0 ? <small> (+{row.byes} bye)</small> : null}
                        </td>
                        <td>{Math.round(row.elo)}</td>
                        <td>{formatPoints(row.buchholz)}</td>
                        <td>{moves > 0 ? seconds(row.totalLatencyMs / moves) : "—"}</td>
                        <td>{row.illegalReplies}</td>
                        <td>{row.fallbackMoves}</td>
                        <td>{row.forfeits}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {snapshot.recentGames.length > 0 && (
            <div className="benchmark-ranking">
              <div className="benchmark-ranking-heading">
                <h3>Recent results</h3>
                <span>Latest {snapshot.recentGames.length} games</span>
              </div>
              <div className="benchmark-table-wrap">
                <table className="benchmark-table">
                  <thead>
                    <tr>
                      <th>Round</th>
                      <th>White</th>
                      <th>Result</th>
                      <th>Black</th>
                      <th>Ending</th>
                      <th>Plies</th>
                      <th aria-label="Open game" />
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.recentGames.map((game) => (
                      <tr key={game.id}>
                        <td>{game.round}</td>
                        <td className="benchmark-model-cell">{name(game.white)}</td>
                        <td><strong>{game.result}</strong></td>
                        <td className="benchmark-model-cell">{name(game.black)}</td>
                        <td>{REASON_LABELS[game.reason ?? ""] ?? game.reason}</td>
                        <td>{game.plies}</td>
                        <td>
                          <button type="button" className="benchmark-quick-btn" onClick={() => openDetail(game.id)}>
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
