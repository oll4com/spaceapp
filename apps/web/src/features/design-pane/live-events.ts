import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** Design pane activity pushed by the server event stream (type DESIGN_UPDATED), re-dispatched per pane. */
const channel = createPaneLiveEvents<PaneLiveEventDetail>("space:design-updated");

export const dispatchDesignLiveEvent = channel.dispatch;
export const subscribeDesignLiveEvents = channel.subscribe;
