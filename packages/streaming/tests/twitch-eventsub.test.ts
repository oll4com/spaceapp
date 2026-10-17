import { afterEach, describe, expect, it, vi } from "vitest";
import { TwitchEventSubChat } from "../src/twitch-eventsub.js";

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  constructor() { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: { data?: unknown } = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  close() { this.emit("close"); }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("TwitchEventSubChat", () => {
  it("rejects instead of hanging when the socket closes before the welcome", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const chat = new TwitchEventSubChat("client", "broadcaster", vi.fn());
    const opening = chat.ensure({ accessToken: "token" } as never);
    FakeSocket.last!.emit("close");
    await expect(opening).rejects.toThrow("closed before the session started");
  });
});
