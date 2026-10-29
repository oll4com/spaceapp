import { describe, expect, it, vi } from "vitest";
import {
  browserStreamTicketResponseSchema,
  browserStreamWebSocketServerMessageSchema,
  type BrowserRuntimeInput,
  type BrowserStreamWebSocketServerMessage,
  type Pane,
  type PaneBrowserSession
} from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import type { BrowserHostActorContext } from "@space/browser-host";
import { createApp } from "../src/app.js";
import type { BrowserSessionManager } from "../src/browser-sessions.js";
import { getApiConfig } from "../src/config.js";

const csrfHeaderName = "x-space-csrf-token";

async function waitForMessage(
  messages: BrowserStreamWebSocketServerMessage[],
  predicate: (message: BrowserStreamWebSocketServerMessage) => boolean
): Promise<BrowserStreamWebSocketServerMessage> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for browser stream message. Seen: ${JSON.stringify(messages)}`);
}

async function authedApp(store: InMemorySpaceStore, browserSessionManager: BrowserSessionManager, env: Record<string, string> = {}) {
  const app = await createApp({
    store,
    browserSessionManager,
    config: getApiConfig({ SPACE_BROWSER_SESSIONS_ENABLED: "true", ...env }),
    auth: {
      sessionSecret: "test-secret-with-enough-length",
      devLogin: true,
      secureCookies: false
    }
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "space@space.local", password: "space-dev" }
  });
  const cookie = `space_session=${login.cookies.find((entry) => entry.name === "space_session")?.value}`;
  const csrf = await app.inject({ method: "GET", url: "/api/auth/csrf", headers: { cookie } });
  return { app, cookie, csrfToken: csrf.json().csrfToken as string };
}

function realtimeManager(
  session: PaneBrowserSession,
  dispatchInput: (pane: Pane, input: BrowserRuntimeInput, traceId: string, context?: BrowserHostActorContext) => Promise<void>
): BrowserSessionManager {
  const tickets = new Set<string>();
  let ticketSequence = 0;
  const response = { session, frame: null, websocket: null };
  const unused = async (): Promise<never> => {
    throw new Error("unused browser manager method");
  };
  return {
    status: () => ({
      enabled: true,
      statusReason: "Managed Chrome browser sessions are enabled.",
      defaultUrl: "https://example.com/",
      checkedAt: "2026-07-18T00:00:00.000Z"
    }),
    startOrRestore: async () => response,
    getActive: async () => response,
    navigate: async () => response,
    setViewport: async () => response,
    action: async () => ({ session, frame: null, text: null }),
    captureFrame: unused,
    stopPane: async () => undefined,
    stopRoom: async () => undefined,
    closeAll: async () => undefined,
    input: async () => response,
    dispatchInput,
    issueFrameTicket(paneId, sessionId) {
      ticketSequence += 1;
      const token = `browser-stream-ticket-${ticketSequence}-test-value`;
      tickets.add(token);
      return {
        paneId,
        sessionId,
        token,
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      };
    },
    acceptFrameTicket(paneId, sessionId, token) {
      if (paneId !== session.paneId || sessionId !== session.sessionId || !tickets.delete(token)) return false;
      return true;
    },
    async startFrameStream(_sessionId, mode, _onFrame, hints) {
      if (mode === "AUTO") expect(hints).toEqual({ focused: true });
      return {
        id: "browser_stream:test",
        profile: {
          requestedMode: "AUTO",
          resolvedMode: "INTERACTIVE",
          framesPerSecond: 10,
          format: "jpeg",
          quality: 70
        },
        stop: vi.fn(async () => undefined)
      };
    }
  } as BrowserSessionManager;
}

function browserFixture() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Realtime browser", initialPaneCount: 0 });
  const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" });
  const session = store.createPaneBrowserSession({
    sessionId: "browser_session:realtime-test",
    paneId: pane.id,
    roomId: room.id,
    ownerAgentId: null,
    agentNumber: 1,
    profileId: "profile:realtime-test",
    profilePath: "/tmp/space-browser-realtime-test",
    viewport: "desktop",
    targetUrl: "https://example.com/",
    currentUrl: "https://example.com/",
    status: "READY",
    isActive: true
  });
  return { store, pane, session };
}

describe("browser realtime stream API", () => {
  it("keeps an operator browser empty after reload without calling Chrome", async () => {
    const { store, pane, session } = browserFixture();
    store.updatePaneBrowserSession(session.sessionId, { status: "CLOSED", isActive: false, pages: [], activePageId: null });
    const manager = realtimeManager(session, async () => undefined);
    const read = vi.spyOn(manager, "getActive");
    const start = vi.spyOn(manager, "startOrRestore");
    const { app, cookie } = await authedApp(store, manager);
    try {
      const response = await app.inject({ method: "GET", url: `/api/panes/${encodeURIComponent(pane.id)}/browser/session`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ session: { status: "CLOSED", isActive: false, pages: [], activePageId: null }, frame: null, websocket: null });
      expect(read).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("issues a fresh stream ticket for the active pane session", async () => {
    const { store, pane, session } = browserFixture();
    const manager = realtimeManager(session, async () => undefined);
    const { app, cookie, csrfToken } = await authedApp(store, manager);
    try {
      const issued = await app.inject({
        method: "POST",
        url: `/api/panes/${encodeURIComponent(pane.id)}/browser/stream-ticket`,
        headers: { cookie, [csrfHeaderName]: csrfToken },
        payload: {}
      });

      expect(issued.statusCode).toBe(200);
      const payload = browserStreamTicketResponseSchema.parse(issued.json());
      expect(payload.websocket).toMatchObject({ paneId: pane.id, sessionId: session.sessionId });
    } finally {
      await app.close();
    }
  });

  it("serializes stream input, acknowledges failures, and keeps the queue alive after malformed data", async () => {
    const { store, pane, session } = browserFixture();
    const order: string[] = [];
    const dispatchInput = vi.fn(async (_pane: Pane, input: BrowserRuntimeInput, _traceId: string, context?: BrowserHostActorContext) => {
      const eventType = input.type === "NAVIGATION" ? input.action : input.type === "DIALOG" ? "dialog" : input.eventType;
      order.push(`start:${eventType}`);
      if (eventType === "mousePressed") await new Promise((resolve) => setTimeout(resolve, 25));
      order.push(`end:${eventType}`);
      expect(context?.holderType).toBe("OPERATOR");
      if (eventType === "mouseReleased") throw new Error("private browser runtime detail");
    });
    const manager = realtimeManager(session, dispatchInput);
    const ticket = manager.issueFrameTicket(pane.id, session.sessionId, 60_000);
    const { app, cookie } = await authedApp(store, manager);
    const messages: BrowserStreamWebSocketServerMessage[] = [];
    try {
      const socket = await app.injectWS(
        `/api/panes/${encodeURIComponent(pane.id)}/browser/stream` +
          `?sessionId=${encodeURIComponent(session.sessionId)}` +
          `&token=${encodeURIComponent(ticket.token)}` +
          "&mode=AUTO",
        { headers: { cookie } },
        {
          onInit(ws) {
            ws.on("message", (raw, isBinary) => {
              if (isBinary) return;
              const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
              messages.push(browserStreamWebSocketServerMessageSchema.parse(JSON.parse(text)));
            });
          }
        }
      );
      await waitForMessage(messages, (message) => message.type === "ready");
      expect(manager.acceptFrameTicket(pane.id, session.sessionId, ticket.token)).toBe(false);

      socket.send("{");
      socket.send(JSON.stringify({
        type: "input",
        requestId: "browser-input:press",
        input: { type: "POINTER", leaseId: "browser_lease:test", eventType: "mousePressed", x: 10, y: 20, button: "left" }
      }));
      socket.send(JSON.stringify({
        type: "input",
        requestId: "browser-input:release",
        input: { type: "POINTER", leaseId: "browser_lease:test", eventType: "mouseReleased", x: 10, y: 20, button: "left" }
      }));
      socket.send(JSON.stringify({
        type: "input",
        requestId: "browser-input:key",
        input: { type: "KEY", leaseId: "browser_lease:test", eventType: "keyDown", key: "a", code: "KeyA", text: "a" }
      }));

      await waitForMessage(messages, (message) => message.type === "error" && message.code === "BROWSER_STREAM_INPUT_INVALID");
      await waitForMessage(messages, (message) => message.type === "inputAck" && message.requestId === "browser-input:press" && message.ok);
      const failure = await waitForMessage(
        messages,
        (message) => message.type === "inputAck" && message.requestId === "browser-input:release" && !message.ok
      );
      await waitForMessage(messages, (message) => message.type === "inputAck" && message.requestId === "browser-input:key" && message.ok);

      expect(order).toEqual([
        "start:mousePressed",
        "end:mousePressed",
        "start:mouseReleased",
        "end:mouseReleased",
        "start:keyDown",
        "end:keyDown"
      ]);
      expect(failure).toMatchObject({
        type: "inputAck",
        ok: false,
        error: {
          code: "BROWSER_INPUT_FAILED",
          message: "Browser input could not be dispatched."
        }
      });
      expect(JSON.stringify(failure)).not.toContain("private browser runtime detail");
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("closes the viewer socket when the Browser Host restarts, so the page reconnects to the new host", async () => {
    const { store, pane, session } = browserFixture();
    let host = { hostPid: 101, startedAt: "2026-10-27T10:00:00.000Z" };
    const base = realtimeManager(session, async () => undefined);
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const manager = Object.assign(base, {
      browserHostHealth: vi.fn(async () => ({ ...host, buildCommit: null, status: base.status(), capacity: null, captureMetrics: {} })),
      startFrameStream: async () => {
        const stop = vi.fn(async () => undefined);
        stops.push(stop);
        return {
          id: "browser_stream:test",
          profile: { requestedMode: "AUTO", resolvedMode: "INTERACTIVE", framesPerSecond: 10, format: "jpeg", quality: 70 },
          stop
        };
      }
    }) as BrowserSessionManager;
    const ticket = manager.issueFrameTicket(pane.id, session.sessionId, 60_000);
    const { app, cookie } = await authedApp(store, manager, { SPACE_BROWSER_STREAM_HOST_WATCH_MS: "50" });
    const messages: BrowserStreamWebSocketServerMessage[] = [];
    let closed: { code: number; reason: string } | null = null;
    try {
      await app.injectWS(
        `/api/panes/${encodeURIComponent(pane.id)}/browser/stream?sessionId=${encodeURIComponent(session.sessionId)}` +
          `&token=${encodeURIComponent(ticket.token)}&mode=AUTO`,
        { headers: { cookie } },
        {
          onInit(ws) {
            ws.on("message", (raw, isBinary) => {
              if (!isBinary) messages.push(browserStreamWebSocketServerMessageSchema.parse(JSON.parse(String(raw))));
            });
            ws.on("close", (code, reason) => { closed = { code, reason: reason.toString() }; });
          }
        }
      );
      await waitForMessage(messages, (message) => message.type === "ready");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(closed).toBeNull();
      host = { hostPid: 202, startedAt: "2026-10-27T10:05:00.000Z" };
      const deadline = Date.now() + 5_000;
      while (!closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closed).toEqual({ code: 1012, reason: "Browser Host restarted" });
      expect(messages.some((message) => message.type === "error")).toBe(false);
      while (stops[0]?.mock.calls.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(stops[0]).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("does not send silent audio blocks", async () => {
    const { store, pane, session } = browserFixture();
    let emit: ((chunk: { data: Buffer }) => void) | undefined;
    const manager = Object.assign(realtimeManager(session, async () => undefined), {
      acceptAudioTicket: () => true,
      startAudioStream: async (_sessionId: string, onChunk: (chunk: { data: Buffer }) => void) => {
        emit = onChunk;
        return { id: "browser_audio_stream:test", sampleRate: 48000, channels: 2, format: "s16le", stop: async () => undefined };
      }
    }) as BrowserSessionManager;
    const { app, cookie } = await authedApp(store, manager);
    const messages: BrowserStreamWebSocketServerMessage[] = [];
    const binary: Buffer[] = [];
    try {
      const socket = await app.injectWS(
        `/api/panes/${encodeURIComponent(pane.id)}/browser/audio?sessionId=${encodeURIComponent(session.sessionId)}&token=browser-audio-ticket-test-value`,
        { headers: { cookie } },
        {
          onInit(ws) {
            ws.on("message", (raw, isBinary) => {
              if (isBinary) binary.push(raw as Buffer);
              else messages.push(browserStreamWebSocketServerMessageSchema.parse(JSON.parse(String(raw))));
            });
          }
        }
      );
      await waitForMessage(messages, (message) => message.type === "audioReady");
      emit?.({ data: Buffer.alloc(7680) });
      emit?.({ data: Buffer.from([0, 0, 1, 0]) });
      const deadline = Date.now() + 5_000;
      while (binary.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(binary.map((chunk) => chunk.byteLength)).toEqual([4]);
      socket.terminate();
    } finally {
      await app.close();
    }
  });
});
