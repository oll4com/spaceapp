import { useEffect, useState } from "react";
import type { DotEvalReport, DotEvalRunSummary, DotProfile } from "@space/contracts";
import { api, SpaceApiError } from "../../api.js";

type Split = "holdout" | "tuning" | "all";
const splitLabels: Record<Split, string> = { holdout: "Holdout", tuning: "Tuning", all: "All" };

/**
 * Space Dots Stage 7: ADMINs run the frozen evaluation cases on one of their
 * Dots. Hidden for everyone else (the server answers 403). A run proves
 * nothing alone: release decisions compare runs through the gates.
 */
export function DotEvaluationSection({ dot, roomId, readRuns = api.dotEvalRuns, start = api.startDotEval, readReport = api.dotEvalReport, stop = api.stopDotEval,
  pollMs = 10_000 }: {
  dot: DotProfile; roomId: string; readRuns?: typeof api.dotEvalRuns; start?: typeof api.startDotEval; readReport?: typeof api.dotEvalReport;
  stop?: typeof api.stopDotEval; pollMs?: number;
}) {
  const [runs, setRuns] = useState<DotEvalRunSummary[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [split, setSplit] = useState<Split>("holdout");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [report, setReport] = useState<DotEvalReport | null>(null);
  const [revision, setRevision] = useState(0);
  const active = runs?.some((run) => run.counts.PENDING + run.counts.RUNNING > 0) ?? false;

  useEffect(() => {
    let cancelled = false;
    readRuns(dot.dotId).then((response) => { if (!cancelled) setRuns(response.runs); }).catch((error: unknown) => {
      if (cancelled) return;
      if (error instanceof SpaceApiError && (error.status === 403 || error.status === 503)) setHidden(true);
      else setMessage("Evaluation runs could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [dot.dotId, readRuns, revision]);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setRevision((value) => value + 1), pollMs);
    return () => clearInterval(timer);
  }, [active, pollMs]);

  if (hidden) return null;
  async function run() {
    setPending(true); setMessage(null);
    try {
      const started = await start(dot.dotId, { dataset: "dots-v1", split, roomId });
      setMessage(`Started ${started.cases} cases in a new pane${started.skipped ? `; ${started.skipped} need connections you have not made and are skipped` : ""}.`);
      setRevision((value) => value + 1);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The evaluation could not start.");
    } finally { setPending(false); }
  }
  async function view(evalRunId: string) {
    setMessage(null);
    try { setReport(await readReport(dot.dotId, evalRunId)); } catch { setMessage("The report could not be loaded."); }
  }
  async function halt(evalRunId: string) {
    try {
      const { stopped } = await stop(dot.dotId, evalRunId);
      setMessage(stopped ? "Stopping after the current case." : "This evaluation is no longer running.");
      setRevision((value) => value + 1);
    } catch { setMessage("The evaluation could not be stopped."); }
  }
  return <section className="dots-evaluation" aria-label="Evaluation">
    <h3>Evaluation</h3>
    <p>Runs the frozen dots-v1 cases on the real runtime in a new pane of this room, one conversation per case. While a case runs, every change through
      Space tools waits for approval and is declined when the case ends; the Dot works only in its own workspace. It uses your model quota.</p>
    <div className="dots-evaluation-controls">
      <div role="group" aria-label="Cases">
        {(Object.keys(splitLabels) as Split[]).map((value) => <button key={value} type="button" aria-pressed={split === value} disabled={pending}
          onClick={() => setSplit(value)}>{splitLabels[value]}</button>)}
      </div>
      <button type="button" disabled={pending || active || runs === null} onClick={() => void run()}>{pending ? "Starting…" : "Run evaluation"}</button>
    </div>
    {message ? <p role="status">{message}</p> : null}
    {runs?.length ? <ul className="dots-evaluation-runs">
      {runs.map((item) => <li key={item.evalRunId}>
        <span>{new Date(item.createdAt).toLocaleString("en-US")} · {item.counts.DONE} done · {item.counts.SKIPPED} skipped · {item.counts.FAILED} failed
          {item.counts.CANCELLED ? ` · ${item.counts.CANCELLED} stopped` : ""}
          {item.counts.PENDING + item.counts.RUNNING ? ` · ${item.counts.PENDING + item.counts.RUNNING} left` : ""}</span>
        <button type="button" onClick={() => void view(item.evalRunId)}>View</button>
        {item.counts.PENDING + item.counts.RUNNING ? <button type="button" onClick={() => void halt(item.evalRunId)}>Stop</button> : null}
      </li>)}
    </ul> : runs ? <p>No evaluation runs yet.</p> : null}
    {report ? <div className="dots-evaluation-report" aria-label="Evaluation report">
      <table>
        <thead><tr><th scope="col">Family</th><th scope="col">Passed</th><th scope="col">Failed</th><th scope="col">Not run</th></tr></thead>
        <tbody>{Object.entries(report.families).map(([family, counts]) => <tr key={family}>
          <th scope="row">{family}</th><td>{counts.passed}</td><td>{counts.failed}</td><td>{counts.notRun}</td></tr>)}</tbody>
      </table>
      <p>{report.calibrationComplete ? "" : "The checks are not yet calibrated by people. "}{report.note}</p>
    </div> : null}
  </section>;
}
