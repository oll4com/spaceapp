import { describe, expect, it } from "vitest";
import { YouTubeLiveChatStream } from "../src/youtube-stream.js";
import type { StreamingChatMessage } from "../src/youtube-chat.js";

describe("YouTube streamList cursor handling", () => {
  it("keeps the prior cursor until every message in a large batch has been drained", () => {
    const stream = new YouTubeLiveChatStream("chat:test", "cursor:before");
    const internals = stream as unknown as { batches: Array<{ messages: StreamingChatMessage[]; cursor: string | null }>; queued: number };
    internals.batches.push({ cursor: "cursor:after", messages: Array.from({ length: 900 }, (_, index) => ({
      id: `message:${index}`, author: "Viewer", authorId: `user:${index}`, message: "hello",
      publishedAt: "2026-09-24T12:00:00.000Z"
    })) });
    internals.queued = 900;
    expect(stream.drain()).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ id: "message:0" })]), nextCursor: "cursor:before" });
    expect(internals.queued).toBe(500);
    expect(stream.drain().nextCursor).toBe("cursor:before");
    const final = stream.drain();
    expect(final.messages).toHaveLength(100);
    expect(final.nextCursor).toBe("cursor:after");
    expect(internals.queued).toBe(0);
    stream.close();
  });
});
