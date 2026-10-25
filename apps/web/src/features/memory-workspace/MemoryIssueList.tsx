import { useState } from "react";
import type { MemoryGraphIssue, MemoryIssueStatus } from "@space/contracts";
import { api } from "../../api.js";

function readableType(value: string): string {
  const normalized = value.toLocaleLowerCase().replaceAll("_", " ");
  return `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`;
}

export function MemoryIssueList({
  issues,
  status,
  onOpenRecord,
  onUpdated,
  onError
}: {
  issues: MemoryGraphIssue[];
  status: MemoryIssueStatus;
  onOpenRecord: (recordId: string) => void;
  onUpdated: (issue: MemoryGraphIssue) => void;
  onError: (error: unknown) => void;
}) {
  const [ignoreReasons, setIgnoreReasons] = useState<Record<string, string>>({});
  const [busyIssueId, setBusyIssueId] = useState<string | null>(null);

  async function update(issue: MemoryGraphIssue, nextStatus: "IGNORED" | "RESOLVED") {
    const reason = nextStatus === "IGNORED" ? ignoreReasons[issue.id]?.trim() ?? "" : null;
    if (nextStatus === "IGNORED" && !reason) return;
    setBusyIssueId(issue.id);
    try {
      onUpdated(await api.updateMemoryGraphIssue(issue.id, {
        status: nextStatus,
        reason,
        expectedVersion: issue.stateVersion ?? undefined
      }));
    } catch (error) {
      onError(error);
    } finally {
      setBusyIssueId(null);
    }
  }

  return (
    <section className="memory-issue-list" aria-label={`${readableType(status)} memory issues`}>
      {issues.length === 0 ? <p>No {readableType(status)} maintenance issues in this snapshot.</p> : issues.map((issue) => {
        const ignoreReason = ignoreReasons[issue.id] ?? "";
        const busy = busyIssueId === issue.id;
        return (
          <article key={issue.id} data-severity={issue.severity}>
            <div><span>{issue.severity}</span><strong>{readableType(issue.type)}</strong><small>{Math.round(issue.confidence * 100)}% confidence</small></div>
            <p>{issue.evidence}</p>
            <small>{issue.sourcePath}</small>
            {issue.statusReason ? <small>Operator reason: {issue.statusReason}</small> : null}
            <div className="memory-issue-actions">
              {issue.recordId ? <button type="button" onClick={() => onOpenRecord(issue.recordId!)}>Open record</button> : null}
              {issue.status === "OPEN" ? (
                <>
                  <button type="button" disabled={busy} onClick={() => void update(issue, "RESOLVED")}>Resolve issue</button>
                  <label>
                    <span className="sr-only">Ignore reason for {readableType(issue.type)}</span>
                    <input
                      aria-label={`Ignore reason for ${readableType(issue.type)}`}
                      name={`memoryIgnoreReason:${issue.id}`}
                      value={ignoreReason}
                      placeholder="Required ignore reason"
                      maxLength={2000}
                      onChange={(event) => setIgnoreReasons((current) => ({ ...current, [issue.id]: event.currentTarget.value }))}
                    />
                  </label>
                  <button type="button" disabled={busy || !ignoreReason.trim()} onClick={() => void update(issue, "IGNORED")}>Ignore issue</button>
                </>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
