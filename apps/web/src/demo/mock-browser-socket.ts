import type { SpaceApiClient } from "../runtime/SpaceRuntime.js";

export class MockBrowserSocket extends EventTarget {
  readyState = 0; binaryType: BinaryType = "blob";
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(readonly url: string, private readonly api: SpaceApiClient) {
    super(); const paneId = decodeURIComponent(new URL(url).pathname.slice(1));
    queueMicrotask(() => {
      if (this.readyState !== 0) return; this.readyState = 1; this.dispatchEvent(new Event("open"));
      this.emit({ type: "ready", paneId, sessionId: `browser_session:${paneId}` });
      const frame = async () => { const value = await api.browserFrame(paneId, `browser_session:${paneId}`); if (this.readyState === 1) this.emit({ type: "frame", frame: { ...value, capturedAt: new Date().toISOString() } }); };
      void frame(); this.timer = setInterval(() => void frame(), 1000);
    });
  }
  send(_data: unknown) {}
  close() { if (this.timer) clearInterval(this.timer); this.readyState = 3; this.dispatchEvent(new CloseEvent("close", { code: 1000, wasClean: true })); }
  private emit(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
