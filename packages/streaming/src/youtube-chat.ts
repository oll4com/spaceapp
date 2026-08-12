import { StreamingProviderError } from "./errors.js";
import type { StreamingTokenSet } from "./token-manager.js";

export interface StreamingChatMessage {
  id: string;
  author: string;
  authorId: string | null;
  message: string;
  publishedAt: string;
}

export interface StreamingChatPage {
  messages: StreamingChatMessage[];
  nextCursor: string | null;
}

export interface LiveBroadcastInfo {
  chatId: string;
  videoId: string | null;
  title: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("YouTube returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formBody(entries: Record<string, string | null | undefined>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value) body.set(key, value);
  return body;
}

function bearerHeaders(token: StreamingTokenSet, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token.accessToken}`, ...extra };
}

export class YouTubeChatConnector {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async findActiveBroadcast(token: StreamingTokenSet): Promise<LiveBroadcastInfo | null> {
    const url = new URL("https://www.googleapis.com/youtube/v3/liveBroadcasts");
    url.search = formBody({
      part: "id,snippet,contentDetails,status",
      mine: "true",
      broadcastStatus: "active",
      maxResults: "1"
    }).toString();
    const payload = await this.requestJson(url.toString(), { headers: bearerHeaders(token) });
    const item = asArray(payload.items)[0];
    if (!item) return null;
    const broadcast = asRecord(item);
    const snippet = asRecord(broadcast.snippet ?? {});
    const contentDetails = asRecord(broadcast.contentDetails ?? {});
    const chatId = stringValue(snippet.liveChatId) ?? stringValue(contentDetails.liveChatId);
    if (!chatId) return null;
    return {
      chatId,
      videoId: stringValue(broadcast.id),
      title: stringValue(snippet.title)
    };
  }

  async listChatMessages(token: StreamingTokenSet, liveChatId: string, cursor: string | null): Promise<StreamingChatPage> {
    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.search = formBody({
      part: "snippet,authorDetails",
      liveChatId,
      maxResults: "200",
      pageToken: cursor
    }).toString();
    const payload = await this.requestJson(url.toString(), { headers: bearerHeaders(token) });
    const messages = asArray(payload.items).flatMap((value) => {
      const item = asRecord(value);
      const snippet = asRecord(item.snippet ?? {});
      const authorDetails = asRecord(item.authorDetails ?? {});
      const id = stringValue(item.id);
      const message = stringValue(snippet.displayMessage);
      const author = stringValue(authorDetails.displayName);
      const authorId = stringValue(authorDetails.channelId);
      const publishedAt = stringValue(snippet.publishedAt);
      if (!id || !message || !author || !publishedAt) return [];
      return [{
        id,
        author,
        authorId,
        message,
        publishedAt
      }];
    });
    return {
      messages,
      nextCursor: stringValue(payload.nextPageToken)
    };
  }

  async sendChatMessage(token: StreamingTokenSet, liveChatId: string, text: string): Promise<string> {
    const url = new URL("https://www.googleapis.com/youtube/v3/liveChat/messages");
    url.search = formBody({ part: "snippet" }).toString();
    const payload = await this.requestJson(url.toString(), {
      method: "POST",
      headers: { ...bearerHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({
        snippet: {
          liveChatId,
          type: "textMessageEvent",
          textMessageDetails: { messageText: text }
        }
      })
    });
    const id = stringValue(payload.id);
    if (!id) throw new StreamingProviderError("YOUTUBE_SEND_INVALID", "YouTube did not return a message id.", false);
    return id;
  }

  private async requestJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new StreamingProviderError("YOUTUBE_NETWORK", "YouTube could not be reached.", true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new StreamingProviderError(
        `YOUTUBE_HTTP_${response.status}`,
        `YouTube returned HTTP ${response.status}.`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status
      );
    }
    try {
      return asRecord(await response.json());
    } catch {
      throw new StreamingProviderError("YOUTUBE_RESPONSE_INVALID", "YouTube returned invalid JSON.", false, response.status);
    }
  }
}