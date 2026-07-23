import type { Artifact } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

interface AgentPaneDraftState {
  prompt: string;
  attachments: Artifact[];
}

const AGENT_PANE_DRAFT_STORAGE_PREFIX = "space.agentPaneDraft";

function safeSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return getSpaceRuntime().platform.sessionStorage;
  } catch {
    return null;
  }
}

function storageKeyFor(paneId: string): string {
  return `${AGENT_PANE_DRAFT_STORAGE_PREFIX}:${paneId}`;
}

export function readAgentPaneDraft(paneId: string): AgentPaneDraftState {
  const storage = safeSessionStorage();
  if (!storage) return { prompt: "", attachments: [] };
  try {
    const raw = storage.getItem(storageKeyFor(paneId));
    if (!raw) return { prompt: "", attachments: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { prompt: "", attachments: [] };
    const draft = parsed as Partial<AgentPaneDraftState>;
    return {
      prompt: typeof draft.prompt === "string" ? draft.prompt : "",
      attachments: Array.isArray(draft.attachments) ? (draft.attachments as Artifact[]).slice(0, 8) : []
    };
  } catch {
    return { prompt: "", attachments: [] };
  }
}

export function writeAgentPaneDraft(paneId: string, draft: AgentPaneDraftState) {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    if (!draft.prompt && draft.attachments.length === 0) {
      storage.removeItem(storageKeyFor(paneId));
      return;
    }
    storage.setItem(
      storageKeyFor(paneId),
      JSON.stringify({
        prompt: draft.prompt,
        attachments: draft.attachments.slice(0, 8)
      })
    );
  } catch {
    // Best effort only.
  }
}

export function clearAgentPaneDraft(paneId: string) {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(storageKeyFor(paneId));
  } catch {
    // Best effort only.
  }
}
