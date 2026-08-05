import { AlertTriangle, Check, RotateCcw, ShieldAlert, X } from "../ui-theme/app-icons.js";
import { useState } from "react";
import type { MemoryChangeSet } from "@space/contracts";

const snapshotDisplayLimit = 12_000;

function BoundedSnapshot({ label, value }: { label: string; value: string }) {
  const truncated = value.length > snapshotDisplayLimit;
  return (
    <section>
      <h4>{label}</h4>
      <pre aria-label={label}>{value.slice(0, snapshotDisplayLimit)}</pre>
      {truncated ? <small>Preview limited to {snapshotDisplayLimit.toLocaleString()} characters.</small> : null}
    </section>
  );
}

export function MemoryChangeSetDetail({
  changeSet,
  loading,
  mutationsEnabled,
  busy,
  onApprove,
  onReject,
  onExecute,
  onReconcile,
  onRollback
}: {
  changeSet: MemoryChangeSet | null;
  loading: boolean;
  mutationsEnabled: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onExecute: () => void;
  onReconcile: () => void;
  onRollback: () => void;
}) {
  const [rejectionReason, setRejectionReason] = useState("");
  if (loading) return <aside className="memory-change-detail" aria-label="Memory change set detail"><p role="status">Loading change-set snapshots…</p></aside>;
  if (!changeSet) return <aside className="memory-change-detail" aria-label="Memory change set detail"><p>Select a change set to inspect its bounded before/after comparison.</p></aside>;
  const rollbackEligible = changeSet.status === "APPLIED" && !changeSet.rolledBackByChangeSetId;

  return (
    <aside className="memory-change-detail" aria-label="Memory change set detail">
      <header>
        <div><span data-status={changeSet.status}>{changeSet.status}</span><h3>{changeSet.kind} change set</h3></div>
        <small>{changeSet.id}</small>
      </header>
      <p className="memory-change-path">{changeSet.sourcePath}</p>
      <p>{changeSet.reason}</p>
      {changeSet.statusReason ? <p className="memory-change-warning"><AlertTriangle aria-hidden="true" />{changeSet.statusReason}</p> : null}
      {changeSet.status === "APPLYING" ? (
        <p className="memory-change-warning"><ShieldAlert aria-hidden="true" />If the state remains APPLYING, use operator-required reconciliation. Unknown newer content is never overwritten automatically.</p>
      ) : null}
      {!mutationsEnabled && ["APPROVED", "APPLYING"].includes(changeSet.status) ? (
        <p className="memory-change-warning"><ShieldAlert aria-hidden="true" />Canonical writes are disabled by the server rollout gate.</p>
      ) : null}

      <div className="memory-change-diff" aria-label="Bounded before and after snapshot comparison">
        <BoundedSnapshot label="Before snapshot" value={changeSet.beforeSnapshot} />
        <BoundedSnapshot label="After snapshot" value={changeSet.afterSnapshot} />
      </div>

      <div className="memory-change-actions">
        {changeSet.status === "PROPOSED" ? (
          <>
            <button type="button" disabled={busy} aria-label="Approve change set" onClick={onApprove}><Check aria-hidden="true" />Approve</button>
            <label>
              <span>Rejection reason</span>
              <input name="memoryRejectionReason" value={rejectionReason} onChange={(event) => setRejectionReason(event.currentTarget.value)} maxLength={2000} />
            </label>
            <button type="button" className="danger" disabled={busy || !rejectionReason.trim()} aria-label="Reject change set" onClick={() => onReject(rejectionReason.trim())}><X aria-hidden="true" />Reject</button>
          </>
        ) : null}
        {changeSet.status === "APPROVED" ? <button type="button" disabled={busy || !mutationsEnabled} aria-label="Execute approved change set" onClick={onExecute}><ShieldAlert aria-hidden="true" />Execute</button> : null}
        {changeSet.status === "APPLYING" ? <button type="button" disabled={busy || !mutationsEnabled} aria-label="Reconcile applying change set" onClick={onReconcile}><RotateCcw aria-hidden="true" />Reconcile</button> : null}
        {rollbackEligible ? <button type="button" className="danger" disabled={busy || !mutationsEnabled} aria-label="Propose exact rollback" onClick={onRollback}><RotateCcw aria-hidden="true" />Propose rollback</button> : null}
      </div>
    </aside>
  );
}
