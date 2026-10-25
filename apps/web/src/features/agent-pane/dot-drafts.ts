import type { DotProfile } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { clearAgentPaneDraft, readAgentPaneDraft, writeAgentPaneDraft, type AgentPaneDraftState } from "./agent-pane-draft.js";

// Dot IDs include immutable owner identity; retain the explicit owner scope too.
const key = (paneId: string, dot: Pick<DotProfile, "dotId" | "ownerUserId">) =>
  `dot.v2:${encodeURIComponent(dot.ownerUserId)}:${encodeURIComponent(paneId)}:${dot.dotId}`;
export function readDotDraft(paneId: string, dot: DotProfile): AgentPaneDraftState {
  const scopedKey = key(paneId, dot);
  if (dot.slot === 1) {
    try {
      const storage = getSpaceRuntime().platform.sessionStorage;
      const marker = `space.dotDraftMigration:${encodeURIComponent(dot.ownerUserId)}:${encodeURIComponent(paneId)}`;
      if (!storage.getItem(marker)) {
        if (!storage.getItem(`space.agentPaneDraft:${scopedKey}`)) writeAgentPaneDraft(scopedKey, readAgentPaneDraft(paneId));
        storage.setItem(marker, "1");
        clearAgentPaneDraft(paneId);
      }
    } catch { /* Draft persistence remains best effort, like legacy drafts. */ }
  }
  return readAgentPaneDraft(scopedKey);
}
export function writeDotDraft(paneId: string, dot: DotProfile, draft: AgentPaneDraftState): void {
  writeAgentPaneDraft(key(paneId, dot), draft);
}
export function clearDotDraft(paneId: string, dot: DotProfile): void {
  clearAgentPaneDraft(key(paneId, dot));
}
