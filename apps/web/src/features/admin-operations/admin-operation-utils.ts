import type { AdminOperationRun } from "@space/contracts";

export const activeOperationStatuses = new Set<AdminOperationRun["status"]>(["QUEUED", "RUNNING"]);

export function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback;
}

function sameReleaseIdentity(left: AdminOperationRun, right: AdminOperationRun): boolean {
  return left.result.previewId === right.result.previewId &&
    left.result.tag === right.result.tag &&
    left.result.sourceCommit === right.result.sourceCommit;
}

function releaseRequestFromPartialRun(run: AdminOperationRun | undefined): {
  previewId: string;
  tag: string;
  notes: string;
} | null {
  if (!run || run.operationType !== "SPACE_RELEASE" || run.status !== "PARTIAL") return null;
  const previewId = run.result.previewId;
  const tag = run.result.tag;
  const notes = run.result.notes;
  if (typeof previewId !== "string" || typeof tag !== "string" || typeof notes !== "string") return null;
  return { previewId, tag, notes };
}

export function releaseRequestFromRuns(runs: AdminOperationRun[]): {
  previewId: string;
  tag: string;
  notes: string;
} | null {
  const latest = runs.find((run) => run.operationType === "SPACE_RELEASE");
  if (!latest) return null;
  if (latest.status === "PARTIAL") return releaseRequestFromPartialRun(latest);
  if (latest.status !== "FAILED" || typeof latest.result.retryOfRunId !== "string") return null;
  const partial = runs.find((run) =>
    run.id === latest.result.retryOfRunId &&
    run.status === "PARTIAL" &&
    sameReleaseIdentity(run, latest)
  );
  return releaseRequestFromPartialRun(partial);
}
