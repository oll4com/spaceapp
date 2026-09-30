/** Bounded, authenticated facts supplied to the persistent Live session. */
export interface LiveRoomContext {
  roomId: string;
  name: string;
  description: string | null;
  objective: string | null;
  revision: string;
  checkedAt: string;
  activitySummary?: { totalAgentPanes: number; running: number; idle: number; waitingForInput: number; stopped: number; unknown: number };
  panes: Array<{
    id: string;
    title: string;
    mode: string;
    runtimeId: string | null;
    status: string;
    activity?: "RUNNING" | "IDLE" | "WAITING_FOR_INPUT" | "STOPPED" | "UNKNOWN" | "NOT_APPLICABLE";
    configuredModelId: string | null;
    effectiveModelId: string | null;
    reasoningEffort: string | null;
    modelVerification: string;
    task: { id: string; title: string; status: string } | null;
  }>;
}
