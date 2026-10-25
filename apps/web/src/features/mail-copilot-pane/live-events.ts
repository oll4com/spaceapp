import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** Mail Copilot activity pushed by the server event stream (type MAIL_COPILOT_UPDATED), re-dispatched per pane. */
export const MAIL_COPILOT_LIVE_EVENT = "space:mail-copilot-updated";

export type MailCopilotLiveEventDetail = PaneLiveEventDetail;

const channel = createPaneLiveEvents<MailCopilotLiveEventDetail>(MAIL_COPILOT_LIVE_EVENT);

export const dispatchMailCopilotLiveEvent = channel.dispatch;
export const subscribeMailCopilotLiveEvents = channel.subscribe;
