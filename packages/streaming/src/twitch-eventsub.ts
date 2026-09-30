import { StreamingProviderError } from "./errors.js";
import type { StreamingTokenSet } from "./token-manager.js";
import type { StreamingChatMessage } from "./youtube-chat.js";

interface EventSubEnvelope {
  metadata?: { message_type?: string; message_timestamp?: string };
  payload?: { session?: { id?: string }; event?: Record<string, unknown> };
}

/** One bounded Twitch EventSub session per connected broadcaster account. */
export class TwitchEventSubChat {
  private socket: WebSocket | null = null;
  private readonly messages: StreamingChatMessage[] = [];
  private opening: Promise<void> | null = null;

  constructor(private readonly clientId: string, private readonly broadcasterId: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async ensure(token: StreamingTokenSet): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.opening) return this.opening;
    this.opening = this.connect(token).finally(() => { this.opening = null; });
    return this.opening;
  }

  drain(max = 400): StreamingChatMessage[] {
    return this.messages.splice(0, Math.max(1, Math.min(max, 400)));
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.messages.length = 0;
  }

  private async connect(token: StreamingTokenSet): Promise<void> {
    const socket = new WebSocket("wss://eventsub.wss.twitch.tv/ws");
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("Twitch EventSub welcome timed out.")); }, 12_000);
      socket.addEventListener("message", event => {
        let envelope: EventSubEnvelope;
        try { envelope = JSON.parse(String(event.data)) as EventSubEnvelope; } catch { return; }
        if (envelope.metadata?.message_type === "session_welcome") {
          const sessionId = envelope.payload?.session?.id;
          if (!sessionId) { clearTimeout(timer); reject(new Error("Twitch EventSub session id is missing.")); return; }
          void this.subscribe(token, sessionId).then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); socket.close(); reject(error); });
          return;
        }
        if (envelope.metadata?.message_type !== "notification") return;
        const chat = envelope.payload?.event;
        if (!chat || typeof chat.message_id !== "string" || typeof chat.chatter_user_name !== "string") return;
        const payload = chat.message;
        const text = payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string" ? payload.text : null;
        if (!text) return;
        if (this.messages.length >= 20_000) this.messages.shift();
        this.messages.push({ id: chat.message_id, author: chat.chatter_user_name,
          authorId: typeof chat.chatter_user_id === "string" ? chat.chatter_user_id : null,
          message: text.slice(0, 2_000), publishedAt: envelope.metadata?.message_timestamp ?? new Date().toISOString(),
          protectedAccount: Array.isArray(chat.badges) && chat.badges.some(badge => badge && typeof badge === "object" && "set_id" in badge && (badge.set_id === "broadcaster" || badge.set_id === "moderator")) });
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Twitch EventSub connection failed.")); });
      socket.addEventListener("close", () => { if (this.socket === socket) this.socket = null; clearTimeout(timer); });
    });
  }

  private async subscribe(token: StreamingTokenSet, sessionId: string): Promise<void> {
    const response = await this.fetchImpl("https://api.twitch.tv/helix/eventsub/subscriptions", {
      method: "POST", signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${token.accessToken}`, "Client-Id": this.clientId, "content-type": "application/json" },
      body: JSON.stringify({ type: "channel.chat.message", version: "1",
        condition: { broadcaster_user_id: this.broadcasterId, user_id: this.broadcasterId },
        transport: { method: "websocket", session_id: sessionId } })
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new StreamingProviderError(`TWITCH_EVENTSUB_${response.status}`, `Twitch EventSub returned HTTP ${response.status}.`, response.status >= 500, response.status);
    }
    await response.body?.cancel().catch(() => undefined);
  }
}
