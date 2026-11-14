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
  app.addHook("onRequest", async (request) => { (request as { requestIdForSpace?: string }).requestIdForSpace = "trace:1"; });
  registerPaneBrowserTeleportRoutes(app, { config: { browserSessionsProfileRoot: "/tmp" }, store: store as never, browserSessionManager: manager as never,
    controlActivity: activity as never, nous: { current: null }, routeOptions: {} });
  const frame = (sequence: number) => onFrame!({ sessionId, sequence, data: Buffer.from(`frame${sequence}`), mimeType: "image/jpeg", capturedAt: "t", metadata: { viewportDimensions: { width: 412, height: 860 } } });
  return { app, manager, activity, stop, frame };
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
});
