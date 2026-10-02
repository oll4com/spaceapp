import type { PlatformGateway, SpaceRuntime } from "../runtime/SpaceRuntime.js";
import { DEMO_LOCAL_REPLY, DemoStore } from "./DemoStore.js";
import type { DemoFixture } from "./demo-fixture.js";
import { MockBrowserSocket } from "./mock-browser-socket.js";
import { handleCliMockInput } from "./mock-cli-transcripts.js";

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
  private input = "";
  private paneId: string;
  private sessionId: string;
  private runtimeId: string;

  constructor(url: string) {
    super();
    this.url = url;
    const parsed = new URL(url);
    this.paneId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    this.sessionId = parsed.searchParams.get("sessionId") ?? `cli_session:${this.paneId}`;
    this.runtimeId = parsed.searchParams.get("runtimeId") ?? "cli:codex";
    queueMicrotask(() => {
      if (this.readyState !== this.CONNECTING) return;
      this.readyState = this.OPEN;
      this.emit("open", new Event("open"));
      this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "ready", paneId: this.paneId, sessionId: this.sessionId, runtimeId: this.runtimeId }) }));
      this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "status", status: "RUNNING", statusReason: "Local demo terminal is ready." }) }));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (this.readyState !== this.OPEN || typeof data !== "string") return;
    let payload: { type?: string; data?: string } | null = null;
    try { payload = JSON.parse(data) as { type?: string; data?: string }; } catch { return; }
    if (payload.type === "ping") {
      this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "pong" }) }));
      return;
    }
    if (payload.type !== "input") return;
    let output = "";
    for (const char of payload.data ?? "") {
      if (char === "\u0003") { this.input = ""; output += "^C\r\n> "; }
      else if (char === "\u007f" || char === "\b") {
        if (this.input) { this.input = this.input.slice(0, -1); output += "\b \b"; }
      } else if (char === "\r" || char === "\n") {
        const command = this.input.trim();
        this.input = "";
        output += handleCliMockInput(this.runtimeId, command);
      } else if (char >= " ") {
        this.input += char;
        output += char;
      }
    }
    if (!output) return;
    queueMicrotask(() => {
      this.emit("message", new MessageEvent("message", { data: JSON.stringify({ type: "output", stream: "stdout", data: output }) }));
    });
  }

  close(code = 1000, reason = "Demo socket closed") {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    const event = typeof CloseEvent !== "undefined"
      ? new CloseEvent("close", { code, reason, wasClean: true })
      : Object.assign(new Event("close"), { code, reason, wasClean: true });
    this.onclose?.(event as CloseEvent);
    this.dispatchEvent(event);
  }

  private emit(type: "open" | "message", event: Event | MessageEvent) {
    if (type === "open") this.onopen?.(event);
    else this.onmessage?.(event as MessageEvent);
    this.dispatchEvent(event);
  }
}

export function createDemoRuntime(options: { fixture?: DemoFixture; localStorage?: Storage; sessionStorage?: Storage } = {}): { runtime: SpaceRuntime; store: DemoStore } {
  const store = new DemoStore(options.fixture);
  const localStorage = options.localStorage ?? new MemoryStorage();
  const sessionStorage = options.sessionStorage ?? new MemoryStorage();
  if (!options.localStorage) resetDemoStorage(localStorage, sessionStorage);
  if (options.localStorage) store.restoreSnapshot(localStorage.getItem("workspace.snapshot"));
  const client = options.localStorage ? new Proxy(store.api, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (/^(create|update|set|delete|clear|send|move|close|reorder|save|upload)|^files(Create|Write|Rename|Delete|Upload|Chmod)$|^demo(Save|Start|Stop|Restart|RunTests)/.test(String(property))) {
          void Promise.resolve(result).then(() => localStorage.setItem("workspace.snapshot", store.snapshot())).catch(() => undefined);
        }
        return result;
      };
    }
  }) : store.api;
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
    resolveExternalResource: (url) => options.fixture && /stream|radio.*\.mp3/.test(url) ? `${import.meta.env.BASE_URL}demo/media/space-loop-1.mp3` : null,
    fetch: async () => { throw new TypeError("Demo runtime blocks network requests."); },
    openLink: () => null,
    print: () => undefined,
    reloadPage: options.localStorage ? () => window.location.reload() : reset,
    getUserMedia: async () => { throw new DOMException("Demo runtime blocks media capture.", "NotAllowedError"); },
    createPeerConnection: () => { throw new DOMException("Demo runtime blocks WebRTC.", "NotAllowedError"); },
    getDisplayMedia: async () => { throw new DOMException("Demo runtime blocks display capture.", "NotAllowedError"); },
    createAudio: () => document.createElement("audio")
  };
  const runtime: SpaceRuntime = {
    kind: "demo",
    api: client,
    events: { supported: true, open: (url) => new LocalEventSource(url) as unknown as EventSource },
    terminal: { supported: true, connect: (url) => new LocalTerminalSocket(url) as unknown as WebSocket },
    browser: options.fixture ? { supported: true, connect: url => new MockBrowserSocket(url, client) as unknown as WebSocket } : { supported: false, connect: () => { throw new TypeError("Demo browser uses a local canvas fixture."); } },
    platform,
    reset
  };
  return { runtime, store };
}

export const demoRuntimeBundle = createDemoRuntime();
