import type { BrowserHandoffRequest } from "@space/contracts";

/** Kept for existing callers. Handoff context is shown by the browser control icon and the Needs you card. */
export const HandoffOverlay: (props: {
  handoff: BrowserHandoffRequest;
  detail?: string | null;
  onTakeControl(): void;
  onReturnToAgent(): void;
}) => null = () => null;

export const HeldBrowserStrip: (props: { onReturnToAgent(): void }) => null = () => null;
