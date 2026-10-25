/** Desktop fullscreen belongs to the native window so Escape remains available to the UI and terminals. */
export function isDocumentFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as any;
  return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement);
}

export async function toggleBrowserFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  try {
    const bridge = (window as any).spaceDesktop;
    if (typeof bridge?.toggleFullscreen === "function") {
      await bridge.toggleFullscreen();
      return;
    }
    const doc = document as any;
    const element = document.documentElement as any;
    if (isDocumentFullscreen()) {
      await (doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen)?.call(doc);
    } else {
      await (element.requestFullscreen || element.webkitRequestFullscreen || element.mozRequestFullScreen || element.msRequestFullscreen)?.call(element);
    }
  } catch (err) {
    console.warn("Browser fullscreen toggle failed:", err);
  }
}
