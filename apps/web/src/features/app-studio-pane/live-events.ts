import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** App Studio activity pushed by the server event stream (type APP_STUDIO_UPDATED), re-dispatched per pane. */
const channel = createPaneLiveEvents<PaneLiveEventDetail>("space:app-studio-updated");

export const dispatchAppStudioLiveEvent = channel.dispatch;
export const subscribeAppStudioLiveEvents = channel.subscribe;
