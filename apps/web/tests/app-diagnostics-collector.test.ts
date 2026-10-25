import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDiagnosticsEventBatch } from "@space/contracts";
import {
  createAppDiagnosticsCollector,
  templateAppDiagnosticsPath
} from "../src/app-diagnostics/app-diagnostics-collector.js";

const collectors: Array<{ stop(): void }> = [];

afterEach(() => {
  for (const collector of collectors.splice(0)) collector.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
});

function createCollector(
  upload: (batch: AppDiagnosticsEventBatch, signal: AbortSignal) => Promise<void>,
  options: { maxRetryAttempts?: number; mutationFlushMs?: number } = {}
) {
  const collector = createAppDiagnosticsCollector({
    captureId: "app_debug_capture:collector0001",
    clientId: "app_debug_client:collector0001",
    upload,
    flushIntervalMs: 60_000,
    ...options
  });
  collectors.push(collector);
  return collector;
}

describe("app diagnostics collector", () => {
  it("uploads only strict technical metadata and never retains URL queries, typed values, or error messages", async () => {
    const batches: AppDiagnosticsEventBatch[] = [];
    const nativeFetch = vi.fn(async () => new Response(null, {
      status: 204,
      headers: { "x-request-id": "sk-proj_private-correlation" }
    }));
    window.fetch = nativeFetch as typeof window.fetch;
    const collector = createCollector(async (batch) => {
      batches.push(batch);
    });

    const input = document.createElement("input");
    input.value = "typed terminal token must never be captured";
    input.name = "clipboard-secret";
    document.body.append(input);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "secret characters" }));
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    await window.fetch("/api/rooms/room_1234567890?token=do-not-record", {
      method: "GET",
      body: undefined
    });
    window.dispatchEvent(new ErrorEvent("error", {
      error: Object.assign(new Error("private chat body"), {
        stack: "Error: private chat body\n    at render (https://space.test/assets/app.js?token=private:12:4)"
      }),
      message: "private chat body",
      filename: "https://space.test/assets/password/app.js?token=private",
      lineno: 12,
      colno: 4
    }));

    await collector.flushNow();

    expect(batches).toHaveLength(1);
    const serialized = JSON.stringify(batches);
    expect(serialized).toContain("/api/rooms/:id");
    expect(serialized).not.toContain("typed terminal");
    expect(serialized).not.toContain("clipboard-secret");
    expect(serialized).not.toContain("secret characters");
    expect(serialized).not.toContain("private chat body");
    expect(serialized).not.toContain("private-correlation");
    expect(serialized).not.toContain("/password/");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("do-not-record");
  });

  it("keeps static client-event routes intact while templating opaque dynamic route segments", () => {
    expect(templateAppDiagnosticsPath("/api/cli/client-events?ignored=true"))
      .toBe("/api/cli/client-events");
    expect(templateAppDiagnosticsPath("/api/rooms/abcdefghijklmno"))
      .toBe("/api/rooms/:id");
  });

  it("records only strict additive performance details dispatched while collecting", async () => {
    const batches: AppDiagnosticsEventBatch[] = [];
    const collector = createCollector(async (batch) => {
      batches.push(batch);
    });

    window.dispatchEvent(new CustomEvent("space:app-diagnostics-performance", {
      detail: {
        category: "PERFORMANCE",
        metric: "TERMINAL_GEOMETRY",
        roomId: "room:stress-one",
        paneId: "pane:stress-one",
        phase: "READY",
        width: 1280,
        height: 720,
        cols: 160,
        rows: 44,
        repaired: false
      }
    }));
    window.dispatchEvent(new CustomEvent("space:app-diagnostics-performance", {
      detail: {
        category: "PERFORMANCE",
        metric: "WARM_ROOM_CAPACITY",
        phase: "PRESSURE",
        safeCapacity: 2,
        hardCapacity: 3,
        warmRoomCount: 3,
        connectedPaneCount: 48,
        safePaneCapacity: 32,
        hardPaneCapacity: 48,
        estimatedRoomBytes: 268_435_456,
        usedBytes: 536_870_912,
        longTaskCount: 3,
        driftCount: 0
      }
    }));
    window.dispatchEvent(new CustomEvent("space:app-diagnostics-performance", {
      detail: {
        category: "PERFORMANCE",
        metric: "ROOM_PRESENTATION",
        roomId: "room:stress-one",
        phase: "COMPLETE",
        durationMs: 18.5,
        value: 12
      }
    }));
    window.dispatchEvent(new CustomEvent("space:app-diagnostics-performance", {
      detail: {
        category: "PERFORMANCE",
        metric: "TERMINAL_OUTPUT_PRESSURE",
        roomId: "room:stress-one",
        paneId: "pane:stress-one",
        phase: "PANE_LIMIT",
        bufferedBytes: 10,
        terminalText: "never collect this"
      }
    }));
    await collector.flushNow();

    const metrics = batches
      .flatMap((batch) => batch.events)
      .filter((event) => event.category === "PERFORMANCE");
    expect(metrics).toEqual([
      expect.objectContaining({
        metric: "TERMINAL_GEOMETRY",
        roomId: "room:stress-one",
        paneId: "pane:stress-one",
        phase: "READY",
        cols: 160,
        rows: 44
      }),
      expect.objectContaining({
        metric: "WARM_ROOM_CAPACITY",
        phase: "PRESSURE",
        safeCapacity: 2,
        hardCapacity: 3,
        warmRoomCount: 3,
        connectedPaneCount: 48
      }),
      expect.objectContaining({
        metric: "ROOM_PRESENTATION",
        roomId: "room:stress-one",
        phase: "COMPLETE",
        durationMs: 18.5,
        value: 12
      })
    ]);
    expect(JSON.stringify(batches)).not.toContain("never collect this");
  });

  it("recognizes real pane and warm-runtime identifiers in selection events", async () => {
    const batches: AppDiagnosticsEventBatch[] = [];
    const runtime = document.createElement("section");
    runtime.dataset.roomRuntimeId = "room:runtime-one";
    const pane = document.createElement("article");
    pane.dataset.spacePaneId = "pane:runtime-one";
    pane.dataset.spaceRoomId = "room:runtime-one";
    const button = document.createElement("button");
    pane.append(button);
    runtime.append(pane);
    document.body.append(runtime);
    const collector = createCollector(async (batch) => {
      batches.push(batch);
    });

    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    runtime.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await collector.flushNow();

    const selections = batches
      .flatMap((batch) => batch.events)
      .filter((event) => event.category === "SELECTION");
    expect(selections).toContainEqual(expect.objectContaining({
      surface: "PANE",
      roomId: "room:runtime-one",
      paneId: "pane:runtime-one"
    }));
    expect(selections).toContainEqual(expect.objectContaining({
      surface: "ROOM",
      roomId: "room:runtime-one"
    }));
  });

  it("bounds its client buffer and drops a failed batch after the configured retry budget", async () => {
    const upload = vi.fn(async () => {
      throw new TypeError("offline");
    });
    const collector = createCollector(upload, { maxRetryAttempts: 2 });

    for (let index = 0; index < 1_100; index += 1) {
      collector.record({
        category: "LIFECYCLE",
        event: index % 2 === 0 ? "PAGE_SHOW" : "PAGE_HIDE"
      });
    }

    expect(collector.stats().bufferedEvents).toBeLessThanOrEqual(1_000);
    expect(collector.stats().droppedEvents).toBeGreaterThanOrEqual(100);

    await collector.flushNow();
    expect(collector.stats().bufferedEvents).toBeGreaterThan(0);
    await collector.flushNow();

    expect(upload).toHaveBeenCalledTimes(2);
    expect(collector.stats().droppedEvents).toBeGreaterThanOrEqual(300);
  });

  it("reports locally dropped events once after a successful batch", async () => {
    const batches: AppDiagnosticsEventBatch[] = [];
    const collector = createCollector(async (batch) => {
      batches.push(batch);
    });
    for (let index = 0; index < 1_100; index += 1) {
      collector.record({ category: "LIFECYCLE", event: "PAGE_SHOW" });
    }

    await collector.flushNow();
    expect(batches[0]!.droppedBeforeBatch).toBeGreaterThanOrEqual(100);
    expect(collector.stats().droppedEvents).toBe(0);

    await collector.flushNow();
    expect(batches[1]!.droppedBeforeBatch).toBe(0);
  });

  it("reuses the exact pending batch ID and payload across a transient upload retry", async () => {
    const batches: AppDiagnosticsEventBatch[] = [];
    let attempt = 0;
    const collector = createCollector(async (batch) => {
      batches.push(batch);
      attempt += 1;
      if (attempt === 1) throw new TypeError("timeout after persistence");
    });
    collector.record({ category: "LIFECYCLE", event: "PAGE_SHOW" });

    await collector.flushNow();
    expect(collector.stats().bufferedEvents).toBeGreaterThan(0);
    await collector.flushNow();

    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(batches[0]);
    expect(collector.stats().bufferedEvents).toBe(0);
  });

  it("creates a bounded structural snapshot for flicker without text, values, ids, or URLs", async () => {
    vi.useFakeTimers();
    const batches: AppDiagnosticsEventBatch[] = [];
    const collector = createCollector(async (batch) => {
      batches.push(batch);
    }, { mutationFlushMs: 25 });
    const secret = document.createElement("input");
    secret.id = "customer-secret-id";
    secret.value = "terminal transcript secret";
    secret.setAttribute("src", "https://private.test/token");
    secret.textContent = "private chat text";
    secret.style.animationName = "password-hunter2";
    document.body.append(secret);

    for (let index = 0; index < 8; index += 1) {
      secret.className = `safe-class-${index}`;
      secret.toggleAttribute("hidden", index % 2 === 0);
    }
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    await collector.flushNow();

    const snapshots = batches.flatMap((batch) => batch.snapshots);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.nodes.length).toBeLessThanOrEqual(2_000);
    const serialized = JSON.stringify(snapshots);
    expect(serialized).toContain("\"tag\":\"input\"");
    expect(serialized).not.toContain("customer-secret-id");
    expect(serialized).not.toContain("terminal transcript");
    expect(serialized).not.toContain("private chat");
    expect(serialized).not.toContain("private.test");
    expect(serialized).not.toContain("password-hunter2");
    expect(serialized).not.toContain("safe-class");
    expect(serialized).not.toContain("\"value\"");
  });

  it("excludes generic xterm subtree mutations but retains pane/runtime structural churn", async () => {
    vi.useFakeTimers();
    const batches: AppDiagnosticsEventBatch[] = [];
    const terminal = document.createElement("div");
    terminal.className = "terminal-xterm";
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    terminal.append(xterm);
    document.body.append(terminal);
    const collector = createCollector(async (batch) => {
      batches.push(batch);
    }, { mutationFlushMs: 25 });

    for (let index = 0; index < 8; index += 1) {
      xterm.style.opacity = index % 2 === 0 ? "0.9" : "1";
    }
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    await collector.flushNow();
    expect(batches.flatMap((batch) => batch.events).filter((event) => event.category === "ANOMALY"))
      .toHaveLength(0);

    const runtime = document.createElement("section");
    runtime.dataset.roomRuntimeId = "room:structural-one";
    document.body.append(runtime);
    for (let index = 0; index < 8; index += 1) {
      runtime.toggleAttribute("hidden", index % 2 === 0);
    }
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);
    await collector.flushNow();
    expect(batches.flatMap((batch) => batch.events)).toContainEqual(expect.objectContaining({
      category: "ANOMALY",
      anomaly: "VISIBILITY_CHURN"
    }));
  });

  it("resets the frame clock while hidden so the first resumed frame is not a stall", async () => {
    const batches: AppDiagnosticsEventBatch[] = [];
    const frameCallbacks: FrameRequestCallback[] = [];
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const collector = createCollector(async (batch) => {
      batches.push(batch);
    });

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    frameCallbacks.shift()?.(10_000);
    await collector.flushNow();

    expect(batches.flatMap((batch) => batch.events)).not.toContainEqual(expect.objectContaining({
      category: "PERFORMANCE",
      metric: "FRAME_STALL"
    }));
  });

  it("aborts pending uploads and restores instrumented browser primitives immediately on stop", async () => {
    const observed: { signal: AbortSignal | null } = { signal: null };
    const originalFetch = window.fetch;
    const collector = createCollector((_batch, signal) => new Promise<void>((_resolve, reject) => {
      observed.signal = signal;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));

    const pending = collector.flushNow();
    collector.stop();
    await pending;

    expect(observed.signal?.aborted).toBe(true);
    expect(window.fetch).toBe(originalFetch);
    expect(collector.stats().isCollecting).toBe(false);
  });
});
