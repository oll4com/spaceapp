import type { Pane, PaneCliSession } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";

export type DashboardStatus = "working" | "waiting" | "done" | "idle";

// Metadata reads only: never start a CLI, attach a transport or mount a room.
export async function readDashboardActivity(panes: Pane[], store: SpaceStore,
  readCliStatus: (session: PaneCliSession) => Promise<DashboardStatus | null>) {
  const activity: Record<string, DashboardStatus> = {};
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, panes.length) }, async () => {
    while (cursor < panes.length) {
      const pane = panes[cursor++]!;
      if (pane.isClosed) continue;
      if (pane.mode === "TERMINAL" && pane.terminalRuntimeId !== "cli:root") {
        const session = await store.getActivePaneCliSession(pane.id);
        if (!session || session.purpose !== "NORMAL" || session.status === "EXITED") {
          activity[pane.id] = "idle";
        } else if (session.status === "ERROR") {
          activity[pane.id] = "waiting";
        } else {
          const status = await readCliStatus(session);
          if (status !== null) activity[pane.id] = status;
        }
      } else if (pane.mode === "CHAT") {
        const session = await store.getActiveSpaceAgentSession(pane.id);
        if (!session?.isActive) continue;
        const run = await store.getLatestSpaceAgentRun(session.sessionId);
        if (run?.status === "RUNNING" || run?.status === "QUEUED") activity[pane.id] = "working";
        else if (run?.status === "COMPLETED") activity[pane.id] = "done";
        else if (run?.status === "FAILED") activity[pane.id] = "waiting";
        else activity[pane.id] = "idle";
      }
    }
  }));
  return activity;
}
