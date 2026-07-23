import type { Artifact } from "@space/contracts";

export const AGENT_PANE_ACTION_EVENT = "space:agent-pane-action";
export const AGENT_PANE_ATTACHMENTS_EVENT = "space:agent-pane-artifacts-attached";

type AgentPaneActionEventDetail =
  | {
      paneId: string;
      action:
        | "upload"
        | "plan"
        | "resume"
        | "copy"
        | "reconnect"
        | "interrupt"
        | "save_to_memory"
        | "new_task"
        | "attach_folder"
        | "manage_goal";
    }
  | { paneId: string; action: "insert_text"; text: string }
  | { paneId: string; action: "open_thread"; threadId: string };

type AgentPaneAttachmentsEventDetail = { paneId: string; artifacts: Artifact[] };
type PendingAgentPaneEvent =
  | { type: typeof AGENT_PANE_ACTION_EVENT; detail: AgentPaneActionEventDetail }
  | { type: typeof AGENT_PANE_ATTACHMENTS_EVENT; detail: AgentPaneAttachmentsEventDetail };

const activeAgentPaneTargets = new Map<string, number>();
const pendingAgentPaneEvents = new Map<string, PendingAgentPaneEvent[]>();

function enqueue(event: PendingAgentPaneEvent) {
  const queued = pendingAgentPaneEvents.get(event.detail.paneId) ?? [];
  queued.push(event);
  pendingAgentPaneEvents.set(event.detail.paneId, queued);
}

export function dispatchAgentPaneActionEvent(detail: AgentPaneActionEventDetail) {
  if ((activeAgentPaneTargets.get(detail.paneId) ?? 0) === 0) {
    enqueue({ type: AGENT_PANE_ACTION_EVENT, detail });
    return;
  }
  window.dispatchEvent(new CustomEvent(AGENT_PANE_ACTION_EVENT, { detail }));
}

export function dispatchAgentPaneAttachmentsEvent(detail: AgentPaneAttachmentsEventDetail) {
  if ((activeAgentPaneTargets.get(detail.paneId) ?? 0) === 0) {
    enqueue({ type: AGENT_PANE_ATTACHMENTS_EVENT, detail });
    return;
  }
  window.dispatchEvent(new CustomEvent(AGENT_PANE_ATTACHMENTS_EVENT, { detail }));
}

export function registerAgentPaneEventTarget(paneId: string): () => void {
  activeAgentPaneTargets.set(paneId, (activeAgentPaneTargets.get(paneId) ?? 0) + 1);

  const events = pendingAgentPaneEvents.get(paneId) ?? [];
  pendingAgentPaneEvents.delete(paneId);
  for (const event of events) {
    window.dispatchEvent(new CustomEvent(event.type, { detail: event.detail }));
  }

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const remainingTargets = (activeAgentPaneTargets.get(paneId) ?? 1) - 1;
    if (remainingTargets > 0) activeAgentPaneTargets.set(paneId, remainingTargets);
    else activeAgentPaneTargets.delete(paneId);
  };
}
