import type { Terminal } from "@xterm/xterm";

/** A local presentation frame, never a terminal, input buffer, or persisted transcript. */
export function holdTerminalReconnectFrame(host: HTMLElement) {
  const viewport = host.parentElement;
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  const rows = screen?.querySelector<HTMLElement>(".xterm-rows");
  const bounds = host.getBoundingClientRect();
  const originalSurface = screen?.closest<HTMLElement>(".xterm");
  if (!host.isConnected || !viewport || !screen || !originalSurface || !rows?.childElementCount || bounds.width <= 0 || bounds.height <= 0) return null;
  const frame = host.ownerDocument.createElement("div");
  frame.dataset.terminalReconnectFrame = "true";
  frame.setAttribute("aria-hidden", "true");
  frame.inert = true;
  Object.assign(frame.style, { position: "absolute", inset: "0", zIndex: "3", overflow: "hidden",
    pointerEvents: "none", userSelect: "none", background: "#090b0c" });
  const surface = host.ownerDocument.createElement("div");
  surface.className = originalSurface.className;
  const surfaceStyle = host.ownerDocument.defaultView!.getComputedStyle(originalSurface);
  const screenBounds = screen.getBoundingClientRect();
  const viewportBounds = viewport.getBoundingClientRect();
  // The installed xterm wraps its screen in a scrollable element. Preserve the
  // owner root's scoped CSS, and use the painted screen offset (including padding).
  Object.assign(surface.style, { position: "absolute", padding: "0", margin: "0",
    left: `${screenBounds.left - viewportBounds.left - viewport.clientLeft}px`,
    top: `${screenBounds.top - viewportBounds.top - viewport.clientTop}px`,
    width: `${screenBounds.width}px`, height: `${screenBounds.height}px`,
    fontFamily: surfaceStyle.fontFamily, fontSize: surfaceStyle.fontSize });
  const painted = host.ownerDocument.createElement("div");
  painted.style.cssText = screen.style.cssText;
  // Preserve renderer-scoped cell/font/color CSS without cloning input helpers,
  // selection, scrollback, listeners, or a second .xterm-screen identity.
  for (const style of screen.querySelectorAll(":scope > style")) painted.append(style.cloneNode(true));
  painted.append(rows.cloneNode(true));
  surface.append(painted);
  frame.append(surface);
  viewport.append(frame);
  const ownerWindow = host.ownerDocument.defaultView!;
  let subscription: { dispose(): void } | null = null;
  let disposed = false;
  // A failed attach must never leave an indefinitely frozen image over errors.
  const timeout = ownerWindow.setTimeout(() => dispose("timeout"), 10_000);
  function dispose(reason: "paint" | "timeout" | "disposed" = "disposed") {
    if (disposed) return;
    disposed = true;
    ownerWindow.clearTimeout(timeout);
    subscription?.dispose(); subscription = null;
    frame.dataset.releaseReason = reason;
    frame.remove();
  }
  return { dispose, releaseAfterPaint(terminal: Terminal, ready: { replay: boolean; geometry: boolean }) {
    if (disposed || subscription || !ready.replay || !ready.geometry) return;
    subscription = terminal.onRender(() => dispose("paint"));
    terminal.refresh(0, terminal.rows - 1);
  } };
}
