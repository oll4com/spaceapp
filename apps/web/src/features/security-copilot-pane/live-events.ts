import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** Security Copilot activity pushed by the server event stream (type SECURITY_COPILOT_UPDATED), re-dispatched per pane. */
const channel = createPaneLiveEvents<PaneLiveEventDetail>("space:security-copilot-updated");

export const dispatchSecurityCopilotLiveEvent = channel.dispatch;
export const subscribeSecurityCopilotLiveEvents = channel.subscribe;
