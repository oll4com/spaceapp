import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** Video pane activity pushed by the server event stream (type VIDEO_UPDATED), re-dispatched per pane. */
const channel = createPaneLiveEvents<PaneLiveEventDetail>("space:video-updated");

export const dispatchVideoLiveEvent = channel.dispatch;
export const subscribeVideoLiveEvents = channel.subscribe;
