import { describe, it, expect, vi } from "vitest";
import type { WebSocket } from "ws";
import { createBrowserLiveSender } from "../src/browser-live-sender.js";

describe("live browser backpressure", () => {
  it("keeps only the newest waiting frame and stops pending delivery on disconnect", () => {
    const callbacks: Array<(error?: Error) => void> = [];
    const sent: string[] = [];
    const socket = { readyState: 1, send: vi.fn((frame: Buffer, _options: unknown, callback: (error?: Error) => void) => {
      sent.push(frame.toString()); callbacks.push(callback);
    }) };
    const sender = createBrowserLiveSender(socket as unknown as WebSocket);
    sender.present(Buffer.from("first"));
    for (let n = 0; n < 100; n++) sender.present(Buffer.from(String(n)));
    expect(sent).toEqual(["first"]);
    callbacks.shift()!();
    expect(sent).toEqual(["first", "99"]);
    sender.present(Buffer.from("after"));
    sender.stop();
    callbacks.shift()!();
    expect(sent).toEqual(["first", "99"]);
  });
  it("pairs viewport geometry with the newest frame under backpressure", () => {
    const callbacks: Array<() => void> = [];
    const sent: string[] = [];
    const send = vi.fn((value: Buffer | string, _options: unknown, callback?: () => void) => {
      sent.push(value.toString());
      if (callback) callbacks.push(callback);
    });
    const sender = createBrowserLiveSender({ readyState: 1, send } as unknown as WebSocket);
    sender.present(Buffer.from("old"), { width: 1440, height: 900 });
    sender.present(Buffer.from("discard"), { width: 500, height: 500 });
    sender.present(Buffer.from("new"), { width: 800, height: 600 });
    callbacks.shift()!();
    expect(sent).toEqual([
      JSON.stringify({ type: "viewport", dimensions: { width: 1440, height: 900 } }), "old",
      JSON.stringify({ type: "viewport", dimensions: { width: 800, height: 600 } }), "new"
    ]);
  });
  it("waits for the viewer even when kernel writes finish immediately", () => {
    const sent: string[] = [];
    const send = vi.fn((frame: Buffer, _options: unknown, complete?: () => void) => { sent.push(frame.toString()); complete?.(); });
    const sender = createBrowserLiveSender({ readyState: 1, send } as unknown as WebSocket, true);
    for (let i = 0; i < 100; i++) sender.present(Buffer.from(String(i)));
    expect(sent).toEqual(["0", "1", "2", "3"]);
    sender.acknowledge();
    expect(sent).toEqual(["0", "1", "2", "3", "99"]);
    sender.stop(); sender.acknowledge();
    expect(sent).toHaveLength(5);
  });
  it.each([100, 250, 500])("sustains live delivery with %dms acknowledgements without unbounded buffering", (rtt) => {
    vi.useFakeTimers();
    try {
      let sent = 0;
      let pending = 0;
      let peak = 0;
      const sender = createBrowserLiveSender({ readyState: 1, send: (_frame: Buffer, _options: unknown, complete: () => void) => {
        sent++; peak = Math.max(peak, ++pending); complete();
        setTimeout(() => { pending--; sender.acknowledge(); }, rtt);
      } } as unknown as WebSocket, true);
      const timer = setInterval(() => sender.present(Buffer.alloc(32_000)), 1000 / 35);
      vi.advanceTimersByTime(3000);
      const before = sent;
      vi.advanceTimersByTime(5000);
      expect((sent - before) / 5).toBeGreaterThanOrEqual(34);
      expect(peak).toBeLessThanOrEqual(24);
      clearInterval(timer); sender.stop();
    } finally { vi.useRealTimers(); }
  });

  it("bounds bytes even after learning a long RTT and ignores unsolicited acknowledgements", () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn((_frame: Buffer, _options: unknown, complete: () => void) => complete());
      const sender = createBrowserLiveSender({ readyState: 1, send } as unknown as WebSocket, true);
      sender.present(Buffer.alloc(1));
      vi.advanceTimersByTime(500); sender.acknowledge();
      for (let n = 0; n < 100; n++) sender.acknowledge();
      send.mockClear();
      for (let n = 0; n < 100; n++) sender.present(Buffer.alloc(1024 * 1024));
      expect(send).toHaveBeenCalledTimes(2);
      sender.acknowledge(); expect(send).toHaveBeenCalledTimes(3);
      sender.stop();
    } finally { vi.useRealTimers(); }
  });
  it("discards queued frames after a failed write", () => {
    let complete: (error?: Error) => void = () => {};
    const send = vi.fn((_frame: Buffer, _options: unknown, callback: typeof complete) => { complete = callback; });
    const sender = createBrowserLiveSender({ readyState: 1, send } as unknown as WebSocket);
    sender.present(Buffer.from("first"));
    sender.present(Buffer.from("queued"));
    complete(new Error("closed"));
    sender.present(Buffer.from("late"));
    expect(send).toHaveBeenCalledOnce();
  });
});
