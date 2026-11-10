/** A toast/native push can open Nous before its lazy dock mounts. Keep the requested view until that mount consumes it. */
export const NOUS_DONE_OPEN_EVENT = "space:nous-done-open";
let pending = false;
export function requestDoneView(): void {
  pending = true;
  window.dispatchEvent(new Event(NOUS_DONE_OPEN_EVENT));
}
export function consumeDoneView(): boolean {
  const requested = pending;
  pending = false;
  return requested;
}
/** The same for Nous › Updates (R73): a click on an update's toast or pop-up opens that view. */
let updatesPending = false;
export function requestUpdatesView(): void {
  updatesPending = true;
  window.dispatchEvent(new Event(NOUS_DONE_OPEN_EVENT));
}
export function consumeUpdatesView(): boolean {
  const requested = updatesPending;
  updatesPending = false;
  return requested;
}
