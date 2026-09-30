import { createHash } from "node:crypto";
import type { LiveRoomContext, Pane, Room } from "@space/contracts";

export async function buildLiveRoomContext(input: {
  room: Room;
  panes: Pane[];
  objective?: string | null;
  inspect: (pane: Pane) => Promise<{
    state?: string; nativeTaskRef?: string | null; modelId?: string | null;
    configuredModelId?: string | null; effectiveModelId?: string | null; modelVerificationStatus?: string;
    tasks?: Array<{ taskId: string; title: string; status: string; timing?: { source: string } }>;
  }>;
}): Promise<LiveRoomContext> {
  const panes = await Promise.all(input.panes.filter(p => !p.isClosed).slice(0, 16).map(async pane => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      input.inspect(pane).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000); })
    ]).finally(() => clearTimeout(timer));
    const task = observed?.tasks?.at(-1);
    const isAgent = pane.mode === "TERMINAL" || pane.mode === "CHAT";
    const activity = !isAgent ? "NOT_APPLICABLE" as const
      : observed?.state === "EXITED" ? "STOPPED" as const
      : observed?.state === "WAITING_FOR_INPUT" ? "WAITING_FOR_INPUT" as const
      : observed?.state === "RUNNING" && task?.status === "RUNNING" && task.timing?.source === "NATIVE" ? "RUNNING" as const
      : observed?.state === "IDLE" && task?.status !== "RUNNING" ? "IDLE" as const
      : "UNKNOWN" as const;
    return {
      id: pane.id, title: pane.title, mode: pane.mode, runtimeId: pane.terminalRuntimeId ?? pane.providerId ?? null,
      status: observed?.state ?? "UNKNOWN", activity,
      configuredModelId: observed?.configuredModelId ?? pane.modelId ?? null,
      effectiveModelId: observed?.effectiveModelId ?? (observed?.modelVerificationStatus === "VERIFIED" ? observed.modelId ?? null : null),
      reasoningEffort: pane.reasoningEffort ?? null,
      modelVerification: observed?.modelVerificationStatus ?? "UNKNOWN",
      task: task ? { id: task.taskId, title: task.title.slice(0, 500), status: task.status } : null
    };
  }));
  const count = (activity: typeof panes[number]["activity"]) => panes.filter(p => p.activity === activity).length;
  const activitySummary = { totalAgentPanes: panes.filter(p => p.activity !== "NOT_APPLICABLE").length,
    running: count("RUNNING"), idle: count("IDLE"), waitingForInput: count("WAITING_FOR_INPUT"), stopped: count("STOPPED"), unknown: count("UNKNOWN") };
  const data = { roomId: input.room.id, name: input.room.name, description: input.room.description, objective: input.objective ?? null, panes, activitySummary };
  return { ...data, revision: createHash("sha256").update(JSON.stringify(data)).digest("hex"), checkedAt: new Date().toISOString() };
}
