import { parseStreamEvent } from "../../app-shell-utils.js";
import { dispatchJobApplyLiveEvent } from "../job-apply-pane/live-events.js";
import { dispatchMailCopilotLiveEvent } from "../mail-copilot-pane/live-events.js";
import { dispatchMarketingCopilotLiveEvent } from "../marketing-copilot-pane/live-events.js";
import { dispatchFreelanceCopilotLiveEvent } from "../freelance-copilot-pane/live-events.js";
import { dispatchDesignLiveEvent } from "../design-pane/live-events.js";
import { dispatchAppStudioLiveEvent } from "../app-studio-pane/live-events.js";
import { dispatchSecurityCopilotLiveEvent } from "../security-copilot-pane/live-events.js";
import { dispatchMonitoringCopilotLiveEvent } from "../monitoring-copilot-pane/live-events.js";
import { dispatchVideoLiveEvent } from "../video-pane/live-events.js";
import type { PaneLiveEventDetail } from "./pane-live-events.js";

/** Each copilot's server-stream event type and the window event its pane listens to. */
const COPILOT_STREAMS: ReadonlyArray<readonly [string, (detail: PaneLiveEventDetail) => void]> = [
  ["JOB_APPLY_UPDATED", dispatchJobApplyLiveEvent],
  ["MAIL_COPILOT_UPDATED", dispatchMailCopilotLiveEvent],
  ["MARKETING_COPILOT_UPDATED", dispatchMarketingCopilotLiveEvent],
  ["FREELANCE_COPILOT_UPDATED", dispatchFreelanceCopilotLiveEvent],
  ["DESIGN_UPDATED", dispatchDesignLiveEvent],
  ["APP_STUDIO_UPDATED", dispatchAppStudioLiveEvent],
  ["SECURITY_COPILOT_UPDATED", dispatchSecurityCopilotLiveEvent],
  ["MONITORING_COPILOT_UPDATED", dispatchMonitoringCopilotLiveEvent],
  ["VIDEO_UPDATED", dispatchVideoLiveEvent]
];

/**
 * Copilot activity reaches its pane through a window event, so the pane refreshes without waiting for its poll.
 * Listens on the app's server event stream; returns the function that removes the listeners.
 */
export function forwardCopilotStreamEvents(source: Pick<EventSource, "addEventListener" | "removeEventListener">): () => void {
  const listeners = COPILOT_STREAMS.map(([type, dispatch]) => {
    const listener = (message: MessageEvent<string>) => {
      const event = parseStreamEvent(message.data);
      if (!event || event.type !== type || !event.paneId) return;
      dispatch({ paneId: event.paneId, roomId: event.roomId, eventId: event.id, message: event.message, payload: event.payload });
    };
    source.addEventListener(type, listener as EventListener);
    return [type, listener] as const;
  });
  return () => { for (const [type, listener] of listeners) source.removeEventListener(type, listener as EventListener); };
}
