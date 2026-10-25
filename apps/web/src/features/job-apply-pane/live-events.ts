import { createPaneLiveEvents, type PaneLiveEventDetail } from "../copilot-kit/pane-live-events.js";

/** Job Copilot activity pushed by the server event stream (type JOB_APPLY_UPDATED), re-dispatched per pane. */
export const JOB_APPLY_LIVE_EVENT = "space:job-apply-updated";

export type JobApplyLiveEventDetail = PaneLiveEventDetail;

const channel = createPaneLiveEvents<JobApplyLiveEventDetail>(JOB_APPLY_LIVE_EVENT);

export const dispatchJobApplyLiveEvent = channel.dispatch;
export const subscribeJobApplyLiveEvents = channel.subscribe;
