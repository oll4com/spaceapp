import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Gauge } from "../ui-theme/app-icons.js";
import { AsteroidsArenaBenchmark } from "./AsteroidsArenaBenchmark.js";
import { ChessBenchmark } from "./ChessBenchmark.js";
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

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: BenchmarkLeaderboardResponse };

type BenchmarkGame = "asteroids" | "chess";
const GAME_STORAGE_KEY = "space.benchmark.game";

function storedGame(): BenchmarkGame {
  try {
    return window.localStorage.getItem(GAME_STORAGE_KEY) === "chess" ? "chess" : "asteroids";
  } catch {
    return "asteroids";
  }
}

export function BenchmarkPage({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [game, setGame] = useState<BenchmarkGame>(storedGame);
  // A game stays mounted once opened, so switching tabs never ends a running Asteroids battle.
  const [visited, setVisited] = useState<Record<BenchmarkGame, boolean>>(() => ({ asteroids: false, chess: false, [storedGame()]: true }));
  const chooseGame = (next: BenchmarkGame) => {
    setGame(next);
    setVisited((current) => (current[next] ? current : { ...current, [next]: true }));
    try {
      window.localStorage.setItem(GAME_STORAGE_KEY, next);
    } catch { /* storage unavailable: game kept for this session */ }
  };

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
            <h1>AI Games Benchmark</h1>
            <p>Live AI championships in Asteroids and Chess — games, scores and rankings.</p>
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

      <div className="benchmark-games">
        <div className="benchmark-game-tabs" role="tablist" aria-label="Benchmark games">
          {([
            ["asteroids", "Asteroids"],
            ["chess", "Chess"],
          ] as const).map(([id, title]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`benchmark-tab-${id}`}
              aria-controls={`benchmark-panel-${id}`}
              aria-selected={game === id}
              className="benchmark-game-tab"
              onClick={() => chooseGame(id)}
            >
              <span aria-hidden="true">{id === "chess" ? "♞" : "☄"}</span>
              {title}
            </button>
          ))}
        </div>

        {visited.asteroids && (
          <div role="tabpanel" id="benchmark-panel-asteroids" aria-labelledby="benchmark-tab-asteroids" hidden={game !== "asteroids"}>
            <AsteroidsArenaBenchmark visible={game === "asteroids"} />
          </div>
        )}
        {visited.chess && (
          <div role="tabpanel" id="benchmark-panel-chess" aria-labelledby="benchmark-tab-chess" hidden={game !== "chess"}>
            <ChessBenchmark visible={game === "chess"} />
          </div>
        )}
      </div>
    </main>
  );
}
