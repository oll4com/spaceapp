export type AgentPaneActionAvailability = {
  /** A Chat provider and model are configured. */
  chatEnabled: boolean;
  hasSession: boolean;
  /** A Dot transition holds the session lock. */
  locked: boolean;
  running: boolean;
  /** Mode changes, quick messages and new tasks are refused (running, pending, uploading, goal active, ...). */
  blocked: boolean;
  /** The session accepts new messages. */
  canSend: boolean;
  /** The transcript has visible messages to copy, resume, save or title. */
  hasContent: boolean;
  collaborationMode: string | null;
  pending: boolean;
  /** The Dot bound to this Chat; only its sessions in this room can be reopened from Task history. */
  dotId: string | null;
};

export function agentActionAvailabilityEqual(left: AgentPaneActionAvailability, right: AgentPaneActionAvailability): boolean {
  return (Object.keys(left) as Array<keyof AgentPaneActionAvailability>).every((key) => left[key] === right[key]);
}

const CHAT_DISABLED_REASON = "Enable a Chat provider in Settings";

function busyReason(availability: AgentPaneActionAvailability): string | null {
  if (availability.running) return "Wait for the current Chat turn to finish.";
  if (availability.locked) return "The Chat is switching Dots.";
  return availability.blocked ? "The Chat is busy. Try again in a moment." : null;
}

/**
 * Why a Chat pane menu action cannot run right now, or null when it can. Mirrors the guards in
 * AgentPane's action listener so a click never ends in a silent no-op.
 */
export function agentActionDisabledReason(actionId: string, availability: AgentPaneActionAvailability | null): string | null {
  const known = ["import", "generate-title", "plan", "resume", "stop", "memory", "copy", "reconnect", "new_task", "task_history", "attach_folder", "manage_goal"];
  if (!known.includes(actionId)) return null;
  if (!availability) return actionId === "reconnect" ? null : "The Chat is still loading.";
  if (actionId === "copy") return availability.hasContent ? null : "There are no visible Chat contents to copy.";
  if (actionId === "stop") return availability.running ? null : "No running Chat task to stop.";
  if (actionId === "reconnect") {
    if (availability.locked) return null;
    if (!availability.chatEnabled) return CHAT_DISABLED_REASON;
    return availability.pending ? "The Chat is busy. Try again in a moment." : null;
  }
  if (!availability.chatEnabled) return CHAT_DISABLED_REASON;
  if (actionId === "generate-title") return availability.hasContent ? null : "Send a first message before generating a title.";
  if (availability.locked) return "The Chat is switching Dots.";
  if (actionId === "import" || actionId === "attach_folder" || actionId === "manage_goal") return null;
  if (!availability.hasSession) return "The Chat session is still loading.";
  if (actionId === "plan" && availability.collaborationMode === "plan") return "Plan mode is already on.";
  const busy = busyReason(availability);
  if (busy) return busy;
  if (actionId === "resume" || actionId === "memory") {
    if (!availability.canSend) return "This Chat cannot send messages right now.";
    if (!availability.hasContent) return actionId === "resume" ? "There is no Chat task to resume yet." : "There is no Chat task to save yet.";
  }
  return null;
}
