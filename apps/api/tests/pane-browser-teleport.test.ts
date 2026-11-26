import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPaneBrowserTeleportRoutes } from "../src/pane-browser-teleport.js";

const pane = { id: "pane:browser1", roomId: "room:abcdef", mode: "BROWSER", isClosed: false };
const sessionId = "browser_session:browser1";

function setup() {
  let viewport = "desktop";
  let onFrame: ((frame: unknown) => void) | null = null;
  const stop = vi.fn(async () => undefined);
  const response = (dimensions?: { width: number; height: number }) => ({ session: { sessionId, viewport, status: "READY", activePageId: "T1" }, viewportDimensions: dimensions });
  const manager = {
    getActive: vi.fn(async () => response(viewport === "desktop" ? { width: 1200, height: 700 } : { width: 412, height: 860 })),
    setViewport: vi.fn(async (_pane: unknown, next: string, _trace: string, _actor: unknown, dimensions?: { width: number; height: number }) => {
      viewport = next;
      return response(dimensions);
    }),
    captureFrame: vi.fn(async () => ({ screenshotDataUrl: "data:image/png;base64,UE5H" })),
    startFrameStream: vi.fn(async (_id: string, _mode: string, callback: (frame: unknown) => void) => { onFrame = callback; return { id: "s1", profile: {}, stop }; }),
    dispatchInput: vi.fn(async () => undefined)
  };
  const activity = { view: vi.fn(() => () => undefined), noteUse: vi.fn(), noteInput: vi.fn() };
  const store = {
    getPane: vi.fn(async () => pane),
    getActivePaneBrowserSession: vi.fn(async () => ({ sessionId })),
    upsertUser: vi.fn(async (user: unknown) => user),
    recordAuditEvent: vi.fn(async () => undefined)
  };
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as { requestIdForSpace?: string }).requestIdForSpace = "trace:1";
    const device = request.headers["x-device"];
    if (typeof device === "string") (request as { mobileDevice?: unknown }).mobileDevice = { id: device };
  });
  const focusEditable = vi.fn(async (): Promise<boolean | null> => true);
  registerPaneBrowserTeleportRoutes(app, { config: { browserSessionsProfileRoot: "/tmp" }, store: store as never, browserSessionManager: manager as never,
    controlActivity: activity as never, nous: { current: null }, routeOptions: {}, focusEditable });
  const frame = (sequence: number) => onFrame!({ sessionId, sequence, data: Buffer.from(`frame${sequence}`), mimeType: "image/jpeg", capturedAt: "t", metadata: { viewportDimensions: { width: 412, height: 860 } } });
  return { app, manager, activity, stop, frame, focusEditable };
}

describe("browser teleport (operator 13/11)", () => {
  it("makes the pane a phone, hands out only new frames, takes touch in order and gives the viewport back on close", async () => {
    const { app, manager, activity, stop, frame } = setup();
    try {
      const on = await app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport", payload: { on: true, dimensions: { width: 412, height: 860 } } });
      expect(on.json()).toEqual({ on: true, viewportDimensions: { width: 412, height: 860 } });
      expect(manager.setViewport).toHaveBeenCalledWith(pane, "mobile", "trace:1", expect.objectContaining({ holderType: "OPERATOR" }), { width: 412, height: 860 });
      expect(activity.view).toHaveBeenCalledWith(pane.id);

      frame(1);
      const first = (await app.inject({ method: "GET", url: "/api/panes/pane:browser1/browser/teleport/frame?after=0" })).json();
      expect(first.frame).toMatchObject({ sequence: 1, mimeType: "image/jpeg", width: 412, height: 860, data: Buffer.from("frame1").toString("base64") });
      // The next poll waits for a changed frame.
      setTimeout(() => frame(2), 20);
      expect((await app.inject({ method: "GET", url: "/api/panes/pane:browser1/browser/teleport/frame?after=1" })).json().frame.sequence).toBe(2);

      const touch = (eventType: string) => ({ type: "TOUCH", leaseId: "browser_lease:1", eventType, touchPoints: eventType === "touchEnd" ? [] : [{ x: 100, y: 200 }] });
      const input = await app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport/input", payload: { inputs: [touch("touchStart"), touch("touchEnd")] } });
      expect(input.statusCode, input.body).toBe(200);
      // The tap ended on a text field: the phone opens its keyboard (operator 20/11 nous_msg:115184c7).
      expect(input.json()).toEqual({ ok: true, dispatched: 2, editable: true });
      expect(manager.dispatchInput.mock.calls.map((call) => (call as unknown[])[1])).toMatchObject([{ eventType: "touchStart" }, { eventType: "touchEnd" }]);
      expect(activity.noteInput).toHaveBeenCalledWith("browser_lease:1");

      await app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport", payload: { on: false } });
      expect(stop).toHaveBeenCalled();
      expect(manager.setViewport).toHaveBeenLastCalledWith(pane, "desktop", "trace:1", expect.objectContaining({ holderType: "OPERATOR" }), { width: 1200, height: 700 });
      const off = await app.inject({ method: "GET", url: "/api/panes/pane:browser1/browser/teleport/frame?after=2" });
      expect(off.statusCode).toBe(409);
      expect(off.json().error.code).toBe("TELEPORT_OFF");
    } finally {
      await app.close();
    }
  });

  it("a still page's first picture is a screenshot, and a pane that was already a phone stays one", async () => {
    const { app, manager } = setup();
    try {
      await app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport", payload: { on: false } });
      manager.getActive.mockResolvedValueOnce({ session: { sessionId, viewport: "mobile", status: "READY", activePageId: "T1" }, viewportDimensions: { width: 390, height: 844 } });
      await app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport", payload: { on: true } });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const poll = app.inject({ method: "GET", url: "/api/panes/pane:browser1/browser/teleport/frame" });
      await vi.advanceTimersByTimeAsync(4_000);
      vi.useRealTimers();
      expect((await poll).json().frame).toMatchObject({ sequence: 1, mimeType: "image/png", data: "UE5H" });
      manager.setViewport.mockClear();
      await app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport", payload: { on: false } });
      expect(manager.setViewport).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it("hands a frame to one waiting lane of a viewer and to every viewer (captcha mode, operator 14/11)", async () => {
    const { app, frame } = setup();
    const poll = (after: number, device?: string) => app.inject({ method: "GET", url: `/api/panes/pane:browser1/browser/teleport/frame?after=${after}`,
      headers: device ? { "x-device": device } : {} }).then((reply) => reply.json().frame?.sequence ?? null);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    try {
      await app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport", payload: { on: true } });
      frame(1);
      expect(await poll(0)).toBe(1);
      // Frame 2 wakes one of two held lanes; the other answers neither twin nor empty, it waits for frame 3.
      const answers: Array<number | null> = [];
      const lanes = [poll(1), poll(2)].map((answer) => answer.then((sequence) => { answers.push(sequence); return sequence; }));
      await tick();
      frame(2);
      await tick();
      expect(answers).toEqual([2]);
      frame(3);
      expect(await Promise.all(lanes)).toEqual([2, 3]);
      // A lane behind its viewer waits past the frame another lane took; another phone still gets that frame.
      frame(4);
      expect(await poll(3)).toBe(4);
      const behind = poll(3);
      expect(await poll(3, "phone2")).toBe(4);
      await tick();
      frame(5);
      expect(await behind).toBe(5);
    } finally {
      await app.close();
    }
  });

  it("captcha mode plays timed touches with the finger's own gaps, in order, across batches (operator 14/11)", async () => {
    const { app, manager } = setup();
    const played: Array<{ time: number; eventType: string; x: number }> = [];
    manager.dispatchInput.mockImplementation((async (_pane: unknown, item: { eventType: string; touchPoints: Array<{ x: number }> }) => {
      played.push({ time: Date.now(), eventType: item.eventType, x: item.touchPoints[0]?.x ?? -1 });
    }) as never);
    const touch = (eventType: string, x: number) => ({ type: "TOUCH", leaseId: "browser_lease:1", eventType, touchPoints: eventType === "touchEnd" ? [] : [{ x, y: 200 }] });
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport/input", payload });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const first = await post({ inputs: [touch("touchStart", 10), touch("touchMove", 11), touch("touchMove", 12), touch("touchMove", 13)], at: [5_000, 5_016, 5_050, 5_060] });
      // Answered at once: the moves play behind it.
      expect(first.json()).toEqual({ ok: true, dispatched: 4, timed: true });
      expect(played).toEqual([]);
      await vi.advanceTimersByTimeAsync(30);
      await post({ inputs: [touch("touchMove", 14), touch("touchMove", 15), touch("touchEnd", 0)], at: [5_100, 5_180, 5_200] });
      // An untimed batch waits for the timed one still playing.
      const untimed = post({ inputs: [touch("touchStart", 99)] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await untimed).statusCode).toBe(200);
      expect(played.map((event) => event.x)).toEqual([10, 11, 12, 13, 14, 15, -1, 99]);
      const timed = played.slice(0, 7);
      expect(timed.slice(1).map((event, index) => event.time - timed[index]!.time)).toEqual([16, 34, 10, 40, 80, 20]);

      // The next touch waits out the last one's spread of delays on the way (here 170 ms), so none of its moves comes late.
      played.length = 0;
      const sent = Date.now();
      await post({ inputs: [touch("touchStart", 30), touch("touchEnd", 0)], at: [7_000, 7_010] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(played.map((event) => event.time - sent)).toEqual([170, 180]);

      // A refused input is the next batch's answer, and nothing queued behind it plays.
      played.length = 0;
      manager.dispatchInput.mockRejectedValueOnce(new Error("lease lost"));
      await post({ inputs: [touch("touchStart", 20), touch("touchMove", 21)], at: [9_000, 9_016] });
      await vi.advanceTimersByTimeAsync(500);
      expect(played).toEqual([]);
      expect((await post({ inputs: [touch("touchEnd", 0)], at: [9_100] })).statusCode).toBe(500);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it("says after a tap whether a text field took the focus, never for a gesture still going, and leaves it out when unknown", async () => {
    const { app, focusEditable } = setup();
    try {
      const touch = (eventType: string) => ({ type: "TOUCH", leaseId: "browser_lease:1", eventType, touchPoints: eventType === "touchEnd" ? [] : [{ x: 10, y: 20 }] });
      const post = async (...events: string[]) => (await app.inject({ method: "POST", url: "/api/panes/pane:browser1/browser/teleport/input",
        payload: { inputs: events.map(touch) } })).json();
      expect(await post("touchStart", "touchMove")).toEqual({ ok: true, dispatched: 2 });
      expect(focusEditable).not.toHaveBeenCalled();
      focusEditable.mockResolvedValueOnce(false);
      expect(await post("touchEnd")).toEqual({ ok: true, dispatched: 1, editable: false });
      focusEditable.mockResolvedValueOnce(null);
      expect(await post("touchEnd")).toEqual({ ok: true, dispatched: 1 });
      focusEditable.mockRejectedValueOnce(new Error("no live connection"));
      expect(await post("touchEnd")).toEqual({ ok: true, dispatched: 1 });
    } finally {
      await app.close();
    }
  });
});
