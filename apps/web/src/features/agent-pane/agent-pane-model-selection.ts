// Remembers the last model/provider/reasoning the operator picked in THIS Chat pane,
// so closing and reopening the pane restores that selection instead of resetting to the
// provider default. Keyed per pane; a "new task" (explicit reset) clears it.
export interface AgentPaneModelSelection {
  modelId: string;
  reasoningEffort: string;
  providerId: string | null;
}

const storageKeyPrefix = "space.agentPane.modelSelection.v1.";

function storageKey(paneId: string): string {
  return `${storageKeyPrefix}${paneId}`;
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readAgentPaneModelSelection(paneId: string): AgentPaneModelSelection | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey(paneId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AgentPaneModelSelection>;
    if (typeof parsed.modelId !== "string" || !parsed.modelId) return null;
    if (typeof parsed.reasoningEffort !== "string" || !parsed.reasoningEffort) return null;
    const providerId = typeof parsed.providerId === "string" && parsed.providerId ? parsed.providerId : null;
    return { modelId: parsed.modelId, reasoningEffort: parsed.reasoningEffort, providerId };
  } catch {
    return null;
  }
}

export function writeAgentPaneModelSelection(paneId: string, selection: AgentPaneModelSelection): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(paneId), JSON.stringify(selection));
  } catch {
    // Best effort: a full or blocked localStorage must never break the pane.
  }
}

export function clearAgentPaneModelSelection(paneId: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.removeItem(storageKey(paneId));
  } catch {
    // Best effort.
  }
}
