import { useCallback, useEffect, useState } from "react";
import type { MemoryGraphIssue } from "@space/contracts";
import { AlertTriangle } from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import { MemoryChangeSetPanel } from "./MemoryChangeSetPanel.js";
import { MemoryIssueList } from "./MemoryIssueList.js";
import { MemoryJobsPanel } from "./MemoryJobsPanel.js";

/** ADR-006's review surfaces: open maintenance issues, change sets and maintenance jobs (desktop and tablet). */
export function MemoryReviewView({ onOpenRecord }: { onOpenRecord: (recordId: string) => void }) {
  const [issues, setIssues] = useState<MemoryGraphIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onError = useCallback((caught: unknown) => setError(caught instanceof Error ? caught.message : "The memory review action failed."), []);

  useEffect(() => {
    let active = true;
    void api.memoryGraphIssues({ status: "OPEN", pageSize: 100 })
      .then(payload => { if (active) setIssues(payload.data); })
      .catch(caught => { if (active) onError(caught); });
    return () => { active = false; };
  }, [onError]);

  return (
    <div className="memory-review" aria-label="Memory review">
      {error ? <div className="memory-workspace-error" role="alert"><AlertTriangle aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div> : null}
      <MemoryJobsPanel onError={onError} />
      <div className="memory-review-issues">
        <h3>Open issues</h3>
        {issues ? (
          <MemoryIssueList
            issues={issues}
            status="OPEN"
            onOpenRecord={onOpenRecord}
            onUpdated={updated => setIssues(current => current?.filter(issue => issue.id !== updated.id || updated.status === "OPEN") ?? null)}
            onError={onError}
          />
        ) : error ? null : <p role="status">Loading issues…</p>}
      </div>
      <MemoryChangeSetPanel />
    </div>
  );
}
