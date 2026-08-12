import { StreamingProviderError } from "./errors.js";
import type { StreamingTokenSet } from "./token-manager.js";
import type { StreamingChatMessage, StreamingChatPage } from "./youtube-chat.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Twitch returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bearerHeaders(token: StreamingTokenSet, clientId: string): Record<string, string> {
  return { Authorization: `Bearer ${token.accessToken}`, "Client-Id": clientId };
}

export interface TwitchChatConnectorOptions {
  clientId: string;
  fetchImpl?: typeof fetch;
}

export class TwitchChatConnector {
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;

  constructor(options: TwitchChatConnectorOptions) {
    this.clientId = options.clientId;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async isStreamLive(token: StreamingTokenSet, broadcasterId: string): Promise<boolean> {
    const url = new URL("https://api.twitch.tv/helix/streams");
    url.search = new URLSearchParams({ broadcaster_id: broadcasterId }).toString();
    const payload = await this.requestJson(url.toString(), { headers: bearerHeaders(token, this.clientId) });
    return asArray(payload.data).length > 0;
  }

  async listChatMessages(token: StreamingTokenSet, broadcasterId: string, moderatorId: string, cursor: string | null): Promise<StreamingChatPage> {
    const url = new URL("https://api.twitch.tv/helix/chat/messages");
    url.search = new URLSearchParams({
      broadcaster_id: broadcasterId,
      moderator_id: moderatorId,
      first: "100",
      after: cursor ?? ""
    }).toString();
    const payload = await this.requestJson(url.toString(), { headers: bearerHeaders(token, this.clientId) });
    const messages = asArray(payload.data).flatMap((value) => {
      const item = asRecord(value);
      const id = stringValue(item.id);
      const author = stringValue(item.chatter_user_name);
      const authorId = stringValue(item.chatter_user_id);
      const messagePayload = asRecord(item.message ?? {});
      const message = stringValue(messagePayload.text) ?? stringValue(item.text);
      const publishedAt = stringValue(item.sent_at ?? item.created_at);
      if (!id || !message || !author) return [];
      return [{
        id,
        author,
        authorId,
        message,
        publishedAt: publishedAt ?? new Date().toISOString()
      }];
    });
    const pagination = asRecord(payload.pagination ?? {});
    return {
      messages,
      nextCursor: stringValue(pagination.cursor)
    };
  }

  async sendChatMessage(token: StreamingTokenSet, broadcasterId: string, senderId: string, text: string): Promise<string> {
    const payload = await this.requestJson("https://api.twitch.tv/helix/chat/messages", {
      method: "POST",
      headers: { ...bearerHeaders(token, this.clientId), "content-type": "application/json" },
      body: JSON.stringify({
        broadcaster_id: broadcasterId,
        sender_id: senderId,
        message: text
      })
    });
    const data = asArray(payload.data)[0];
    const record = data ? asRecord(data) : null;
    const id = record ? stringValue(record.message_id) : null;
    if (!id) throw new StreamingProviderError("TWITCH_SEND_INVALID", "Twitch did not return a message id.", false);
    return id;
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new StreamingProviderError("TWITCH_NETWORK", "Twitch could not be reached.", true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new StreamingProviderError(
        `TWITCH_HTTP_${response.status}`,
        `Twitch returned HTTP ${response.status}.`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status
      );
    }
    try {
      return asRecord(await response.json());
    } catch {
      throw new StreamingProviderError("TWITCH_RESPONSE_INVALID", "Twitch returned invalid JSON.", false, response.status);
    }
  }
}