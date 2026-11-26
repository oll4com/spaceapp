export const PANE_NOT_FOUND_EVENT = "space-pane-not-found";

// 14/11: a pane deleted elsewhere (another window, Nous, a room delete) kept a warm room's hidden panes polling 404s;
// the app drops what the server no longer has when it hears this.
export function reportMissingPane(url: string, status: number, message: string | undefined): void {
  const encoded = status === 404 ? /^\/api\/panes\/([^/?]+)/.exec(url)?.[1] : undefined;
  if (!encoded || typeof window === "undefined") return;
  const paneId = decodeURIComponent(encoded);
  if (message?.includes(`Pane ${paneId} was not found`)) {
    window.dispatchEvent(new CustomEvent(PANE_NOT_FOUND_EVENT, { detail: { paneId } }));
  }
}

export function isRoomNotFoundError(error: unknown, roomId: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes("NOT_FOUND") && error.message.includes(`Room ${roomId} was not found`);
}
