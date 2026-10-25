import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyVoiceUpstreamClose, relayVoiceSockets, VoiceProxyTickets, voiceProxyLimits } from "../src/voice-ws-proxy.js";

afterEach(() => vi.useRealTimers());
const ticket = { ownerId: "owner:a", origin: "https://space.test", wsUrl: "wss://provider.test", token: "private", provider: "vercel" };

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0;
  send = vi.fn((_data: unknown, _options: unknown, callback?: (error?: Error) => void) => callback?.());
  close = vi.fn(() => { this.readyState = 3; this.emit("close", 1000, Buffer.from("private close reason")); });
  terminate = vi.fn(() => { this.readyState = 3; this.emit("close"); });
}
function relay(connecting = true, limits = voiceProxyLimits) {
  const client = new Socket(); const upstream = new Socket(); const onClose = vi.fn();
  if (connecting) upstream.readyState = 0;
  const stop = relayVoiceSockets(client as unknown as WebSocket, upstream as unknown as WebSocket, { onClose, limits });
  if (!connecting) upstream.emit("open");
  return { client, upstream, onClose, stop };
}
describe("voice proxy tickets", () => {
  it("uses single-use owner/origin-scoped tickets and rejects foreign consumption", () => {
    const tickets = new VoiceProxyTickets(); const id = tickets.create(ticket);
    expect(id).toMatch(/^vws_[0-9a-f-]{36}$/);
    expect(tickets.take(id, "owner:b", ticket.origin)).toBeUndefined();
    expect(tickets.take(id, ticket.ownerId, "https://foreign.test")).toBeUndefined();
    expect(tickets.take(id, ticket.ownerId, ticket.origin)).toMatchObject(ticket);
    expect(tickets.take(id, ticket.ownerId, ticket.origin)).toBeUndefined();
  });
  it("expires tickets on access and bounds pending tickets per owner and globally", () => {
    let now = 100;
    const tickets = new VoiceProxyTickets({ ...voiceProxyLimits, maxPending: 2, maxPendingPerOwner: 1 }, () => now);
    const id = tickets.create(ticket);
    expect(() => tickets.create(ticket)).toThrow("Too many pending");
    tickets.create({ ...ticket, ownerId: "owner:b" });
    expect(() => tickets.create({ ...ticket, ownerId: "owner:c" })).toThrow("Too many pending");
    now += voiceProxyLimits.ticketTtlMs;
    expect(tickets.take(id, ticket.ownerId, ticket.origin)).toBeUndefined();
    const newId = tickets.create(ticket); tickets.clear();
    expect(tickets.take(newId, ticket.ownerId, ticket.origin)).toBeUndefined();
  });
});
describe("bounded voice relay", () => {
  it("preserves long instructions and binary flags while buffering and flushing in order", () => {
    vi.useFakeTimers(); const h = relay();
    const instructions = Buffer.from(JSON.stringify({ type: "session.instructions.append", content: "Full context ".repeat(1000) }));
    const audio = Buffer.from([1, 2, 3]);
    h.client.emit("message", instructions, false); h.client.emit("message", audio, true);
    expect(h.upstream.send).not.toHaveBeenCalled();
    h.upstream.readyState = 1; h.upstream.emit("open");
    expect(h.upstream.send.mock.calls.map(args => args.slice(0, 2))).toEqual([[instructions, { binary: false }], [audio, { binary: true }]]);
    h.stop(); expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.onClose.mock.calls)).not.toContain("Full context");
  });
  it.each(["count", "bytes"])("fails explicitly at the connecting-buffer %s limit", (mode) => {
    vi.useFakeTimers(); const h = relay(true, { ...voiceProxyLimits, maxBufferedMessages: mode === "count" ? 1 : 128, maxBufferedBytes: mode === "bytes" ? 3 : 1024 });
    h.client.emit("message", Buffer.from("abc"), false); h.client.emit("message", Buffer.from("def"), false);
    expect(h.onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "voice_connect_buffer_limit" }));
    h.upstream.readyState = 1; h.upstream.emit("open");
    expect(h.upstream.send).not.toHaveBeenCalled();
  });
  it("enforces upstream timeout, peer backpressure and frame limits", () => {
    vi.useFakeTimers(); const timeout = relay();
    vi.advanceTimersByTime(voiceProxyLimits.connectTimeoutMs);
    expect(timeout.onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "upstream_connect_timeout" }));
    const pressure = relay(false); pressure.client.bufferedAmount = voiceProxyLimits.maxBufferedBytes;
    pressure.upstream.emit("message", Buffer.from("audio"), false);
    expect(pressure.client.send).not.toHaveBeenCalled();
    expect(pressure.onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "voice_transport_limit" }));
    const frame = relay(false); frame.client.emit("message", Buffer.alloc(voiceProxyLimits.maxFrameBytes + 1), true);
    expect(frame.upstream.send).not.toHaveBeenCalled();
    expect(frame.onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "voice_frame_too_large" }));
  });
  it("does not leak provider errors, reconnect or replay messages after disconnect", () => {
    vi.useFakeTimers(); const h = relay();
    h.client.emit("message", Buffer.from("pending private content"), false);
    h.upstream.emit("error", new Error("secret-key in provider URL"));
    h.client.emit("message", Buffer.from("late"), false);
    h.upstream.readyState = 1; h.upstream.emit("open");
    expect(h.upstream.send).not.toHaveBeenCalled();
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledWith({ reason: "upstream_error", clientMessages: 1, upstreamMessages: 0, upstreamCloseCode: null });
    expect(JSON.stringify(h.client.close.mock.calls)).not.toContain("secret-key");
    vi.runAllTimers();
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
  it("marks an upstream close as a relay failure instead of a clean client end", () => {
    vi.useFakeTimers(); const h = relay(false);
    h.upstream.emit("close", 1000, Buffer.from("provider closed"));
    expect(h.onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: "upstream_closed" }));
    expect(h.client.close).toHaveBeenCalledWith(1011, "upstream_closed");
  });
  it("reports the provider close code without copying the provider close reason", () => {
    vi.useFakeTimers(); const h = relay(false);
    h.client.emit("message", Buffer.from("{\"setup\":{\"model\":\"private prompt text\"}}"), false);
    h.upstream.emit("close", 1007, Buffer.from("Invalid JSON payload received. Unknown name \"additionalProperties\""));
    expect(h.onClose).toHaveBeenCalledWith({
      reason: "upstream_closed", clientMessages: 1, upstreamMessages: 0, upstreamCloseCode: 1007
    });
    expect(JSON.stringify(h.onClose.mock.calls)).not.toContain("additionalProperties");
    expect(JSON.stringify(h.onClose.mock.calls)).not.toContain("private prompt");
    expect(JSON.stringify(h.client.close.mock.calls)).not.toContain("additionalProperties");
  });
  it("tells the browser that the provider's credits are used up or its key was rejected, without the provider's text", () => {
    vi.useFakeTimers(); const h = relay(false);
    h.upstream.emit("close", 1011, Buffer.from("Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects?key=secret-key"));
    expect(h.client.close).toHaveBeenCalledWith(1011, "provider_quota_exhausted");
    expect(h.onClose).toHaveBeenCalledWith({ reason: "provider_quota_exhausted", clientMessages: 0, upstreamMessages: 0, upstreamCloseCode: 1011 });
    expect(JSON.stringify([h.client.close.mock.calls, h.onClose.mock.calls])).not.toMatch(/secret-key|ai\.studio|prepayment/);
    expect(classifyVoiceUpstreamClose("API key not valid. Please pass a valid API key.")).toBe("provider_auth_failed");
    expect(classifyVoiceUpstreamClose("RESOURCE_EXHAUSTED: quota")).toBe("provider_quota_exhausted");
    expect(classifyVoiceUpstreamClose("Invalid JSON payload received.")).toBe("upstream_closed");
    expect(classifyVoiceUpstreamClose("")).toBe("upstream_closed");
  });
});
