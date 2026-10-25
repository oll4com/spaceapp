/** A window event carrying one pane's server-stream updates (JOB_APPLY_UPDATED, MAIL_COPILOT_UPDATED), re-dispatched per pane. */
export interface PaneLiveEventDetail {
  paneId: string;
  roomId: string | null;
  eventId: string;
  message: string;
  payload: Record<string, unknown>;
}

export function createPaneLiveEvents<TDetail extends PaneLiveEventDetail = PaneLiveEventDetail>(eventName: string) {
  return {
    eventName,
    dispatch(detail: TDetail): void {
      window.dispatchEvent(new CustomEvent<TDetail>(eventName, { detail }));
    },
    /** Calls `listener` for this pane's live events; returns the unsubscribe function. */
    subscribe(paneId: string, listener: (detail: TDetail) => void): () => void {
      const handler = (event: Event) => {
        const detail = (event as CustomEvent<TDetail>).detail;
        if (detail && detail.paneId === paneId) listener(detail);
      };
      window.addEventListener(eventName, handler);
      return () => window.removeEventListener(eventName, handler);
    }
  };
}
