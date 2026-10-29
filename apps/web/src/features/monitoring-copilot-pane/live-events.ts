import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** Monitoring Copilot activity pushed by the server event stream (type MONITORING_COPILOT_UPDATED), re-dispatched per pane. */
const channel = createPaneLiveEvents<PaneLiveEventDetail>("space:monitoring-copilot-updated");

export const dispatchMonitoringCopilotLiveEvent = channel.dispatch;
export const subscribeMonitoringCopilotLiveEvents = channel.subscribe;
