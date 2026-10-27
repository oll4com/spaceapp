// Each document gets a fresh demo. Keep older physical workspaces untouched.
const PREFIX = "spaceapp.demoappnew.current.v2.";

class ScopedStorage implements Storage {
  readonly __spaceDemoScoped = true;
  private readonly memory = new Map<string, string>();
  constructor(private readonly physical: Storage | null, private readonly prefix: string) {}
  private keys(): string[] {
    const keys = new Set(this.memory.keys());
    try {
      for (let i = 0; i < (this.physical?.length ?? 0); i++) {
        const key = this.physical!.key(i);
        if (key?.startsWith(this.prefix)) keys.add(key.slice(this.prefix.length));
      }
    } catch { /* Storage can be disabled by browser policy. */ }
    return [...keys].sort();
  }
  get length() { return this.keys().length; }
  key(index: number) { return this.keys()[index] ?? null; }
  getItem(key: string) {
    try { return this.physical?.getItem(this.prefix + key) ?? this.memory.get(key) ?? null; }
    catch { return this.memory.get(key) ?? null; }
  }
  setItem(key: string, value: string) {
    this.memory.set(key, String(value));
    try { this.physical?.setItem(this.prefix + key, String(value)); } catch { /* Keep the in-memory copy. */ }
  }
  removeItem(key: string) {
    this.memory.delete(key);
    try { this.physical?.removeItem(this.prefix + key); } catch { /* Storage is optional. */ }
  }
  clear() { for (const key of this.keys()) this.removeItem(key); }
}

export function installMockStorage(): void {
  // Embedded demo controls may scroll their own surface, never the host page.
  // Do not rely on scrollIntoView's newer container option: browsers that
  // ignore it would scroll the parent page as well as the transcript.
  if (window.parent !== window) {
    Element.prototype.scrollIntoView = function(options?: boolean | ScrollIntoViewOptions) {
      const settings: ScrollIntoViewOptions = typeof options === "object" ? options : { block: options === false ? "end" : "start" };
      const align = (start: number, end: number, extent: number, position: ScrollLogicalPosition) => {
        if (position === "start") return start;
        if (position === "end") return end - extent;
        if (position === "center") return (start + end - extent) / 2;
        if (start < 0 && end > extent) return 0;
        if (start < 0) return end - start > extent ? end - extent : start;
        if (end > extent) return end - start > extent ? start : end - extent;
        return 0;
      };
      for (let container = this.parentElement; container; container = container.parentElement) {
        // The document viewport is deliberately excluded from embedded demos.
        if (container === document.body || container === document.documentElement) break;
        const style = getComputedStyle(container);
        const vertical = /^(auto|scroll|hidden)$/.test(style.overflowY) && container.scrollHeight > container.clientHeight;
        const horizontal = /^(auto|scroll|hidden)$/.test(style.overflowX) && container.scrollWidth > container.clientWidth;
        if (!vertical && !horizontal) continue;
        const target = this.getBoundingClientRect();
        const bounds = container.getBoundingClientRect();
        const top = target.top - bounds.top - container.clientTop;
        const left = target.left - bounds.left - container.clientLeft;
        container.scrollBy({
          top: vertical ? align(top, top + target.height, container.clientHeight, settings.block ?? "start") : 0,
          left: horizontal ? align(left, left + target.width, container.clientWidth, settings.inline ?? "nearest") : 0,
          behavior: settings.behavior ?? "auto",
        });
        return;
      }
    };
  }
  // Only application state is transient; the browser's static asset cache stays warm.
  const local = new ScopedStorage(null, PREFIX);
  const session = new ScopedStorage(null, PREFIX + "session.");
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => session });
  try {
    const notes = JSON.parse(local.getItem("space.sticky-notes.windows.v1") ?? "[]");
    if (!Array.isArray(notes)) local.removeItem("space.sticky-notes.windows.v1");
    else local.setItem("space.sticky-notes.windows.v1", JSON.stringify(notes.filter(note => note && typeof note.id === "string" && typeof note.text === "string" && Number.isFinite(note.x) && Number.isFinite(note.y))));
  } catch { local.removeItem("space.sticky-notes.windows.v1"); }
  const defaults: Record<string, string> = {
    "space.uiTheme.v1": "modern", "space.modern.appearance.mode.v1": "dark",
    "space.room.theme": "graphite", "space.roomFocusMode": "false", "space.roomsRailHidden": "false",
    "space.roomToolbar.hidden.v1": "true",
    // Nous runs only on the maker's own instance; its dock starts hidden in the public demo.
    "space:docks-hidden:v1": JSON.stringify(["nous"]),
    "space.dateTime.settings": JSON.stringify({ timeZone: "UTC", timeFormat: "24h", dateFormat: "DD/MM/YYYY" })
  };
  if (new URLSearchParams(location.search).get("showcase") === "1") { defaults["space.room.theme"] = "motion"; defaults["space.uiTheme.v1"] = "motion"; }
  for (const [key, value] of Object.entries(defaults)) if (local.getItem(key) === null) local.setItem(key, value);
  session.setItem("space.selectedRoomId", "room:demo-launch");
  session.setItem("space.selectedRoomId.user:demo-user", "room:demo-launch");
  session.setItem("space.dismissedStorageWarning", "DEMO MODE — Everything is simulated locally. No production service is connected.");
  session.removeItem("space.selectedPaneId");
  const deny = () => { throw new TypeError("This demo uses local simulated services."); };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href);
    const localAsset = url.origin === location.origin && (url.pathname.startsWith(import.meta.env.BASE_URL) || url.pathname.startsWith("/spaceappmock/") || url.pathname.startsWith("/demoappnew/")) && !url.pathname.includes("/api/");
    const inlineAsset = url.protocol === "data:" || url.protocol === "blob:";
    if ((!localAsset && !inlineAsset) || (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() !== "GET") return Promise.reject(new TypeError("This demo uses local simulated services."));
    return nativeFetch(url, { ...init, credentials: "omit" });
  }) as typeof fetch;
  for (const name of ["WebSocket", "EventSource", "XMLHttpRequest"] as const) {
    Object.defineProperty(window, name, { configurable: true, value: class {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      constructor() { deny(); }
    } });
  }
  Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => false });
  window.open = () => null;
  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = anchor?.getAttribute("href");
    if (href && /^https?:/.test(href) && new URL(href, location.href).origin !== location.origin) event.preventDefault();
  }, true);
}
