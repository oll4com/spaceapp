import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** Freelance Copilot activity pushed by the server event stream (type FREELANCE_COPILOT_UPDATED), re-dispatched per pane. */
const channel = createPaneLiveEvents<PaneLiveEventDetail>("space:freelance-copilot-updated");

export const dispatchFreelanceCopilotLiveEvent = channel.dispatch;
export const subscribeFreelanceCopilotLiveEvents = channel.subscribe;
