import type { BrowserHandoffRequest, JobApplication } from "@space/contracts";
import { HandoffOverlay as CopilotHandoffOverlay } from "../copilot-kit/HandoffOverlay.js";

/** The copilot kit's handoff overlay with the posting the Job Copilot works on. */
export function HandoffOverlay({ handoff, posting, onTakeControl, onReturnToAgent }: {
  handoff: BrowserHandoffRequest;
  posting: JobApplication | null;
  onTakeControl(): void;
  onReturnToAgent(): void;
}) {
  return <CopilotHandoffOverlay handoff={handoff} detail={posting ? `${posting.company} · ${posting.role}` : null} onTakeControl={onTakeControl} onReturnToAgent={onReturnToAgent} />;
}
