import { useEffect, useMemo, useState } from "react";
import type { MemoryConsolidationDetail, MemoryConsolidationMode } from "@space/contracts";
import { api } from "../../api.js";

const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

function idempotencyKey(mode: MemoryConsolidationMode): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `memory-${mode.toLocaleLowerCase()}:${suffix}`;
}

export function MemoryJobsPanel({ onError }: { onError: (error: unknown) => void }) {
  const [jobs, setJobs] = useState<MemoryConsolidationDetail[]>([]);
  const [busyMode, setBusyMode] = useState<MemoryConsolidationMode | null>(null);
  const [mutationsEnabled, setMutationsEnabled] = useState<boolean | null>(null);
  const pollingKey = useMemo(() => jobs
    .filter((job) => !terminalStatuses.has(job.run.status))
    .map((job) => job.run.id)
    .sort()
    .join("|"), [jobs]);

  useEffect(() => {
    const runIds = pollingKey ? pollingKey.split("|") : [];
    if (runIds.length === 0) return;
    let active = true;
    const poll = async () => {
      try {
        const updated = await Promise.all(runIds.map((runId) => api.memoryConsolidation(runId)));
        if (!active) return;
        const byId = new Map(updated.map((job) => [job.run.id, job]));
        setJobs((current) => current.map((job) => byId.get(job.run.id) ?? job));
        setMutationsEnabled(updated.at(0)?.mutationsEnabled ?? null);
      } catch (error) {
        if (active) onError(error);
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [onError, pollingKey]);

  async function start(mode: MemoryConsolidationMode) {
    if (mode === "REPAIR" && !window.confirm(
      "Run guarded memory repair? Only deterministic validator-approved operations may reach the mutation queue."
    )) return;
    setBusyMode(mode);
    try {
      const response = await api.createMemoryConsolidation({ mode }, idempotencyKey(mode));
      const detail: MemoryConsolidationDetail = {
        run: response.run,
        findings: [],
        operations: [],
        maintenanceEnabled: response.maintenanceEnabled,
        mutationsEnabled: response.mutationsEnabled
      };
      setJobs((current) => [detail, ...current.filter((job) => job.run.id !== detail.run.id)].slice(0, 5));
      setMutationsEnabled(response.mutationsEnabled);
    } catch (error) {
      onError(error);
    } finally {
      setBusyMode(null);
    }
  }

  return (
    <section className="memory-jobs" aria-label="Memory maintenance jobs">
      <div className="memory-job-controls">
        <strong>Maintenance</strong>
        <button type="button" disabled={busyMode !== null} onClick={() => void start("AUDIT")}>Run memory audit</button>
        <button
          type="button"
          disabled={busyMode !== null || mutationsEnabled === false}
          title={mutationsEnabled === false ? "Canonical mutations are disabled." : "Run guarded deterministic repair"}
          onClick={() => void start("REPAIR")}
        >Run memory repair</button>
      </div>
      {jobs.length > 0 ? (
        <div className="memory-job-list" aria-live="polite">
          {jobs.map((job) => (
            <article key={job.run.id} data-status={job.run.status}>
              <strong>{job.run.mode} · {job.run.status}</strong>
              <span>{job.run.progressCompleted}/{job.run.progressTotal} steps · {job.run.findingCount} findings</span>
              {job.run.statusReason ? <small>{job.run.statusReason}</small> : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
