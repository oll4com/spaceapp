import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";
import type { MonitoringTargetView } from "./types.js";

/** Targets: every probe and scrape target of the collector's Prometheus, the ones not up first (read when the tab opens). */
export function TargetsTab({ paneId }: { paneId: string }) {
  const [targets, setTargets] = useState<MonitoringTargetView[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [onlyDown, setOnlyDown] = useState(true);
  const load = useCallback(async () => {
    setMessage(null);
    try { setTargets((await api.monitoringCopilotTargets(paneId)).targets); } catch (error) { setMessage(error instanceof Error ? error.message : "The targets could not be read."); }
  }, [paneId]);
  useEffect(() => { void load(); }, [load]);
  const down = (targets ?? []).filter((target) => target.health !== "up");
  const shown = [...(onlyDown ? down : targets ?? [])].sort((left, right) => Number(left.health === "up") - Number(right.health === "up") || left.job.localeCompare(right.job) || left.instance.localeCompare(right.instance));

  return (
    <div className="mc-targets" role="tabpanel" id="jc-panel-targets" aria-labelledby="jc-tab-targets">
      <div className="jc-actions">
        <button type="button" className={`jc-button${onlyDown ? " primary" : ""}`} aria-pressed={onlyDown} onClick={() => setOnlyDown(true)}>Not up ({down.length})</button>
        <button type="button" className={`jc-button${onlyDown ? "" : " primary"}`} aria-pressed={!onlyDown} onClick={() => setOnlyDown(false)}>All ({targets?.length ?? 0})</button>
        <button type="button" className="jc-button ghost" onClick={() => void load()}>Refresh</button>
      </div>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <ul className="jc-list mc-target-list" aria-label="Collector targets">
        {shown.map((target) => (
          <li key={`${target.job}\n${target.instance}`} className="mc-target" data-health={target.health}>
            <div className="jc-row">
              <span className={`jc-pill health-${target.health}`}>{target.health === "up" ? "Up" : target.health === "down" ? "Down" : "Unknown"}</span>
              <strong className="mc-target-instance">{target.instance}</strong>
              <span className="jc-row-meta">{target.job}</span>
            </div>
            {target.lastError ? <p className="mc-target-error">{target.lastError}</p> : null}
          </li>
        ))}
      </ul>
      {targets && !shown.length ? <p className="jc-muted jc-empty">{onlyDown ? "Every target is up." : "The collector lists no targets."}</p> : null}
      {!targets && !message ? <p className="jc-muted jc-empty">Reading the collector…</p> : null}
    </div>
  );
}
