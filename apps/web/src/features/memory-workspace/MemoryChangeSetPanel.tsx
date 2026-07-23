import { ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryChangeSet, MemoryChangeSetSummary } from "@space/contracts";
import { api, type MemoryChangeSetListResponse } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { MemoryChangeSetDetail } from "./MemoryChangeSetDetail.js";

function summaryOf(changeSet: MemoryChangeSet): MemoryChangeSetSummary {
  const { beforeSnapshot: _before, afterSnapshot: _after, ...summary } = changeSet;
  return summary;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The memory change-set action failed closed.";
}

function commandKey(action: string, changeSetId: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `memory-${action}:${changeSetId}:${suffix}`;
}

function actionNotice(liveMessage: string): string {
  return getSpaceRuntimeKind() === "demo" ? DEMO_LOCAL_REPLY : liveMessage;
}

export function MemoryChangeSetPanel() {
  const [page, setPage] = useState(1);
  const [payload, setPayload] = useState<MemoryChangeSetListResponse | null>(null);
  const [detail, setDetail] = useState<MemoryChangeSet | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const detailRequest = useRef(0);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      setPayload(await api.memoryChangeSets({ page, pageSize: 25 }));
      setError(null);
    } catch (loadError) {
      setError(failureMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { void loadList(); }, [loadList]);

  async function select(changeSetId: string) {
    const requestId = ++detailRequest.current;
    setSelectedId(changeSetId);
    setDetail(null);
    setDetailLoading(true);
    try {
      const selected = await api.memoryChangeSet(changeSetId);
      if (requestId === detailRequest.current) setDetail(selected);
      setError(null);
    } catch (loadError) {
      if (requestId === detailRequest.current) setError(failureMessage(loadError));
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }

  function sync(updated: MemoryChangeSet) {
    setDetail(updated);
    setSelectedId(updated.id);
    setPayload((current) => current ? {
      ...current,
      data: [summaryOf(updated), ...current.data.filter((item) => item.id !== updated.id)]
    } : current);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setError(null);
    } catch (actionError) {
      setError(failureMessage(actionError));
    } finally {
      setBusy(false);
    }
  }

  function approve() {
    if (!detail) return;
    const selected = detail;
    void run(async () => {
      sync({ ...selected, ...await api.reviewMemoryChangeSet(selected.id, { status: "APPROVED" }) });
      setNotice(actionNotice("Change set approved. Canonical content is still unchanged."));
    });
  }

  function reject(reason: string) {
    if (!detail) return;
    const selected = detail;
    void run(async () => {
      sync({ ...selected, ...await api.reviewMemoryChangeSet(selected.id, { status: "REJECTED", statusReason: reason }) });
      setNotice(actionNotice("Change set rejected without changing canonical content."));
    });
  }

  function execute() {
    if (!detail || !window.confirm(
      `Execute ${detail.id} against ${detail.sourcePath}? The guarded worker will verify exact hashes before any canonical write.`
    )) return;
    const selected = detail;
    void run(async () => {
      const result = await api.executeMemoryChangeSet(selected.id, commandKey("execute", selected.id));
      setNotice(actionNotice(`Execution ${result.status.toLocaleLowerCase()}: ${result.workflowId}`));
    });
  }

  function reconcile() {
    if (!detail) return;
    const selected = detail;
    void run(async () => {
      const result = await api.reconcileMemoryChangeSet(selected.id, commandKey("reconcile", selected.id));
      setNotice(actionNotice(`Reconciliation ${result.status.toLocaleLowerCase()}: refresh after the worker resolves exact hashes.`));
    });
  }

  function proposeRollback() {
    if (!detail?.resultingSourceHash || !window.confirm(
      `Create an exact rollback proposal for ${detail.id}? This only proposes the audited reversal; it does not execute it.`
    )) return;
    const target = detail;
    void run(async () => {
      const summary = await api.createMemoryRollback(
        target.id,
        { reason: `Restore the audited before snapshot from ${target.id}.` },
        commandKey("rollback", target.id)
      );
      sync(await api.memoryChangeSet(summary.id));
      setNotice(actionNotice("Exact rollback proposal created. Review and approve it separately before execution."));
    });
  }

  const summaries = payload?.data ?? [];
  const mutationsEnabled = payload?.mutationsEnabled ?? false;
  return (
    <section className="memory-change-panel" aria-label="Memory change sets">
      <div className="memory-change-toolbar">
        <span><ShieldAlert aria-hidden="true" />{mutationsEnabled ? "Guarded canonical writes enabled" : "Canonical writes disabled"}</span>
        <div>
          <button type="button" aria-label="Previous change-set page" disabled={page === 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft aria-hidden="true" /></button>
          <button type="button" aria-label="Next change-set page" disabled={!payload?.pagination.hasNext} onClick={() => setPage((value) => value + 1)}><ChevronRight aria-hidden="true" /></button>
        </div>
      </div>
      {error ? <p className="memory-workspace-error" role="alert">{error}</p> : null}
      {notice ? <p className="memory-change-notice" role="status" aria-live="polite">{notice}</p> : null}
      <div className="memory-change-layout">
        <section className="memory-change-list" aria-label="Memory change-set summaries">
          {loading ? <p role="status">Loading change-set summaries…</p> : null}
          {!loading && summaries.length === 0 ? <p>No change sets match this page.</p> : null}
          {summaries.map((changeSet) => (
            <button key={changeSet.id} type="button" className={selectedId === changeSet.id ? "selected" : ""} aria-label={`${changeSet.kind} · ${changeSet.status} · ${changeSet.reason}`} onClick={() => void select(changeSet.id)}>
              <span data-status={changeSet.status}>{changeSet.kind} · {changeSet.status}</span><strong>{changeSet.reason}</strong><small>{changeSet.sourcePath.split("/").at(-1)}</small>
            </button>
          ))}
        </section>
        <MemoryChangeSetDetail
          key={detail?.id ?? "empty"}
          changeSet={detail}
          loading={detailLoading}
          mutationsEnabled={mutationsEnabled}
          busy={busy}
          onApprove={approve}
          onReject={reject}
          onExecute={execute}
          onReconcile={reconcile}
          onRollback={proposeRollback}
        />
      </div>
    </section>
  );
}
