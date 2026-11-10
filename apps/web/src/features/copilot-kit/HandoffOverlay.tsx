import type { BrowserHandoffRequest } from "@space/contracts";

/** Kept for existing callers. Handoff context is shown by the browser control icon and the Needs you card. */
export function HandoffOverlay(_props: {
  handoff: BrowserHandoffRequest;
  detail?: string | null;
  onTakeControl(): void;
  onReturnToAgent(): void;
}) { return null; }

export function HeldBrowserStrip(_props: { onReturnToAgent(): void }) { return null; }
