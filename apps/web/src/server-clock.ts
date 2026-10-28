// The server's clock minus the browser's, from API responses' Date header (UX-004: a server clock behind the browser's).
// Its own module so the demo bundle can read it without the live API.
let serverClockOffsetMs = 0;

export function learnServerClock(response: Response) {
  // A cached answer's Date is stale: it would make an old pane look new and start a second CLI.
  if (response.status === 304 || response.headers?.get?.("age") != null) return;
  const serverMs = Date.parse(response.headers?.get?.("date") ?? "");
  if (Number.isFinite(serverMs)) serverClockOffsetMs = serverMs - Date.now();
}

/** Now on the server's clock; the browser's until an API response carried a Date header. */
export function serverNow(): number {
  return Date.now() + serverClockOffsetMs;
}
