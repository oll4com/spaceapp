/** Queue item 39 (28/10 10:58 and 11:08 BKK): a wait that flickers re-raises the same WAITING event, and Nous ran a turn for each. */
export const NOUS_WAIT_LINE_REPEAT_MS = 60 * 60_000;

/**
 * Whether a WAITING/STUCK inbox line for a pane is new: the same pane, kind and question text within NOUS_WAIT_LINE_REPEAT_MS is not
 * sent again (the monitor still records the event); a changed text or an hour later is.
 */
export function createWaitLineGate(now: () => number = Date.now) {
  const sent = new Map<string, { text: string; at: number }>();
  return (paneId: string, kind: string, text: string): boolean => {
    const key = `${paneId}:${kind}`;
    const last = sent.get(key);
    if (last && last.text === text && now() - last.at < NOUS_WAIT_LINE_REPEAT_MS) return false;
    if (sent.size > 2_000) sent.clear();
    sent.set(key, { text, at: now() });
    return true;
  };
}
