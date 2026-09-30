import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Gauge } from "../ui-theme/app-icons.js";
import { AsteroidsEngine } from "../asteroids/engine.js";
import { nextPilotControls, type TacticalProfile, type LivePilotDirective } from "../asteroids/ai-pilot.js";
import { MultiArenaEngine, type ArenaShip } from "../asteroids/multi-arena.js";
import { createRenderer } from "../asteroids/render.js";
import { observeArcadePalette } from "../asteroids/theme.js";
import "./benchmark-game.css";

// Direct same-origin fetch (no live-api.ts import): the demo bundle boundary
// forbids live-api.ts, so this page stays self-contained.
async function fetchBenchmarkLeaderboard(): Promise<BenchmarkLeaderboardResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("/api/benchmark/leaderboard", {
      credentials: "same-origin",
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return (await response.json()) as BenchmarkLeaderboardResponse;
  } finally {
    clearTimeout(timer);
  }
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

interface BenchmarkLeaderboardResponse {
  available: boolean;
  resultsDir: string;
  generatedAt: string;
  runs: BenchmarkRunRecord[];
}

interface AvailableModel {
  id: string;
  displayName: string;
  providerId: string;
  status?: string;
}

interface AsteroidsModelStats {
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

interface AsteroidsMatchRound {
  game: number;
  winner: string;
  scores: Record<string, { score: number; kills: number; accuracy: number; survival: number; tactic?: string }>;
}

interface AsteroidsChampionship {
  id: string;
  status: "ready" | "running" | "completed";
  startedAt: string;
  completedAt?: string;
  games: number;
  currentGame: number;
  models: AsteroidsModelStats[];
  gamesPlayed: AsteroidsMatchRound[];
}

type BenchmarkMode = "championship" | "duel" | "shared_arena";

let cachedCsrfToken: string | null = null;
let cachedCsrfHeader = "x-space-csrf-token";

async function fetchCsrf(): Promise<string> {
  if (cachedCsrfToken) return cachedCsrfToken;
  try {
    const res = await fetch("/api/auth/csrf", { credentials: "same-origin" });
    if (res.ok) {
      const data = (await res.json()) as { csrfToken?: string; headerName?: string };
      if (data.csrfToken) cachedCsrfToken = data.csrfToken;
      if (data.headerName) cachedCsrfHeader = data.headerName;
      return cachedCsrfToken || "";
    }
  } catch {}
  return "";
}

async function benchmarkPost<T>(url: string, body: unknown): Promise<T> {
  const token = await fetchCsrf();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers[cachedCsrfHeader] = token;

  let res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers,
    body: JSON.stringify(body),
  });

  if (res.status === 403) {
    cachedCsrfToken = null;
    const retryToken = await fetchCsrf();
    if (retryToken) headers[cachedCsrfHeader] = retryToken;
    res = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchAvailableModels(): Promise<AvailableModel[]> {
  const freeResponse = await fetch("/api/asteroids/benchmark/models", { credentials: "same-origin" });
  if (!freeResponse.ok) throw new Error(`HTTP ${freeResponse.status}`);
  const freePayload = (await freeResponse.json()) as { models?: AvailableModel[] };
  return [...new Map((freePayload.models ?? []).map((model) => [model.id, model])).values()];
}

const JEV_ID = "openrouter/typesafe/jev-1.13";

function extractTelemetry(game: AsteroidsEngine) {
  let closestDist = 9999;
  let closestHazardType = "rock";
  let hazardAngleDelta = 0;

  for (const rock of game.rocks) {
    const dx = rock.x - game.ship.x;
    const dy = rock.y - game.ship.y;
    const dist = Math.hypot(dx, dy);
    if (dist < closestDist) {
      closestDist = dist;
      closestHazardType = "rock";
      const targetAngle = Math.atan2(dy, dx);
      let delta = targetAngle - game.ship.angle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      hazardAngleDelta = delta;
    }
  }

  for (const enemy of game.enemies) {
    const dx = enemy.x - game.ship.x;
    const dy = enemy.y - game.ship.y;
    const dist = Math.hypot(dx, dy);
    if (dist < closestDist) {
      closestDist = dist;
      closestHazardType = "enemy";
      const targetAngle = Math.atan2(dy, dx);
      let delta = targetAngle - game.ship.angle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      hazardAngleDelta = delta;
    }
  }

  return {
    distanceToClosestHazard: closestDist === 9999 ? 300 : Math.round(closestDist),
    hazardType: closestHazardType,
    hazardAngleDelta: Math.round(hazardAngleDelta * 100) / 100,
    rocksCount: game.rocks.length,
    enemiesCount: game.enemies.length,
    hullHp: game.lives,
    shieldCharges: game.shield,
    bombsAvailable: game.bombs,
    isImmune: game.ship.immunity > 0,
    speed: Math.round(Math.hypot(game.ship.vx, game.ship.vy)),
    elapsedSeconds: Math.round(game.elapsed),
  };
}

function providerForModel(id: string): string {
  if (id.startsWith("codex/")) return "codex";
  if (id.startsWith("antigravity/")) return "antigravity";
  if (id.startsWith("github/")) return "github";
  if (id.startsWith("openrouter/")) return "openrouter";
  return "opencode";
}

function benchmarkSeed(mode: BenchmarkMode, round: number, modelIds: string[]): number {
  let value = 2166136261;
  for (const char of `${mode}:${round}:${modelIds.join("|")}`) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return value >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = Math.imul(state ^ (state >>> 15), 1 | state);
    state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
}

function GameBenchmark() {
  const [benchmarkMode, setBenchmarkMode] = useState<"championship" | "duel" | "shared_arena">("championship");
  const [duelOpponentCount, setDuelOpponentCount] = useState(3);
  const [liveDirectives, setLiveDirectives] = useState<Record<string, LivePilotDirective>>({});
  const [sharedShips, setSharedShips] = useState<ArenaShip[]>([]);
  const sharedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [modelsError, setModelsError] = useState("");
  const [games, setGames] = useState(3);
  const [enabledProviders, setEnabledProviders] = useState<Record<string, boolean>>({
    codex: true,
    opencode: true,
    antigravity: true,
    github: true,
    openrouter: true,
  });
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [skippedModels, setSkippedModels] = useState<string[]>([]);
  const [arenaContestants, setArenaContestants] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [gameNumber, setGameNumber] = useState(0);
  const [status, setStatus] = useState("Ready for AI Battle");
  const [currentScores, setCurrentScores] = useState<Record<string, number>>({});
  const [liveStats, setLiveStats] = useState<Record<string, { kills: number; accuracy: number }>>({});
  const [championship, setChampionship] = useState<AsteroidsChampionship | null>(null);
  const [tactics, setTactics] = useState<Record<string, TacticalProfile>>({});
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const diagnostics = useRef<(HTMLDivElement | null)[]>([]);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    void fetchAvailableModels()
      .then((available) => {
        setModels(available);
        const initial = available
          .filter((m) => enabledProviders[providerForModel(m.id)])
          .slice(0, 4)
          .map((m) => m.id);
        setSelectedModels(initial);
      })
      .catch((error) => setModelsError(error instanceof Error ? error.message : "Models could not be loaded."));

    void fetch(`/api/asteroids/benchmark/championship?mode=${benchmarkMode}`, { credentials: "same-origin" })
      .then((res) => res.json() as Promise<{ championship?: AsteroidsChampionship | null }>)
      .then(({ championship: loaded }) => {
        setChampionship(loaded ?? null);
      })
      .catch(() => undefined);

    return () => stopRef.current?.();
  }, [benchmarkMode]);

  useEffect(() => {
    if (benchmarkMode !== "shared_arena" || running) return;
    const canvas = sharedCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#080c14";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Subtle radar grid
    ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 48) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
    // Arena Title & info
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 20px 'Space Grotesk', system-ui, sans-serif";
    ctx.fillStyle = "#00f0ff";
    ctx.fillText("💥 ALL-IN-ONE DOGFIGHT BATTLE ROYALE", canvas.width / 2, canvas.height / 2 - 20);
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "#8899aa";
    ctx.fillText("All AI models fly & fight in ONE shared arena · Last AI Standing wins 1st Place Champion", canvas.width / 2, canvas.height / 2 + 14);
  }, [benchmarkMode, running]);

  const label = (id: string) => models.find((model) => model.id === id)?.displayName ?? id;

  const enabledModels = useMemo(
    () => models.filter((model) => enabledProviders[providerForModel(model.id)]).map((model) => model.id),
    [models, enabledProviders]
  );

  const leaderboardStandings = useMemo(() => {
    const baseModels = championship?.models ?? [];
    return [...baseModels].sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins);
  }, [championship]);

  const duelOpponents = useMemo(() => {
    const sortedFromChampionship = leaderboardStandings
      .filter((m) => m.id !== JEV_ID && enabledModels.includes(m.id))
      .map((m) => m.id);
    const pool = [
      ...sortedFromChampionship,
      ...enabledModels.filter((id) => id !== JEV_ID),
    ];
    return [...new Set(pool)].slice(0, duelOpponentCount);
  }, [leaderboardStandings, enabledModels, duelOpponentCount]);

  const duelContestants = useMemo(() => {
    return [JEV_ID, ...duelOpponents];
  }, [duelOpponents]);

  const activeContestants = useMemo(() => {
    if (benchmarkMode === "duel" || benchmarkMode === "shared_arena") {
      return duelContestants;
    }
    const filtered = selectedModels.filter((id) => enabledModels.includes(id));
    return filtered.length > 0 ? filtered : enabledModels.slice(0, 4);
  }, [benchmarkMode, duelContestants, selectedModels, enabledModels]);

  // Arenas follow the roster that actually flies this battle (models without a
  // live doctrine are skipped), so canvas index i always matches engine i.
  const displayedContestants = arenaContestants.length > 0 ? arenaContestants : activeContestants;

  const toggleModel = (id: string) => {
    if (running) return;
    setSelectedModels((prev) => {
      if (prev.includes(id)) {
        return prev.length > 2 ? prev.filter((m) => m !== id) : prev;
      }
      return [...prev, id];
    });
  };

  const selectTop = (count: number) => {
    if (running) return;
    setSelectedModels(enabledModels.slice(0, count));
  };

  const selectAll = () => {
    if (running) return;
    setSelectedModels(enabledModels);
  };

  const start = async () => {
    const contestants = activeContestants;
    if (contestants.length < 2 || running) return;

    stopRef.current?.();
    setRunning(true);
    setLiveDirectives({});
    setSkippedModels([]);
    setGameNumber(1);
    setStatus(
      benchmarkMode === "duel"
        ? `Preparing Jev AI Duel (1 vs ${contestants.length - 1})…`
        : "Consulting AI neural cores for combat doctrines…"
    );

    const nextTactics: Record<string, TacticalProfile> = { ...tactics };
    try {
      const data = await benchmarkPost<{ doctrines?: Record<string, TacticalProfile> }>(
        "/api/asteroids/benchmark/tactics",
        { models: contestants, situation: { rocks: 8, difficulty: 4 } }
      );
      if (data.doctrines) {
        for (const [id, doc] of Object.entries(data.doctrines)) {
          nextTactics[id] = doc;
        }
        const missing = contestants.filter((id) => !nextTactics[id]);
        if (missing.length > 0) {
          await Promise.all(
            missing.map(async (modelId) => {
              try {
                const res = await benchmarkPost<{ tactics?: TacticalProfile }>(
                  "/api/asteroids/benchmark/tactics",
                  { modelId, situation: { rocks: 8, difficulty: 4 } }
                );
                if (res.tactics) nextTactics[modelId] = res.tactics;
              } catch {}
            })
          );
        }
      }
    } catch {
      await Promise.all(
        contestants.map(async (modelId) => {
          try {
            const res = await benchmarkPost<{ tactics?: TacticalProfile }>(
              "/api/asteroids/benchmark/tactics",
              { modelId, situation: { rocks: 8, difficulty: 4 } }
            );
            if (res.tactics) nextTactics[modelId] = res.tactics;
          } catch {}
        })
      );
    }
    setTactics(nextTactics);
    // Only models with a live doctrine from this run may fly: a model that cannot
    // produce one right now (no runtime path, provider outage, rate limit) is
    // skipped instead of aborting the whole battle with a blocked status.
    const skipped = contestants.filter((modelId) => nextTactics[modelId]?.source !== "model");
    const runContestants = contestants.filter((modelId) => nextTactics[modelId]?.source === "model");
    if (runContestants.length < 2) {
      setRunning(false);
      setStatus(`Benchmark blocked: live model doctrine unavailable for ${skipped.map(label).join(", ")}.`);
      return;
    }
    setSkippedModels(skipped);
    setArenaContestants(runContestants);

    let cancelled = false;
    let matchIndex = 0;

    const runGame = () => {
      if (cancelled) return;
      matchIndex += 1;
      setGameNumber(matchIndex);

      if (benchmarkMode === "shared_arena") {
        const canvas = sharedCanvasRef.current;
        if (!canvas) {
          setStatus("Battle Royale canvas is unavailable.");
          setRunning(false);
          return;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          setStatus("Canvas 2D context is unavailable.");
          setRunning(false);
          return;
        }

        const arena = new MultiArenaEngine(
          canvas.clientWidth || 960,
          canvas.clientHeight || 540,
          seededRandom(benchmarkSeed(benchmarkMode, matchIndex, runContestants))
        );
        arena.initMatch(
          runContestants.map((id) => ({
            id,
            name: label(id),
            provider: providerForModel(id),
            tactic: nextTactics[id] || {
              aggression: 0.8,
              precision: 0.85,
              mobility: 0.85,
              leadAiming: 0.8,
              targetPreference: "threat",
              tactic: "Dogfight combat patrol",
              source: "model",
            },
            isJev: id === JEV_ID,
          }))
        );
        setSharedShips([...arena.ships]);

        let frame = 0;
        let elapsed = 0;
        let lastTelemetry = performance.now();
        let lastDirectivePoll = 0;
        let directiveInFlight = false;
        let lastTime = 0;

        const tickShared = (time: number) => {
          if (cancelled) return;
          if (!lastTime) lastTime = time;
          const dt = Math.min((time - lastTime) / 1000, 0.05);
          lastTime = time;
          elapsed += dt;

          arena.step(dt);
          arena.render(ctx);

          const now = performance.now();
          if (now - lastTelemetry >= 250) {
            setSharedShips([...arena.ships]);
            lastTelemetry = now;
          }

          if (now - lastDirectivePoll >= 1000 && !directiveInFlight) {
            lastDirectivePoll = now;
            directiveInFlight = true;
            const jevShip = arena.ships.find((s) => s.isJev);
            if (jevShip && jevShip.alive) {
              let closestDist = 9999;
              let closestType = "rock";
              let closestAngle = 0;

              for (const r of arena.rocks) {
                const dx = ((r.x - jevShip.x + arena.width / 2) % arena.width + arena.width) % arena.width - arena.width / 2;
                const dy = ((r.y - jevShip.y + arena.height / 2) % arena.height + arena.height) % arena.height - arena.height / 2;
                const d = Math.hypot(dx, dy);
                if (d < closestDist) {
                  closestDist = d;
                  closestType = "rock";
                  closestAngle = Math.atan2(dy, dx);
                }
              }
              for (const other of arena.ships) {
                if (other.id !== jevShip.id && other.alive) {
                  const dx = ((other.x - jevShip.x + arena.width / 2) % arena.width + arena.width) % arena.width - arena.width / 2;
                  const dy = ((other.y - jevShip.y + arena.height / 2) % arena.height + arena.height) % arena.height - arena.height / 2;
                  const d = Math.hypot(dx, dy);
                  if (d < closestDist) {
                    closestDist = d;
                    closestType = "enemy";
                    closestAngle = Math.atan2(dy, dx);
                  }
                }
              }

              let hazardDelta = closestAngle - jevShip.angle;
              while (hazardDelta > Math.PI) hazardDelta -= Math.PI * 2;
              while (hazardDelta < -Math.PI) hazardDelta += Math.PI * 2;

              const telemetry = {
                distanceToClosestHazard: closestDist === 9999 ? 300 : Math.round(closestDist),
                hazardType: closestType,
                hazardAngleDelta: Math.round(hazardDelta * 100) / 100,
                rocksCount: arena.rocks.length,
                enemiesCount: arena.ships.filter((s) => !s.isJev && s.alive).length,
                hullHp: jevShip.hp,
                shieldCharges: jevShip.shield,
                bombsAvailable: jevShip.bombs,
                isImmune: jevShip.immunity > 0,
                speed: Math.round(Math.hypot(jevShip.vx, jevShip.vy)),
                elapsedSeconds: Math.round(elapsed),
              };

              benchmarkPost<{ directive?: LivePilotDirective }>(
                "/api/asteroids/benchmark/live-directive",
                { modelId: JEV_ID, telemetry }
              )
                .then((res) => {
                  if (res.directive) {
                    jevShip.liveDirective = res.directive;
                    setLiveDirectives((prev) => ({ ...prev, [JEV_ID]: res.directive! }));
                  }
                })
                .catch(() => undefined)
                .finally(() => {
                  directiveInFlight = false;
                });
            } else {
              directiveInFlight = false;
            }
          }

          const aliveCount = arena.ships.filter((s) => s.alive).length;
          setStatus(`Dogfight Battle Royale · Round ${matchIndex}/${games} · Time: ${Math.round(elapsed)}s/45s · ${aliveCount}/${arena.ships.length} Alive`);

          if (elapsed >= 45 || aliveCount <= 1) {
            // Assign remaining survivors
            const stillAlive = arena.ships.filter((s) => s.alive).sort((a, b) => b.score - a.score || b.hp - a.hp);
            stillAlive.forEach((s, idx) => {
              // Ships eliminated during the match already received their
              // survival rank/bonus. The last-survivor path also marks the
              // winner, so only award timeout bonuses to unranked survivors.
              if (s.survivalRank) return;
              s.survivalRank = idx + 1;
              if (idx === 0) s.score += 5000;
              else if (idx === 1) s.score += 2500;
              else if (idx === 2) s.score += 1200;
            });

            // Sort all ships by survival rank (1st, 2nd, 3rd...)
            const rankedArenaShips = [...arena.ships].sort((a, b) => (a.survivalRank || 99) - (b.survivalRank || 99) || b.score - a.score);
            setSharedShips(rankedArenaShips);

            const winner = rankedArenaShips[0];
            const results = rankedArenaShips.map((s) => ({
              modelId: s.id,
              displayName: s.name,
              providerId: s.provider,
              score: s.score,
              kills: s.asteroidKills + s.pvpKills,
              accuracy: s.shotsFired > 0 ? Math.round((s.shotsHit / s.shotsFired) * 100) : 50,
              survival: s.eliminatedAt !== null ? Math.round(s.eliminatedAt) : Math.round(elapsed),
              tactic: s.tactic?.tactic,
              latencyMs: s.tactic?.latencyMs,
              source: s.tactic?.source ?? "fallback",
            }));

            // 1. Immediately update client championship state with real scores
            setChampionship((prev) => {
              const current: AsteroidsChampionship = prev
                ? { ...prev, models: prev.models.map((m) => ({ ...m })), gamesPlayed: [...prev.gamesPlayed] }
                : {
                    id: `asteroids-${Date.now()}`,
                    status: matchIndex >= games ? "completed" : "running",
                    startedAt: new Date().toISOString(),
                    games,
                    currentGame: matchIndex,
                    models: [],
                    gamesPlayed: [],
                  };
              current.currentGame = matchIndex;
              current.status = matchIndex >= games ? "completed" : "running";
              if (current.status === "completed") current.completedAt = new Date().toISOString();

              const map = new Map<string, AsteroidsModelStats>(current.models.map((m) => [m.id, m]));
              for (const res of results) {
                const prevModel = map.get(res.modelId) ?? {
                  id: res.modelId,
                  displayName: res.displayName,
                  providerId: res.providerId,
                  wins: 0,
                  gamesPlayed: 0,
                  totalScore: 0,
                  bestScore: 0,
                  totalKills: 0,
                  avgAccuracy: 0,
                  totalSurvivalSeconds: 0,
                };
                if (res.modelId === winner?.id) prevModel.wins += 1;
                prevModel.gamesPlayed += 1;
                prevModel.totalScore += res.score;
                prevModel.bestScore = Math.max(prevModel.bestScore, res.score);
                prevModel.totalKills += res.kills;
                prevModel.totalSurvivalSeconds += res.survival;
                prevModel.avgAccuracy = Math.round(
                  (prevModel.avgAccuracy * (prevModel.gamesPlayed - 1) + res.accuracy) / prevModel.gamesPlayed
                );
                if (res.tactic) prevModel.lastTactic = res.tactic;
                if (res.latencyMs !== undefined) prevModel.lastLatencyMs = res.latencyMs;
                prevModel.lastSource = res.source;
                map.set(res.modelId, prevModel);
              }
              current.models = [...map.values()].sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins);
              return current;
            });

            // 2. Persist to server in background
            void benchmarkPost<{ championship?: AsteroidsChampionship }>("/api/asteroids/benchmark/record-match", {
              round: matchIndex,
              totalRounds: games,
              mode: benchmarkMode,
              winnerId: winner?.id ?? "",
              results,
            })
              .then((payload) => {
                if (payload.championship) setChampionship(payload.championship);
              })
              .catch((err) => console.warn("Record match error:", err));

            if (matchIndex >= games) {
              setRunning(false);
              setStatus(`Battle Royale Complete · 👑 1st Survivor: ${winner?.name ?? "Draw"}`);
              return;
            }

            window.setTimeout(runGame, 1600);
            return;
          }

          frame = requestAnimationFrame(tickShared);
        };

        frame = requestAnimationFrame(tickShared);
        stopRef.current = () => {
          cancelled = true;
          cancelAnimationFrame(frame);
        };
        return;
      }

      if (runContestants.some((_, index) => !canvases.current[index])) return;

      const unobserves: (() => void)[] = [];
      const engines = runContestants.map((modelId, index) => {
        const canvas = canvases.current[index]!;
        const game = new AsteroidsEngine(
          canvas.clientWidth || 480,
          canvas.clientHeight || 300,
          seededRandom(benchmarkSeed(benchmarkMode, matchIndex, [modelId]))
        );
        game.start(1);
        const renderer = createRenderer(canvas, game, { watermark: false });
        renderer?.resize(canvas.clientWidth || 480, canvas.clientHeight || 300);
        if (renderer) {
          unobserves.push(observeArcadePalette(canvas, (palette) => renderer.setPalette(palette)));
        }
        return { modelId, game, renderer, index };
      });

      if (engines.some((entry) => !entry.renderer)) {
        setStatus("Canvas is unavailable.");
        setRunning(false);
        unobserves.forEach((u) => u());
        return;
      }

      let frame = 0;
      let elapsed = 0;
      let frameCount = 0;
      let lastTelemetry = performance.now();
      let lastTime = 0;
      let lastDirectivePoll = 0;
      let directiveInFlight = false;

      const tick = (time: number) => {
        if (cancelled) {
          unobserves.forEach((u) => u());
          return;
        }
        if (!lastTime) lastTime = time;
        const dt = Math.min((time - lastTime) / 1000, 0.05);
        lastTime = time;
        elapsed += dt;

        for (const entry of engines) {
          const tactic = nextTactics[entry.modelId] || entry.modelId;
          const controls = nextPilotControls(entry.game, tactic);
          if (entry.game.phase === "playing") entry.game.step(dt, controls);
          entry.renderer?.draw(controls, false);

          const isJev = entry.modelId === JEV_ID || entry.modelId.includes("jev");
          if (isJev && entry.game.phase === "playing") {
            const canvas = canvases.current[entry.index];
            const ctx = canvas?.getContext("2d");
            if (ctx) {
              ctx.save();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              const dir = nextTactics[entry.modelId]?.liveDirective;
              ctx.fillStyle = "rgba(0, 16, 30, 0.88)";
              ctx.strokeStyle = "#00f0ff";
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.roundRect(8, 8, 250, 36, 6);
              ctx.fill();
              ctx.stroke();

              ctx.fillStyle = "#00f0ff";
              ctx.font = "bold 10px monospace";
              ctx.fillText("⚡ TYPESAFE JEV 1.13 · NEURAL LIVE", 16, 22);

              ctx.fillStyle = dir ? "#ffe600" : "#9aa4b2";
              ctx.font = "9px monospace";
              ctx.fillText(
                dir ? `[${dir.action.toUpperCase()}] · ${dir.latencyMs}ms · CONF 95%` : "CONNECTING OPENROUTER...",
                16,
                36
              );
              ctx.restore();
            }
          }
        }

        const scoresObj: Record<string, number> = {};
        const statsObj: Record<string, { kills: number; accuracy: number }> = {};
        for (const entry of engines) {
          scoresObj[entry.modelId] = entry.game.score;
          statsObj[entry.modelId] = {
            kills: entry.game.kills,
            accuracy: Math.round(entry.game.accuracy * 100),
          };
        }
        setCurrentScores(scoresObj);
        setLiveStats(statsObj);
        setStatus(
          benchmarkMode === "duel"
            ? `⚡ Duel Round ${matchIndex}/${games} · Jev vs Top ${runContestants.length - 1} · Time: ${Math.round(elapsed)}s/35s`
            : `Round ${matchIndex}/${games} · Time: ${Math.round(elapsed)}s/35s`
        );

        frameCount += 1;
        const now = performance.now();
        if (now - lastTelemetry >= 300) {
          const fps = Math.round((frameCount * 1000) / (now - lastTelemetry));
          engines.forEach((entry) => {
            const node = diagnostics.current[entry.index];
            if (node) {
              const dir = nextTactics[entry.modelId]?.liveDirective;
              const dirText = dir ? ` · [${dir.action}]` : "";
              node.textContent = `FPS: ${fps} · Score: ${entry.game.score} · Kills: ${entry.game.kills} · Acc: ${Math.round(entry.game.accuracy * 100)}%${dirText}`;
            }
          });
          frameCount = 0;
          lastTelemetry = now;
        }

        // Real-time AI directive polling
        if (now - lastDirectivePoll >= 1000 && !directiveInFlight) {
          lastDirectivePoll = now;
          directiveInFlight = true;
          const targetContestants =
            benchmarkMode === "duel"
              ? engines
              : engines.filter((e) => e.modelId === JEV_ID || e.modelId.includes("jev"));

          Promise.all(
            targetContestants.map(async (entry) => {
              try {
                const telemetry = extractTelemetry(entry.game);
                const res = await benchmarkPost<{ directive?: LivePilotDirective }>(
                  "/api/asteroids/benchmark/live-directive",
                  { modelId: entry.modelId, telemetry }
                );
                if (res.directive) {
                  const currentTactic = nextTactics[entry.modelId] || {
                    aggression: 0.79,
                    precision: 0.88,
                    mobility: 0.89,
                    leadAiming: 0.85,
                    targetPreference: "threat",
                    tactic: "Reactive dogfight navigation",
                    source: "model",
                  };
                  nextTactics[entry.modelId] = {
                    ...currentTactic,
                    liveDirective: res.directive,
                  };
                  setLiveDirectives((prev) => ({ ...prev, [entry.modelId]: res.directive! }));
                }
              } catch {}
            })
          ).finally(() => {
            directiveInFlight = false;
          });
        }

        if (elapsed >= 35 || engines.every((entry) => entry.game.phase !== "playing")) {
          unobserves.forEach((u) => u());
          const winner = [...engines].sort((a, b) => b.game.score - a.game.score)[0];
          const results = engines.map((e) => ({
            modelId: e.modelId,
            displayName: label(e.modelId),
            providerId: providerForModel(e.modelId),
            score: e.game.score,
            kills: e.game.kills,
            accuracy: Math.round(e.game.accuracy * 100),
            survival: Math.round(e.game.elapsed),
            tactic: nextTactics[e.modelId]?.tactic,
            latencyMs: nextTactics[e.modelId]?.latencyMs,
            source: nextTactics[e.modelId]?.source ?? "fallback",
          }));

          // 1. Immediately update client championship state with real scores
          setChampionship((prev) => {
            const current: AsteroidsChampionship = prev
              ? { ...prev, models: prev.models.map((m) => ({ ...m })), gamesPlayed: [...prev.gamesPlayed] }
              : {
                  id: `asteroids-${Date.now()}`,
                  status: matchIndex >= games ? "completed" : "running",
                  startedAt: new Date().toISOString(),
                  games,
                  currentGame: matchIndex,
                  models: [],
                  gamesPlayed: [],
                };
            current.currentGame = matchIndex;
            current.status = matchIndex >= games ? "completed" : "running";
            if (current.status === "completed") current.completedAt = new Date().toISOString();

            const map = new Map<string, AsteroidsModelStats>(current.models.map((m) => [m.id, m]));
            for (const res of results) {
              const prevModel = map.get(res.modelId) ?? {
                id: res.modelId,
                displayName: res.displayName,
                providerId: res.providerId,
                wins: 0,
                gamesPlayed: 0,
                totalScore: 0,
                bestScore: 0,
                totalKills: 0,
                avgAccuracy: 0,
                totalSurvivalSeconds: 0,
              };
              if (res.modelId === winner?.modelId) prevModel.wins += 1;
              prevModel.gamesPlayed += 1;
              prevModel.totalScore += res.score;
              prevModel.bestScore = Math.max(prevModel.bestScore, res.score);
              prevModel.totalKills += res.kills;
              prevModel.totalSurvivalSeconds += res.survival;
              prevModel.avgAccuracy = Math.round(
                (prevModel.avgAccuracy * (prevModel.gamesPlayed - 1) + res.accuracy) / prevModel.gamesPlayed
              );
              if (res.tactic) prevModel.lastTactic = res.tactic;
              if (res.latencyMs !== undefined) prevModel.lastLatencyMs = res.latencyMs;
              prevModel.lastSource = res.source;
              map.set(res.modelId, prevModel);
            }
            current.models = [...map.values()].sort((a, b) => b.totalScore - a.totalScore || b.wins - a.wins);
            return current;
          });

          // 2. Persist to server in background
          void benchmarkPost<{ championship?: AsteroidsChampionship }>("/api/asteroids/benchmark/record-match", {
            round: matchIndex,
            totalRounds: games,
            mode: benchmarkMode,
            winnerId: winner?.modelId ?? "",
            results,
          })
            .then((payload) => {
              if (payload.championship) setChampionship(payload.championship);
            })
            .catch((err) => console.warn("Record match error:", err));

          if (matchIndex >= games) {
            setRunning(false);
            setLiveStats({});
            setCurrentScores({});
            setStatus(
              benchmarkMode === "duel"
                ? `Duel Complete · Winner: ${label(winner?.modelId ?? "")}`
                : `Championship Complete · Champion: ${label(winner?.modelId ?? "")}`
            );
            return;
          }

          window.setTimeout(runGame, 1200);
          return;
        }

        frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);
      stopRef.current = () => {
        cancelled = true;
        unobserves.forEach((u) => u());
        cancelAnimationFrame(frame);
      };
    };

    runGame();
  };

  const resetData = () => {
    if (running) return;
    void benchmarkPost("/api/asteroids/benchmark/championship/reset", { mode: benchmarkMode })
      .then(() => {
        setChampionship(null);
        setCurrentScores({});
        setLiveStats({});
        setLiveDirectives({});
        setGameNumber(0);
        setStatus("Ready for AI Battle");
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : "Reset failed."));
  };


  const rankedModels: AsteroidsModelStats[] = useMemo(() => {
    const baseModels = championship?.models ?? [];
    const baseMap = new Map(baseModels.map((m) => [m.id, m]));

    for (const id of activeContestants) {
      if (!baseMap.has(id)) {
        baseMap.set(id, {
          id,
          displayName: label(id),
          providerId: providerForModel(id),
          wins: 0,
          gamesPlayed: 0,
          totalScore: 0,
          bestScore: 0,
          totalKills: 0,
          avgAccuracy: 0,
          totalSurvivalSeconds: 0,
          lastTactic: undefined,
          lastLatencyMs: undefined,
        });
      }
    }

    return [...baseMap.values()].sort((a, b) => {
      const liveA = (running ? currentScores[a.id] : 0) || 0;
      const liveB = (running ? currentScores[b.id] : 0) || 0;
      return (b.totalScore + liveB) - (a.totalScore + liveA) || b.wins - a.wins;
    });
  }, [championship, activeContestants, models, running, currentScores]);

  return (
    <section className="benchmark-game-panel">
      <div className="benchmark-game-heading">
        <div>
          <h2>Asteroids AI Challenge</h2>
          <p>Real-time AI dogfight benchmark — genuine flight doctrines, live physics, authentic scores.</p>
        </div>
        <span className="benchmark-phase-badge">
          {running
            ? benchmarkMode === "shared_arena"
              ? `ROYALE · ${gameNumber}/${games}`
              : benchmarkMode === "duel"
              ? `DUEL · ${gameNumber}/${games}`
              : `BATTLE · ${gameNumber}/${games}`
            : status}
        </span>
      </div>

      <div className="benchmark-mode-nav">
        <button
          type="button"
          className={`benchmark-mode-btn ${benchmarkMode === "championship" ? "active" : ""}`}
          onClick={() => { if (!running) setBenchmarkMode("championship"); }}
          disabled={running}
        >
          🏆 Championship Benchmark
        </button>
        <button
          type="button"
          className={`benchmark-mode-btn ${benchmarkMode === "duel" ? "active" : ""}`}
          onClick={() => { if (!running) setBenchmarkMode("duel"); }}
          disabled={running}
        >
          ⚡ Real-Time Duel (Split Arenas)
        </button>
        <button
          type="button"
          className={`benchmark-mode-btn ${benchmarkMode === "shared_arena" ? "active" : ""}`}
          onClick={() => { if (!running) setBenchmarkMode("shared_arena"); }}
          disabled={running}
          style={benchmarkMode === "shared_arena" ? { borderColor: "#00f0ff", color: "#00f0ff", boxShadow: "0 0 10px rgba(0,240,255,0.2)" } : {}}
        >
          💥 All-in-One Arena (Όλοι στο ίδιο game)
        </button>
      </div>

      <div className="benchmark-game-settings">
        {benchmarkMode === "shared_arena" ? (
          <div className="benchmark-duel-banner" style={{ background: "linear-gradient(90deg, rgba(0,240,255,0.14), rgba(255,100,50,0.12))", borderColor: "rgba(0,240,255,0.4)" }}>
            <div>
              <strong style={{ color: "#00f0ff" }}>💥 Dogfight Battle Royale · All AI Models in ONE Shared Game</strong>
              <span>
                Όλα τα AI μοντέλα πετούν στον <b>ίδιο χώρο μάχης</b>, πυροβολούν το ένα το άλλο και αποφεύγουν αστεροειδείς! Το τελευταίο μοντέλο που επιβιώνει ανακηρύσσεται <b>Survivor Champion</b>, ενώ καταγράφονται επακριβώς η 1η, 2η και 3η θέση επιβίωσης και τα hits/kills.
              </span>
            </div>
            <div className="benchmark-duel-quickbar">
              <span style={{ fontWeight: 600, fontSize: "0.8rem" }}>Matchup:</span>
              {[1, 2, 3, 4, 5, 6].map((count) => (
                <button
                  type="button"
                  key={count}
                  className={`benchmark-quick-btn ${duelOpponentCount === count ? "selected" : ""}`}
                  style={duelOpponentCount === count ? { background: "#00f0ff", color: "#000", fontWeight: 700 } : {}}
                  onClick={() => { if (!running) setDuelOpponentCount(count); }}
                  disabled={running}
                >
                  {count === 6 ? "Jev vs All Top 6" : `1 vs ${count} ${count === 1 ? "(Top #1)" : `(Top #${count})`}`}
                </button>
              ))}
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #9aa4b2)" }}>
              Contestants in Arena ({duelOpponents.length + 1}): <b style={{ color: "#00f0ff" }}>TypeSafe Jev 1.13</b> vs{" "}
              <b>{duelOpponents.map((id) => label(id)).join(", ") || "Loading opponents…"}</b>
            </div>
          </div>
        ) : benchmarkMode === "duel" ? (
          <div className="benchmark-duel-banner">
            <div>
              <strong>⚡ TypeSafe Jev 1.13 Real-Time AI Duel</strong>
              <span>
                Live reactive guidance: Jev queries live OpenRouter neural directives (~300ms) during flight to execute emergency dashes and tactical bombs against the top championship models.
              </span>
            </div>
            <div className="benchmark-duel-quickbar">
              <span style={{ fontWeight: 600, fontSize: "0.8rem" }}>Matchup:</span>
              {[1, 2, 3, 4, 5, 6].map((count) => (
                <button
                  type="button"
                  key={count}
                  className={`benchmark-quick-btn ${duelOpponentCount === count ? "selected" : ""}`}
                  style={duelOpponentCount === count ? { background: "var(--accent, #8ee6ff)", color: "#000", fontWeight: 700 } : {}}
                  onClick={() => { if (!running) setDuelOpponentCount(count); }}
                  disabled={running}
                >
                  1 vs {count} {count === 1 ? "(Top #1)" : `(Top #${count})`}
                </button>
              ))}
            </div>
            <div style={{ fontSize: "0.78rem", color: "var(--text-muted, #9aa4b2)" }}>
              Contestants: <b style={{ color: "var(--accent, #8ee6ff)" }}>TypeSafe Jev 1.13</b> vs{" "}
              <b>{duelOpponents.map((id) => label(id)).join(", ") || "Loading opponents…"}</b>
            </div>
          </div>
        ) : (
          <>
            <fieldset className="benchmark-provider-picker">
              <legend>Providers · {enabledModels.length} models active</legend>
              {(["codex", "opencode", "antigravity", "openrouter", "github"] as const).map((provider) => {
                const count = models.filter((model) => providerForModel(model.id) === provider).length;
                const name =
                  provider === "codex"
                    ? "Codex"
                    : provider === "opencode"
                    ? "OpenCode"
                    : provider === "antigravity"
                    ? "Antigravity"
                    : provider === "openrouter"
                    ? "OpenRouter"
                    : "GitHub CLI";
                return (
                  <label className="benchmark-provider-toggle" key={provider}>
                    <input
                      type="checkbox"
                      checked={enabledProviders[provider]}
                      disabled={running || count === 0}
                      onChange={() => setEnabledProviders((current) => ({ ...current, [provider]: !current[provider] }))}
                    />
                    <span className="benchmark-switch" aria-hidden="true" />
                    <span>
                      <strong>{name}</strong>
                      <small>{count} models</small>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            <div className="benchmark-contestants-picker">
              <div className="benchmark-contestants-bar">
                <span>Contestants ({activeContestants.length} selected):</span>
                <button type="button" className="benchmark-quick-btn" onClick={() => selectTop(4)} disabled={running}>Top 4</button>
                <button type="button" className="benchmark-quick-btn" onClick={() => selectTop(6)} disabled={running}>Top 6</button>
                <button type="button" className="benchmark-quick-btn" onClick={selectAll} disabled={running}>All</button>
              </div>
              <div className="benchmark-chips-wrap">
                {enabledModels.map((id) => {
                  const isSelected = activeContestants.includes(id);
                  return (
                    <button
                      type="button"
                      key={id}
                      className={`benchmark-chip ${isSelected ? "selected" : ""}`}
                      onClick={() => toggleModel(id)}
                      disabled={running}
                    >
                      {label(id)}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        <div className="benchmark-action-row">
          <label>
            Rounds (1–20)
            <input
              className="benchmark-games-input"
              type="number"
              min={1}
              max={20}
              step={1}
              value={games}
              onChange={(event) => setGames(Math.max(1, Math.min(20, Number(event.target.value) || 1)))}
              disabled={running}
            />
          </label>
          <button
            type="button"
            className="benchmark-launch-btn"
            onClick={start}
            disabled={running || activeContestants.length < 2}
          >
            {running
              ? benchmarkMode === "shared_arena"
                ? "Battle Royale In Progress…"
                : benchmarkMode === "duel"
                ? "Duel In Progress…"
                : "Battle In Progress…"
              : benchmarkMode === "shared_arena"
              ? `Launch All-in-One Arena (${duelOpponents.length + 1} Ships)`
              : benchmarkMode === "duel"
              ? `Launch 1 vs ${duelOpponentCount} AI Duel`
              : "Launch AI Battle"}
          </button>
          <button type="button" className="benchmark-reset" onClick={resetData} disabled={running}>
            Reset Data
          </button>
        </div>
      </div>

      {modelsError && <p className="benchmark-status benchmark-error">{modelsError}</p>}
      {skippedModels.length > 0 && (
        <p className="benchmark-status benchmark-skipped" role="status">
          Skipped {skippedModels.length} model{skippedModels.length === 1 ? "" : "s"} without a live doctrine this battle:{" "}
          {skippedModels.map((id) => label(id)).join(", ")}. They stay selected but do not fly.
        </p>
      )}
      {!modelsError && models.length === 0 && <p className="benchmark-status">Loading available models…</p>}

      <div className="benchmark-ranking">
        <div className="benchmark-ranking-heading">
          <h3>Leaderboard · {benchmarkMode === "duel" ? "Real-Time AI Duel" : "Championship"} (Real Metrics)</h3>
          <span>{running ? `Round ${gameNumber}/${games}` : status}</span>
        </div>
        <div className="benchmark-live-match">
          <strong>
            {running
              ? `Live Battle Round ${gameNumber} · ${displayedContestants.length} AI pilots in combat`
              : "Authentic benchmark: each model's score is recorded directly from Asteroids physics & kills."}
          </strong>
          <span>
            {running
              ? "Live scores update dynamically from ship lasers, asteroid destructions, and survival time."
              : "Rankings are determined by total score, wins, and kill accuracy."}
          </span>
        </div>

        <div className="benchmark-table-wrap">
          <table className="benchmark-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Model</th>
                <th>Wins</th>
                <th>Total Score</th>
                <th>Best</th>
                <th>Kills</th>
                <th>Accuracy</th>
                <th>Latency</th>
                <th>AI Flight Doctrine</th>
              </tr>
            </thead>
            <tbody>
              {rankedModels.map((m, index) => {
                const live = liveStats[m.id];
                const liveScore = running ? currentScores[m.id] : undefined;
                const activeTactic = tactics[m.id]?.tactic || m.lastTactic || "Autonomous combat patrol";
                const latency = tactics[m.id]?.latencyMs ?? m.lastLatencyMs;
                const kills = m.totalKills + (running && live ? live.kills : 0);
                const accuracy =
                  running && live && live.accuracy > 0
                    ? `${live.accuracy}%`
                    : m.avgAccuracy > 0
                    ? `${m.avgAccuracy}%`
                    : "—";

                return (
                  <tr key={m.id} className={liveScore !== undefined ? "benchmark-selected" : undefined}>
                    <td><b>#{index + 1}</b></td>
                    <td className="benchmark-model-cell">
                      <strong>{label(m.id)}</strong>
                      <small style={{ display: "block", color: "var(--text-muted, #9aa4b2)", fontSize: "0.7rem" }}>
                        {m.providerId}
                      </small>
                    </td>
                    <td><b>{m.wins}</b> {m.gamesPlayed > 0 && <small>({m.gamesPlayed} rds)</small>}</td>
                    <td className="benchmark-avg">
                      <strong>
                        {liveScore !== undefined
                          ? `${m.totalScore + liveScore} (+${liveScore} live)`
                          : m.totalScore}
                      </strong>
                    </td>
                    <td>{m.bestScore || (liveScore !== undefined ? liveScore : "—")}</td>
                    <td>{kills}</td>
                    <td>{accuracy}</td>
                    <td>{latency ? `${latency}ms` : "—"}</td>
                    <td style={{ fontSize: "0.75rem", fontStyle: "italic", maxWidth: "240px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      "{activeTactic}" {m.lastSource && <small style={{ color: m.lastSource === "model" ? "#00ff88" : "#ff9d00", fontStyle: "normal" }}>· {m.lastSource}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {benchmarkMode === "shared_arena" ? (
        <div className="benchmark-battle-royale-wrap">
          <div className="benchmark-battle-canvas-box">
            <canvas ref={sharedCanvasRef} width="960" height="540" />
            <span className="benchmark-canvas-live">{running ? "LIVE BATTLE ROYALE" : "DOGFIGHT ARENA"}</span>
            {!running && (
              <div className="benchmark-canvas-debug" style={{ left: "1rem", bottom: "1rem", fontSize: "0.75rem" }}>
                Select contestants above and click Launch to start the All-in-One Battle Royale!
              </div>
            )}
          </div>
          <div className="benchmark-battle-scoreboard">
            <h4>
              <span>⚔️ Survival Dogfight Standings</span>
              <small style={{ color: "var(--text-muted, #9aa4b2)", fontWeight: "normal" }}>
                {sharedShips.length > 0 ? `${sharedShips.filter((s) => s.alive).length}/${sharedShips.length} alive` : `${activeContestants.length} ready`}
              </small>
            </h4>
            {(sharedShips.length > 0
              ? [...sharedShips].sort((a, b) => {
                  if (a.alive !== b.alive) return a.alive ? -1 : 1;
                  if (a.survivalRank && b.survivalRank) return a.survivalRank - b.survivalRank;
                  return b.score - a.score;
                })
              : activeContestants.map((id, idx) => ({
                  id,
                  name: label(id),
                  provider: providerForModel(id),
                  color: id === JEV_ID ? "#00f0ff" : ["#ff9d00", "#00ff88", "#d000ff", "#ff2255", "#ffea00", "#3399ff"][idx % 6],
                  score: 0,
                  hp: 5,
                  maxHp: 5,
                  pvpKills: 0,
                  asteroidKills: 0,
                  alive: true,
                  eliminatedAt: null as number | null,
                  survivalRank: 0,
                  isJev: id === JEV_ID,
                  liveDirective: liveDirectives[id],
                }))
            ).map((ship, idx) => {
              const rankText =
                ship.survivalRank === 1
                  ? "🥇 1st (Survivor Winner)"
                  : ship.survivalRank === 2
                  ? "🥈 2nd (Runner-up)"
                  : ship.survivalRank === 3
                  ? "🥉 3rd (Bronze)"
                  : ship.survivalRank > 3
                  ? `#${ship.survivalRank}`
                  : `#${idx + 1}`;
              return (
                <div key={ship.id} className={`benchmark-battle-ship-row ${ship.isJev ? "is-jev" : ""}`}>
                  <div className="row-header">
                    <span style={{ color: ship.color, fontWeight: 700 }}>
                      {rankText} · {ship.name}
                    </span>
                    <strong style={{ color: "#fff" }}>{ship.score} pts</strong>
                  </div>
                  <div className="row-stats">
                    <span>
                      {ship.alive ? (
                        <b style={{ color: "#00ff88" }}>ALIVE ({ship.hp}/{ship.maxHp || 5} HP)</b>
                      ) : (
                        <span style={{ color: "#ff3344" }}>💀 ELIMINATED ({ship.eliminatedAt ? `${Math.round(ship.eliminatedAt)}s` : "Out"})</span>
                      )}
                    </span>
                    <span>⚔️ {ship.pvpKills} Frags · ☄️ {ship.asteroidKills} Rocks</span>
                  </div>
                  {ship.isJev && (
                    <div className="row-directive" style={{ fontSize: "0.72rem", color: "#00f0ff", marginTop: "2px" }}>
                      📡 {ship.liveDirective?.radioCallout || "Neural Link Connected · Ready"} {ship.liveDirective?.latencyMs ? `(${ship.liveDirective.latencyMs}ms)` : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="benchmark-arena">
          {displayedContestants.map((modelId, index) => {
            const liveScore = currentScores[modelId];
            const tactic = tactics[modelId];
            const directive = liveDirectives[modelId];
            return (
              <figure key={modelId}>
                <figcaption>
                  <div>
                    <strong>{label(modelId)}</strong>
                    <small style={{ marginLeft: "0.4rem", color: "var(--text-muted, #9aa4b2)" }}>
                      {providerForModel(modelId)}
                    </small>
                  </div>
                  <span>
                    {liveScore !== undefined ? `${liveScore} pts` : "Standby"}
                    {tactic?.latencyMs ? ` · ${tactic.latencyMs}ms` : ""}
                  </span>
                </figcaption>
                {directive && (
                  <div className="benchmark-live-directive-badge">
                    {directive.radioCallout} {directive.latencyMs > 0 ? `(${directive.latencyMs}ms)` : ""}
                  </div>
                )}
                <div className="benchmark-doctrine-banner">
                  <span>AI Doctrine:</span> "{tactic?.tactic ?? "Autonomous combat patrol"}"
                </div>
                <div className="benchmark-canvas-wrap">
                  <canvas ref={(canvas) => { canvases.current[index] = canvas; }} width="640" height="380" />
                  <span className="benchmark-canvas-live">{running ? "LIVE" : "ARENA"}</span>
                  <div className="benchmark-canvas-debug" ref={(node) => { diagnostics.current[index] = node; }}>
                    DEBUG · waiting for battle start
                  </div>
                </div>
              </figure>
            );
          })}
        </div>
      )}

      {championship?.gamesPlayed && championship.gamesPlayed.length > 0 && (
        <div className="benchmark-rounds" style={{ marginTop: "1rem" }}>
          <strong>Completed Rounds History</strong>
          {championship.gamesPlayed.map((round) => (
            <span key={round.game} style={{ marginRight: "1rem" }}>
              Round {round.game}: <b>{label(round.winner)}</b> won (
              {round.scores[round.winner]?.score ?? 0} pts, {round.scores[round.winner]?.kills ?? 0} kills)
            </span>
          ))}
        </div>
      )}

      <p className="benchmark-visual-status">
        {running
          ? "Live AI dogfight in progress · Real-time physics engine active in every arena"
          : status.includes("Complete")
          ? "Battle complete · Final scores recorded in Championship Leaderboard"
          : "Select your AI contestants above and launch the battle!"}
      </p>
    </section>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: BenchmarkLeaderboardResponse };

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function categoryAverage(run: BenchmarkRunRecord, category: string): number | null {
  return average(run.tasks.filter((task) => task.category === category && task.finalScore !== null).map((task) => task.finalScore as number));
}

function overallAverage(run: BenchmarkRunRecord): number | null {
  return average(run.tasks.filter((task) => task.finalScore !== null).map((task) => task.finalScore as number));
}

function totalDurationSeconds(run: BenchmarkRunRecord): number {
  return Math.round(run.tasks.reduce((sum, task) => sum + (task.durationMs ?? 0), 0) / 1000);
}

function totalTokens(run: BenchmarkRunRecord): number {
  return run.tasks.reduce((sum, task) => sum + (task.tokens?.total ?? 0), 0);
}

function scoreTone(score: number | null): string {
  if (score === null) return "benchmark-muted";
  if (score >= 90) return "benchmark-good";
  if (score >= 70) return "benchmark-mid";
  return "benchmark-bad";
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function scoreLabel(score: number | null): string {
  return score === null ? "—" : String(score);
}

export function BenchmarkPage({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const data = await fetchBenchmarkLeaderboard();
      setState({ status: "ready", data });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "Benchmark data could not be loaded." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runs = state.status === "ready" ? state.data.runs : [];
  const selectedRun = useMemo(
    () => runs.find((run) => run.runId === selectedRunId) ?? null,
    [runs, selectedRunId]
  );

  const categories = useMemo(() => {
    const ordered = new Set<string>();
    for (const run of runs) {
      for (const task of run.tasks) ordered.add(task.category);
    }
    return [...ordered];
  }, [runs]);

  return (
    <main className="benchmark-page">
      <header className="benchmark-header">
        <button type="button" className="benchmark-back" aria-label="Back to Space" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          <span>Back to Space</span>
        </button>
        <div className="benchmark-title-block">
          <span className="benchmark-title-icon" aria-hidden="true"><Gauge /></span>
          <div>
            <h1>Asteroids AI Benchmark</h1>
            <p>Live AI championship — games, scores and rankings.</p>
          </div>
        </div>
        <button type="button" className="benchmark-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      {state.status === "loading" && <p className="benchmark-status">Loading results…</p>}
      {state.status === "error" && (
        <p className="benchmark-status benchmark-error">
          Could not load the data: {state.message}
          {" "}
          <button type="button" className="benchmark-inline-button" onClick={() => void load()}>Try again</button>
        </p>
      )}
      {state.status === "ready" && !state.data.available && (
        <p className="benchmark-status">
          No published results yet (dir: {state.data.resultsDir}). Run the benchmark and then
          {" "}<code>space-model-benchmark.sh --publish</code>.
        </p>
      )}
      {state.status === "ready" && state.data.available && runs.length === 0 && (
        <p className="benchmark-status">No benchmark runs yet. Run space-model-benchmark and publish the results.</p>
      )}

      <GameBenchmark />

      {selectedRun && false && state.status === "ready" && runs.length > 0 && (
        <section className="benchmark-content">
          <div className="benchmark-leaderboard">
            <h2>Leaderboard</h2>
            <div className="benchmark-table-wrap">
              <table className="benchmark-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    {categories.map((category) => <th key={category}>{category}</th>)}
                    <th>Avg</th>
                    <th>Duration</th>
                    <th>Tokens</th>
                    <th>Run</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const overall = overallAverage(run);
                    return (
                      <tr
                        key={run.runId}
                        className={run.runId === selectedRunId ? "benchmark-selected" : undefined}
                        onClick={() => setSelectedRunId(run.runId === selectedRunId ? null : run.runId)}
                      >
                        <td className="benchmark-model-cell">{run.model}</td>
                        {categories.map((category) => {
                          const value = categoryAverage(run, category);
                          return <td key={category} className={scoreTone(value)}>{scoreLabel(value)}</td>;
                        })}
                        <td className={`benchmark-avg ${scoreTone(overall)}`}><strong>{scoreLabel(overall)}</strong></td>
                        <td>{totalDurationSeconds(run)}s</td>
                        <td>{totalTokens(run)}</td>
                        <td className="benchmark-run-cell">{formatDate(run.runTs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {selectedRun && (
            <div className="benchmark-run-detail">
              <h2>{selectedRun!.model} — tasks</h2>
              <p className="benchmark-run-meta">
                runtime {selectedRun!.runtime} · judge {selectedRun!.noJudge ? "off" : (selectedRun!.judgeModel ?? "n/a")} · {formatDate(selectedRun!.runTs)}
              </p>
              <div className="benchmark-table-wrap">
                <table className="benchmark-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Category</th>
                      <th>Deterministic</th>
                      <th>Judge</th>
                      <th>Final</th>
                      <th>Duration</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRun!.tasks.map((task) => (
                      <tr key={task.taskId}>
                        <td className="benchmark-model-cell">{task.error ? `${task.taskId} ⚠ ${task.error}` : task.title}</td>
                        <td>{task.category}</td>
                        <td className={scoreTone(task.deterministic?.score ?? null)}>{scoreLabel(task.deterministic?.score ?? null)}</td>
                        <td className={scoreTone(task.judge?.score ?? null)}>{scoreLabel(task.judge?.score ?? null)}</td>
                        <td className={`benchmark-avg ${scoreTone(task.finalScore)}`}><strong>{scoreLabel(task.finalScore)}</strong></td>
                        <td>{task.durationMs !== undefined ? `${Math.round(task.durationMs / 1000)}s` : "—"}</td>
                        <td>{task.turnStatus ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {selectedRun!.tasks.some((task) => task.deterministic?.checks?.length) && (
                <details className="benchmark-checks">
                  <summary>Deterministic checks</summary>
                  {selectedRun!.tasks.map((task) => (
                    <div key={task.taskId} className="benchmark-checks-task">
                      <strong>{task.taskId}</strong>
                      <ul>
                        {(task.deterministic?.checks ?? []).map((check) => (
                          <li key={check.id} className={check.pass ? "benchmark-check-pass" : "benchmark-check-fail"}>
                            {check.pass ? "✔" : "✘"} {check.id}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </details>
              )}

              {selectedRun!.tasks.some((task) => (task.judge?.criteria ?? []).length > 0) && (
                <details className="benchmark-checks">
                  <summary>Judge criteria</summary>
                  {selectedRun!.tasks.map((task) => (
                    <div key={task.taskId} className="benchmark-checks-task">
                      <strong>{task.taskId}</strong>
                      <ul>
                        {(task.judge?.criteria ?? []).map((item) => (
                          <li key={item.criterion}>
                            <span className={scoreTone(item.score === null ? null : Math.round(((item.score - 1) / 4) * 100))}>
                              {item.score === null ? "—" : item.score}/5
                            </span>
                            {" "}{item.criterion}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </details>
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
