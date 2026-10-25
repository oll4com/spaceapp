import { afterEach, describe, expect, it, vi } from "vitest";
import { installBrowserDiagnostics } from "../src/browser-diagnostics.js";

const originalFetch = window.fetch;
const originalEventSource = window.EventSource;

afterEach(() => {
  window.__SPACE_DEBUG__?.stop();
  window.history.replaceState({}, "", "/");
  window.fetch = originalFetch;
  window.EventSource = originalEventSource;
  vi.restoreAllMocks();
});

describe("browser diagnostics", () => {
  it("is disabled unless the query gate is explicitly enabled", () => {
    const fetchBeforeInstall = window.fetch;

    const diagnostics = installBrowserDiagnostics();

    expect(diagnostics).toBeUndefined();
    expect(window.__SPACE_DEBUG__).toBeUndefined();
    expect(window.fetch).toBe(fetchBeforeInstall);
  });

  it("keeps a bounded, query-free report when enabled", async () => {
    window.history.replaceState({}, "", "/?spaceDebug=1");
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    window.fetch = fetchMock as typeof window.fetch;
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const diagnostics = installBrowserDiagnostics({
      maxRecords: 5,
      heartbeatIntervalMs: 60_000,
      fetchSummaryIntervalMs: 60_000
    });
    expect(diagnostics).toBe(window.__SPACE_DEBUG__);

    await window.fetch("/api/rooms?token=do-not-record");
    await window.fetch("/api/rooms?roomId=room%3Aprivate");
    await window.fetch("/api/panes?session=do-not-record");
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    const report = diagnostics!.report();
    const serialized = JSON.stringify(report);

    expect(report.records.length).toBeLessThanOrEqual(5);
    expect(report.fetch.total).toBe(3);
    expect(report.fetch.byPath).toEqual({ "/api/panes": 1, "/api/rooms": 2 });
    expect(report.connections.activeFetches).toBe(0);
    expect(serialized).not.toContain("do-not-record");
    expect(serialized).not.toContain("room%3Aprivate");
    expect(serialized).not.toContain("?token=");

    diagnostics!.stop();
    expect(window.__SPACE_DEBUG__).toBeUndefined();
    expect(window.fetch).toBe(fetchMock);
  });

  it("tracks EventSource lifecycle without retaining its query", () => {
    class MockEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = MockEventSource.CONNECTING;
      onopen = null;
      onmessage = null;
      onerror = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }

      close() {
        this.readyState = MockEventSource.CLOSED;
      }
    }

    window.history.replaceState({}, "", "/?spaceDebug=1");
    window.EventSource = MockEventSource as unknown as typeof EventSource;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const diagnostics = installBrowserDiagnostics({ heartbeatIntervalMs: 60_000, fetchSummaryIntervalMs: 60_000 });

    const source = new window.EventSource("/api/events/stream?roomId=room%3Aprivate&token=do-not-record");
    source.dispatchEvent(new Event("open"));
    source.close();

    const report = diagnostics!.report();
    expect(report.connections.activeEventSources).toBe(0);
    expect(report.counters).toMatchObject({
      "event-source:construct": 1,
      "event-source:open": 1,
      "event-source:close": 1
    });
    expect(JSON.stringify(report)).toContain("/api/events/stream");
    expect(JSON.stringify(report)).not.toContain("do-not-record");
    expect(JSON.stringify(report)).not.toContain("room%3Aprivate");
  });
});
