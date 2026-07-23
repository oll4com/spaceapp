import type { PlatformGateway, SpaceRuntime } from "../runtime/SpaceRuntime.js";
import { DEMO_LOCAL_REPLY, DemoStore } from "./DemoStore.js";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

const DEMO_LOCAL_STORAGE_FIXTURE = {
  "space.room.theme": "graphite",
  "space.roomFocusMode": "true",
  "space.roomsRailHidden": "false"
} as const;

function resetDemoStorage(localStorage: Storage, sessionStorage: Storage): void {
  localStorage.clear();
  sessionStorage.clear();
  for (const [key, value] of Object.entries(DEMO_LOCAL_STORAGE_FIXTURE)) {
    localStorage.setItem(key, value);
  }
}

class LocalEventSource extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly url: string;
  readonly withCredentials = false;
  readyState = this.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => {
      if (this.readyState === this.CLOSED) return;
      this.readyState = this.OPEN;
      const event = new Event("open");
      this.onopen?.(event);
      this.dispatchEvent(event);
    });
  }

  close() {
    this.readyState = this.CLOSED;
  }
}

class LocalTerminalSocket extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readonly protocol = "";
  readonly extensions = "";
  readonly bufferedAmount = 0;
  binaryType: BinaryType = "blob";
  readyState = this.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = url;
    queueMicrotask(() => {
      if (this.readyState !== this.CONNECTING) return;
      this.readyState = this.OPEN;
      this.emit("open", new Event("open"));
      const parsed = new URL(url);
      const paneId = decodeURIComponent(parsed.pathname.slice(1));
      const sessionId = parsed.searchParams.get("sessionId") ?? `cli_session:${paneId}`;
      const runtimeId = paneId.includes("root") ? "root" : paneId.includes("opencode") ? "opencode" : "codex";
      this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "ready", paneId, sessionId, runtimeId }) }));
      this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "status", status: "RUNNING", statusReason: "Local demo terminal is ready." }) }));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== this.OPEN || typeof data !== "string") return;
    let payload: { type?: string; data?: string } | null = null;
    try { payload = JSON.parse(data) as { type?: string; data?: string }; } catch { return; }
    if (payload.type !== "input") return;
    queueMicrotask(() => {
      this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: `\r\n${DEMO_LOCAL_REPLY}\r\n` }) }));
    });
  }

  close(code = 1000, reason = "Demo socket closed") {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    const event = new CloseEvent("close", { code, reason, wasClean: true });
    this.onclose?.(event);
    this.dispatchEvent(event);
  }

  private emit(type: "open" | "message", event: Event | MessageEvent) {
    if (type === "open") this.onopen?.(event);
    else this.onmessage?.(event as MessageEvent);
    this.dispatchEvent(event);
  }
}

export function createDemoRuntime(): { runtime: SpaceRuntime; store: DemoStore } {
  const store = new DemoStore();
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  resetDemoStorage(localStorage, sessionStorage);
  let clipboardText = "";
  const reset = () => {
    store.reset();
    resetDemoStorage(localStorage, sessionStorage);
    clipboardText = "";
  };
  const clipboard = {
    read: async () => [],
    readText: async () => clipboardText,
    write: async () => undefined,
    writeText: async (text: string) => { clipboardText = text; }
  } as Pick<Clipboard, "read" | "readText" | "write" | "writeText">;
  const platform: PlatformGateway = {
    localStorage,
    sessionStorage,
    clipboard,
    userMediaSupported: false,
    peerConnectionSupported: false,
    displayMediaSupported: false,
    resolveExternalResource: () => null,
    fetch: async () => { throw new TypeError("Demo runtime blocks network requests."); },
    openLink: () => null,
    print: () => undefined,
    reloadPage: reset,
    getUserMedia: async () => { throw new DOMException("Demo runtime blocks media capture.", "NotAllowedError"); },
    createPeerConnection: () => { throw new DOMException("Demo runtime blocks WebRTC.", "NotAllowedError"); },
    getDisplayMedia: async () => { throw new DOMException("Demo runtime blocks display capture.", "NotAllowedError"); },
    createAudio: () => document.createElement("audio")
  };
  const runtime: SpaceRuntime = {
    kind: "demo",
    api: store.api,
    events: { supported: true, open: (url) => new LocalEventSource(url) as unknown as EventSource },
    terminal: { supported: true, connect: (url) => new LocalTerminalSocket(url) as unknown as WebSocket },
    browser: { supported: false, connect: () => { throw new TypeError("Demo browser uses a local canvas fixture."); } },
    platform,
    reset
  };
  return { runtime, store };
}

export const demoRuntimeBundle = createDemoRuntime();
