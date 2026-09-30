import * as grpc from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import protobuf from "protobufjs";
import type { StreamingChatMessage, StreamingChatPage } from "./youtube-chat.js";
import type { StreamingTokenSet } from "./token-manager.js";

// Minimal wire-compatible subset of Google's published stream_list.proto.
const STREAM_PROTO = `syntax = "proto2";
package youtube.api.v3;
service V3DataLiveChatMessageService {
  rpc StreamList(LiveChatMessageListRequest) returns (stream LiveChatMessageListResponse) {}
}
message LiveChatMessageListRequest {
  optional string live_chat_id = 1;
  optional string page_token = 99;
  repeated string part = 100;
}
message LiveChatMessageListResponse {
  optional string next_page_token = 100602;
  repeated LiveChatMessage items = 1007;
}
message LiveChatMessage {
  optional string id = 101;
  optional LiveChatMessageSnippet snippet = 2;
  optional LiveChatMessageAuthorDetails author_details = 3;
}
message LiveChatMessageSnippet {
  optional string published_at = 4;
  optional string display_message = 16;
  optional LiveChatTextMessageDetails text_message_details = 19;
}
message LiveChatTextMessageDetails { optional string message_text = 1; }
message LiveChatMessageAuthorDetails {
  optional string channel_id = 10101;
  optional string display_name = 103;
  optional bool is_chat_owner = 5;
  optional bool is_chat_moderator = 7;
}`;

type GrpcStream = grpc.ClientReadableStream<unknown>;
type StreamClient = grpc.Client & { StreamList(request: Record<string, unknown>, metadata: grpc.Metadata): GrpcStream };
type StreamClientConstructor = new (address: string, credentials: grpc.ChannelCredentials) => StreamClient;
const definition = fromJSON(protobuf.parse(STREAM_PROTO).root.toJSON(), { keepCase: false });
const youtube = grpc.loadPackageDefinition(definition).youtube as grpc.GrpcObject;
const api = youtube.api as grpc.GrpcObject;
const v3 = api.v3 as grpc.GrpcObject;
const ClientConstructor = v3.V3DataLiveChatMessageService as unknown as StreamClientConstructor;

interface StreamMessage {
  id?: string;
  snippet?: { publishedAt?: string; displayMessage?: string; textMessageDetails?: { messageText?: string } };
  authorDetails?: { channelId?: string; displayName?: string; isChatOwner?: boolean; isChatModerator?: boolean };
}
interface StreamBatch { nextPageToken?: string; items?: StreamMessage[] }

export class YouTubeLiveChatStream {
  private client: StreamClient | null = null;
  private stream: GrpcStream | null = null;
  private readonly batches: Array<{ messages: StreamingChatMessage[]; cursor: string | null }> = [];
  private queued = 0;
  private cursor: string | null;
  private healthy = false;
  private retryAt = 0;
  private opening: Promise<void> | null = null;

  constructor(readonly chatId: string, cursor: string | null) { this.cursor = cursor; }

  async ensure(token: StreamingTokenSet): Promise<boolean> {
    if (this.healthy && this.stream) return true;
    if (Date.now() < this.retryAt) return false;
    if (this.opening) { await this.opening.catch(() => undefined); return this.healthy; }
    this.opening = this.connect(token).finally(() => { this.opening = null; });
    await this.opening.catch(() => undefined);
    return this.healthy;
  }

  drain(max = 400): StreamingChatPage {
    const messages: StreamingChatMessage[] = [];
    const limit = Math.max(1, Math.min(max, 400));
    while (this.batches.length && messages.length < limit) {
      const batch = this.batches[0]!;
      const taken = batch.messages.splice(0, limit - messages.length);
      messages.push(...taken);
      this.queued -= taken.length;
      if (batch.messages.length === 0) {
        this.batches.shift();
        if (batch.cursor) this.cursor = batch.cursor;
      }
    }
    return { messages, nextCursor: this.cursor };
  }

  close(): void {
    this.stream?.cancel();
    this.client?.close();
    this.stream = null;
    this.client = null;
    this.batches.length = 0;
    this.queued = 0;
    this.healthy = false;
  }

  private async connect(token: StreamingTokenSet): Promise<void> {
    this.close();
    const client = new ClientConstructor("youtube.googleapis.com:443", grpc.credentials.createSsl());
    this.client = client;
    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${token.accessToken}`);
    const stream = client.StreamList({ liveChatId: this.chatId, part: ["id", "snippet", "authorDetails"],
      ...(this.cursor ? { pageToken: this.cursor } : {}) }, metadata);
    this.stream = stream;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        this.retryAt = Date.now() + 30_000;
        stream.cancel();
        finish(new Error("YouTube streamList did not respond."));
      }, 8_000);
      stream.on("data", value => {
        if (this.stream !== stream) return;
        const batch = value as StreamBatch;
        const messages: StreamingChatMessage[] = [];
        for (const item of batch.items ?? []) {
          const text = item.snippet?.displayMessage ?? item.snippet?.textMessageDetails?.messageText;
          const author = item.authorDetails?.displayName;
          if (!item.id || !author || !text || !item.snippet?.publishedAt) continue;
          messages.push({ id: item.id, author, authorId: item.authorDetails?.channelId ?? null,
            message: text.slice(0, 2_000), publishedAt: item.snippet.publishedAt,
            protectedAccount: item.authorDetails?.isChatOwner === true || item.authorDetails?.isChatModerator === true });
        }
        if (this.queued + messages.length > 20_000) {
          this.stream?.cancel();
          this.healthy = false;
          this.retryAt = Date.now() + 5_000;
          finish(new Error("YouTube chat queue is full; resuming from the persisted cursor."));
          return;
        }
        const last = this.batches.at(-1);
        if (messages.length === 0 && last?.messages.length === 0) last.cursor = batch.nextPageToken ?? last.cursor;
        else this.batches.push({ messages, cursor: batch.nextPageToken ?? null });
        this.queued += messages.length;
        this.healthy = true;
        finish();
      });
      stream.on("error", () => {
        if (this.stream === stream) { this.stream = null; this.healthy = false; this.retryAt = Date.now() + 30_000; }
        finish(new Error("YouTube streamList disconnected."));
      });
      stream.on("end", () => {
        if (this.stream === stream) { this.stream = null; this.healthy = false; this.retryAt = Date.now() + 5_000; }
        finish(new Error("YouTube streamList ended."));
      });
    });
  }
}
