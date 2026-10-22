/**
 * Reconnect delay for the browser pane's stream and audio sockets: doubles from baseMs up to a minute. A refused
 * handshake (403, e.g. an origin the API does not accept) looks like any close to the page, so without the cap rising
 * a page retried every 2 s forever (2026-10-19: ~480 refusals from three panes).
 */
export function browserReconnectDelayMs(failures: number, baseMs: number, maxMs = 60_000): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(failures, 0), 16));
}
