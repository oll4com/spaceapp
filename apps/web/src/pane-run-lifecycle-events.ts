export const PANE_RUN_LIFECYCLE_EVENT = "space:pane-run-lifecycle";

export type PaneRunLifecycleStatus = "STARTED" | "COMPLETED" | "FAILED";

export interface PaneRunLifecycleDetail {
  roomId: string;
  paneId: string;
  runKey: string;
  status: PaneRunLifecycleStatus;
  occurredAt: string;
}

export function publishPaneRunLifecycle(
  detail: Omit<PaneRunLifecycleDetail, "occurredAt"> & { occurredAt?: string }
): void {
  window.dispatchEvent(new CustomEvent<PaneRunLifecycleDetail>(PANE_RUN_LIFECYCLE_EVENT, {
    detail: { ...detail, occurredAt: detail.occurredAt ?? new Date().toISOString() }
  }));
}
