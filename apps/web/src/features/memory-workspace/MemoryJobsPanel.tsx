import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MoreHorizontal } from "../ui-theme/app-icons.js";
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
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
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

  const closeMenuAndRestoreFocus = useCallback(() => {
    setMenuOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenuAndRestoreFocus();
    };
    const handleClick = (event: MouseEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      closeMenuAndRestoreFocus();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("click", handleClick, true);
    };
  }, [closeMenuAndRestoreFocus, menuOpen]);

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
    <section ref={rootRef} className="memory-jobs" aria-label="Memory maintenance jobs">
      <button
        ref={triggerRef}
        type="button"
        className="memory-maintenance-trigger"
        aria-label="Memory maintenance menu"
        aria-expanded={menuOpen}
        aria-haspopup="dialog"
        aria-controls="memory-maintenance-menu"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {menuOpen ? (
        <div
          ref={menuRef}
          id="memory-maintenance-menu"
          className="memory-job-controls"
          role="dialog"
          aria-modal="false"
          aria-label="Memory maintenance"
        >
          <div className="memory-job-actions" role="group" aria-label="Maintenance actions">
            <strong>Maintenance</strong>
            <button type="button" disabled={busyMode !== null} onClick={() => void start("AUDIT")}>Run memory audit</button>
            <button
              type="button"
              disabled={busyMode !== null || mutationsEnabled === false}
              title={mutationsEnabled === false ? "Canonical mutations are disabled." : "Run guarded deterministic repair"}
              onClick={() => void start("REPAIR")}
            >Run memory repair</button>
          </div>
          <section className="memory-job-runs" aria-label="Recent memory maintenance runs">
            <strong>Recent runs</strong>
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
            ) : <p className="memory-job-empty">No recent runs.</p>}
          </section>
        </div>
      ) : null}
    </section>
  );
}
