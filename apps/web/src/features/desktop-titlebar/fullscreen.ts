/** Desktop fullscreen belongs to the native window so Escape remains available to the UI and terminals. */
type VendorFullscreenCall = () => Promise<void> | void;
type VendorDocument = Document & {
  webkitFullscreenElement?: Element | null; mozFullScreenElement?: Element | null; msFullscreenElement?: Element | null;
  webkitExitFullscreen?: VendorFullscreenCall; mozCancelFullScreen?: VendorFullscreenCall; msExitFullscreen?: VendorFullscreenCall;
};
type VendorElement = HTMLElement & { webkitRequestFullscreen?: VendorFullscreenCall; mozRequestFullScreen?: VendorFullscreenCall; msRequestFullscreen?: VendorFullscreenCall };

export function isDocumentFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as VendorDocument;
  return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || doc.msFullscreenElement);
}

export async function toggleBrowserFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  try {
    const bridge = (window as unknown as { spaceDesktop?: { toggleFullscreen?: () => unknown } }).spaceDesktop;
    if (typeof bridge?.toggleFullscreen === "function") {
      await bridge.toggleFullscreen();
      return;
    }
    const doc = document as VendorDocument;
    const element = document.documentElement as VendorElement;
    if (isDocumentFullscreen()) {
      await (doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen)?.call(doc);
    } else {
      await (element.requestFullscreen || element.webkitRequestFullscreen || element.mozRequestFullScreen || element.msRequestFullscreen)?.call(element);
    }
  } catch (err) {
    console.warn("Browser fullscreen toggle failed:", err);
  }
}
