import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Gauge } from "../ui-theme/app-icons.js";

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
            <h1>Space Model Benchmark</h1>
            <p>Εσωτερική σύγκριση μοντέλων για χρήση μέσα στο Space App — σκορ, χρόνος και tokens ανά εργασία.</p>
          </div>
        </div>
        <button type="button" className="benchmark-refresh" onClick={() => void load()}>
          Refresh
        </button>
      </header>

      {state.status === "loading" && <p className="benchmark-status">Φόρτωση αποτελεσμάτων…</p>}
      {state.status === "error" && (
        <p className="benchmark-status benchmark-error">
          Δεν ήταν δυνατή η φόρτωση των δεδομένων: {state.message}
          {" "}
          <button type="button" className="benchmark-inline-button" onClick={() => void load()}>Δοκίμασε ξανά</button>
        </p>
      )}
      {state.status === "ready" && !state.data.available && (
        <p className="benchmark-status">
          Δεν υπάρχουν δημοσιευμένα αποτελέσματα ακόμα (dir: {state.data.resultsDir}). Τρέξε το benchmark και μετά
          {" "}<code>space-model-benchmark.sh --publish</code>.
        </p>
      )}
      {state.status === "ready" && state.data.available && runs.length === 0 && (
        <p className="benchmark-status">Δεν υπάρχουν benchmark runs ακόμα. Τρέξε το space-model-benchmark και δημοσίευσε τα αποτελέσματα.</p>
      )}

      {state.status === "ready" && runs.length > 0 && (
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
                    <th>Διάρκεια</th>
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
              <h2>{selectedRun.model} — εργασίες</h2>
              <p className="benchmark-run-meta">
                runtime {selectedRun.runtime} · judge {selectedRun.noJudge ? "off" : (selectedRun.judgeModel ?? "n/a")} · {formatDate(selectedRun.runTs)}
              </p>
              <div className="benchmark-table-wrap">
                <table className="benchmark-table">
                  <thead>
                    <tr>
                      <th>Εργασία</th>
                      <th>Κατηγορία</th>
                      <th>Deterministic</th>
                      <th>Judge</th>
                      <th>Final</th>
                      <th>Διάρκεια</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRun.tasks.map((task) => (
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

              {selectedRun.tasks.some((task) => task.deterministic?.checks?.length) && (
                <details className="benchmark-checks">
                  <summary>Ντετερμινιστικά checks</summary>
                  {selectedRun.tasks.map((task) => (
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

              {selectedRun.tasks.some((task) => (task.judge?.criteria ?? []).length > 0) && (
                <details className="benchmark-checks">
                  <summary>Judge κριτήρια</summary>
                  {selectedRun.tasks.map((task) => (
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
