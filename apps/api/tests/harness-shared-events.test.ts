import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { harnessSharedEventsBootstrap } from "../src/harness-shared-events.js";

function fixture() {
  const sources: NativeSource[] = [];
  class NativeSource extends EventTarget {
    readyState = 0;
    constructor(public url: string) { super(); sources.push(this); }
    close() { this.readyState = 2; }
  }
  const location = { origin: "https://space.test", href: "https://space.test/api/harness/" };
  const parent = { location, EventSource: NativeSource };
  const frame = () => {
    const window = Object.assign(new EventTarget(), { location, parent, EventSource: NativeSource });
    runInNewContext(harnessSharedEventsBootstrap.replace(/^<script[^>]*>|<\/script>$/g, ""),
      { window, EventTarget, Event, MessageEvent, URL, queueMicrotask });
    return window;
  };
  return { frame, sources, NativeSource };
}

describe("Harness plugin event sharing", () => {
  it("uses one HTTP stream for 16 frames and retains it until the last frame closes", () => {
    const { frame, sources } = fixture();
    const windows = Array.from({ length: 16 }, frame);
    const clients = windows.map(window => new window.EventSource("/plugins/events"));
    expect(sources).toHaveLength(1);
    const received: unknown[] = [];
    clients[1]!.addEventListener("message", event => received.push((event as MessageEvent).data));
    clients[15]!.close();
    expect(sources[0]!.readyState).not.toBe(2);
    sources[0]!.dispatchEvent(new MessageEvent("message", { data: '{"type":"graph"}' }));
    expect(received).toEqual(['{"type":"graph"}']);
    // A detached iframe's callbacks stop in Chrome. A surviving subscriber must
    // take over the source before the owner's document is destroyed.
    clients[0]!.close();
    expect(sources[0]!.readyState).toBe(2);
    expect(sources).toHaveLength(2);
    sources[1]!.dispatchEvent(new MessageEvent("message", { data: "after-owner-close" }));
    expect(received).toEqual(['{"type":"graph"}', "after-owner-close"]);
    windows.forEach(window => window.dispatchEvent(new Event("pagehide")));
    expect(sources.every(source => source.readyState === 2)).toBe(true);
    const countBefore = sources.length;
    new (frame().EventSource)("/plugins/events");
    expect(sources).toHaveLength(countBefore + 1);
  });

  it("keeps session feeds, query variants and foreign origins on their native transport", () => {
    const { frame, sources, NativeSource } = fixture();
    const window = frame();
    for (const url of ["/api/events/stream", "/plugins/events?scope=other", "https://elsewhere.test/plugins/events"]) {
      expect(new window.EventSource(url)).toBeInstanceOf(NativeSource);
    }
    expect(sources).toHaveLength(3);
  });

  it("notifies a late subscriber and forwards reconnection errors to each open client", async () => {
    const { frame, sources } = fixture();
    new (frame().EventSource)("/plugins/events");
    sources[0]!.readyState = 1;
    const late = new (frame().EventSource)("/plugins/events");
    const events: string[] = [];
    late.addEventListener("open", () => events.push("open"));
    late.addEventListener("error", () => events.push("error"));
    await Promise.resolve();
    sources[0]!.dispatchEvent(new Event("error"));
    expect(events).toEqual(["open", "error"]);
  });
});
