import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** Marketing Copilot activity pushed by the server event stream (type MARKETING_COPILOT_UPDATED), re-dispatched per pane. */
const channel = createPaneLiveEvents<PaneLiveEventDetail>("space:marketing-copilot-updated");

export const dispatchMarketingCopilotLiveEvent = channel.dispatch;
export const subscribeMarketingCopilotLiveEvents = channel.subscribe;
