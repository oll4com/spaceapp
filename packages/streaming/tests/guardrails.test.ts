import { describe, expect, it } from "vitest";
import {
  ReplyRateLimiter,
  canReply,
  isSpam,
  isViewerQuestion,
  messageLengthCap,
  truncateReply,
  youtubeReplyBudget
} from "../src/guardrails.js";
import type { StreamingChatMessage } from "../src/youtube-chat.js";

const baseGuardrails = {
  cooldownSeconds: 15,
  maxRepliesPerMinute: 5,
  replyToQuestionsOnly: true
};

function message(partial: Partial<StreamingChatMessage> & { id: string; message: string }): StreamingChatMessage {
  return {
    author: "viewer",
    authorId: null,
    publishedAt: new Date().toISOString(),
    ...partial
  };
}

describe("isSpam", () => {
  it("rejects empty and too-short messages", () => {
    expect(isSpam(message({ id: "a", message: "" }), [])).toBe(true);
    expect(isSpam(message({ id: "b", message: "x" }), [])).toBe(true);
  });

  it("rejects all-caps messages", () => {
    expect(isSpam(message({ id: "c", message: "HELLO WORLD EVERYONE" }), [])).toBe(true);
  });

  it("accepts normal questions", () => {
    expect(isSpam(message({ id: "d", message: "What is the website?" }), [])).toBe(false);
  });

  it("rejects duplicate messages", () => {
    const first = message({ id: "e", message: "What is the website?" });
    const second = message({ id: "f", message: "what is the website !!" });
    expect(isSpam(second, [first])).toBe(true);
  });

  it("keeps Greek questions eligible while recognizing duplicates", () => {
    const first = message({ id: "g1", message: "Πώς λειτουργεί το SpaceApp;" });
    expect(isSpam(first, [])).toBe(false);
    expect(isSpam(message({ id: "g2", message: "πώς λειτουργεί το spaceapp?" }), [first])).toBe(true);
  });
});

describe("question-only replies", () => {
  it("accepts English and Greek questions without treating statements as questions", () => {
    expect(isViewerQuestion("How does SpaceApp work")).toBe(true);
    expect(isViewerQuestion("Πώς λειτουργεί το SpaceApp")).toBe(true);
    expect(isViewerQuestion("I like this stream")).toBe(false);
  });
});

describe("messageLengthCap / truncateReply", () => {
  it("caps YouTube at 200 and Twitch at 500", () => {
    expect(messageLengthCap("YOUTUBE")).toBe(200);
    expect(messageLengthCap("TWITCH")).toBe(500);
  });

  it("truncates long replies", () => {
    const long = "x".repeat(300);
    const truncated = truncateReply(long, "YOUTUBE");
    expect(truncated.length).toBe(200);
    expect(truncated.endsWith("…")).toBe(true);
  });

  it("keeps short replies intact", () => {
    expect(truncateReply("hello", "TWITCH")).toBe("hello");
  });
});

describe("youtubeReplyBudget", () => {
  it("allows replies while quota remains", () => {
    const budget = youtubeReplyBudget({
      guardrails: baseGuardrails,
      youtubeDailyUnits: 1000,
      youtubeDailyBudget: 8000,
      youtubeReplyUnitCost: 200
    });
    expect(budget.reason).toBeNull();
    expect(budget.remaining).toBe(7000);
  });

  it("blocks replies when quota is exhausted", () => {
    const budget = youtubeReplyBudget({
      guardrails: baseGuardrails,
      youtubeDailyUnits: 7900,
      youtubeDailyBudget: 8000,
      youtubeReplyUnitCost: 200
    });
    expect(budget.reason).toBe("YOUTUBE_DAILY_QUOTA_EXHAUSTED");
    expect(budget.remaining).toBe(0);
  });
});

describe("ReplyRateLimiter + canReply", () => {
  it("enforces max replies per minute", () => {
    const limiter = new ReplyRateLimiter(2);
    const context = {
      guardrails: baseGuardrails,
      youtubeDailyUnits: 0,
      youtubeDailyBudget: 8000,
      youtubeReplyUnitCost: 200
    };
    const now = new Date("2026-08-12T00:00:00Z");
    expect(canReply("TWITCH", context, limiter, now).reason).toBeNull();
    expect(canReply("TWITCH", context, limiter, now).reason).toBeNull();
    expect(canReply("TWITCH", context, limiter, now).reason).toBe("RATE_LIMITED");
  });

  it("blocks YouTube replies when quota is exhausted before rate check", () => {
    const limiter = new ReplyRateLimiter(5);
    const context = {
      guardrails: baseGuardrails,
      youtubeDailyUnits: 8000,
      youtubeDailyBudget: 8000,
      youtubeReplyUnitCost: 200
    };
    expect(canReply("YOUTUBE", context, limiter, new Date()).reason).toBe("YOUTUBE_DAILY_QUOTA_EXHAUSTED");
  });
});
