/** noVNC-compatible local transport; retains the canonical VNC pane controls. */
export default class MockRFB extends EventTarget {
  viewOnly = false; scaleViewport = true; resizeSession = false; focusOnClick = true;
  private readonly frame: HTMLIFrameElement;
  constructor(private readonly container: HTMLElement, _url: string, _options?: unknown) {
    super(); this.frame = document.createElement("iframe");
    this.frame.src = `${import.meta.env.BASE_URL}demo/media/vnc-preview.html`;
    this.frame.title = "Local desktop preview";
    this.frame.style.cssText = "border:0;width:100%;height:100%;min-height:280px";
    container.append(this.frame);
    queueMicrotask(() => { this.dispatchEvent(new Event("connect")); this.dispatchEvent(new CustomEvent("desktopname", { detail: { name: "Demo desktop" } })); });
  }
  disconnect() { this.frame.remove(); this.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: true, message: "Disconnected." } })); }
  requestFullscreen() { void this.container.requestFullscreen?.().catch(() => undefined); }
}
