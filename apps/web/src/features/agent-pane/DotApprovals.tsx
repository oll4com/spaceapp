import { useEffect, useState } from "react";
import type { DotProfile, DotToolInvocation } from "@space/contracts";
import { api } from "../../api.js";

/**
 * Sensitive actions a Dot requested wait here for the owner's decision. The
 * server executes exactly the recorded action once, then the Dot continues.
 */
export function DotApprovals({ dot, sessionId, pending, onDecided, read = api.dotApprovals, decide = api.decideDotApproval }: {
  dot: DotProfile | null; sessionId: string | null; pending: boolean; onDecided: () => void;
  read?: (dotId: string, sessionId: string) => Promise<{ dotId: string; items: DotToolInvocation[] }>;
  decide?: (dotId: string, invocationId: string, decision: "APPROVE" | "DECLINE") => Promise<unknown>;
}) {
  const [items, setItems] = useState<DotToolInvocation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const key = `${dot?.dotId ?? ""}:${sessionId ?? ""}`;
  useEffect(() => {
    let current = true;
    if (!pending || !dot || !sessionId) { setItems([]); return; }
    void Promise.resolve().then(() => read(dot.dotId, sessionId)).then(result => {
      if (current && result.dotId === dot.dotId) setItems(result.items.filter(item => item.dotId === dot.dotId && item.sessionId === sessionId));
    }).catch(() => { if (current) setError("Approval requests are unavailable. Retry to load them."); });
    return () => { current = false; };
  }, [key, pending, revision, read]);
  if (!pending || !dot) return null;
  async function choose(item: DotToolInvocation, decision: "APPROVE" | "DECLINE") {
    setBusy(item.invocationId); setError(null);
    try {
      await decide(dot!.dotId, item.invocationId, decision);
      setItems(current => current.filter(candidate => candidate.invocationId !== item.invocationId));
      onDecided();
    } catch {
      setError("The decision was not recorded. Try again.");
    } finally { setBusy(null); }
  }
  return <section className="dots-approvals" aria-label={`${dot.name} is waiting for approval`}>
    {items.map(item => <div key={item.invocationId} className="dots-approval" role="group" aria-label={`Approval request ${item.toolId}`}>
      <div><strong>{dot.name} wants to</strong><p>{item.approvalSummary ?? item.toolId}</p><small><code>{item.toolId}</code></small></div>
      <div className="dots-approval-actions">
        <button type="button" disabled={busy !== null} onClick={() => void choose(item, "DECLINE")}>Decline</button>
        <button type="button" className="dots-approval-approve" disabled={busy !== null} onClick={() => void choose(item, "APPROVE")}>
          {busy === item.invocationId ? "Working…" : "Approve"}</button>
      </div>
    </div>)}
    {!items.length && !error ? <p role="status">Loading approval requests…</p> : null}
    {error ? <p role="alert">{error} <button type="button" onClick={() => { setError(null); setRevision(value => value + 1); }}>Retry</button></p> : null}
  </section>;
}
