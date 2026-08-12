import type { StreamingBotGuardrails } from "@space/contracts";
import type { StreamingChatMessage } from "./youtube-chat.js";

export interface ReplyBudget {
  remaining: number;
  reason: string | null;
}

export interface GuardrailContext {
  guardrails: StreamingBotGuardrails;
  youtubeDailyUnits: number;
  youtubeDailyBudget: number;
  youtubeReplyUnitCost: number;
  now?: () => Date;
}

export class ReplyRateLimiter {
  private readonly timestamps: string[] = [];

  constructor(private readonly maxPerMinute: number) {}

  tryConsume(now: Date): boolean {
    const cutoff = now.getTime() - 60_000;
    while (this.timestamps.length > 0 && Date.parse(this.timestamps[0] ?? "") < cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxPerMinute) return false;
    this.timestamps.push(now.toISOString());
    return true;
  }

  reset(): void {
    this.timestamps.length = 0;
  }
}

const ALL_CAPS_RATIO = 0.7;
const MIN_MESSAGE_LENGTH = 2;
const MAX_MESSAGE_LENGTH = 500;

export function isSpam(message: StreamingChatMessage, recent: StreamingChatMessage[]): boolean {
  const text = message.message.trim();
  if (text.length < MIN_MESSAGE_LENGTH || text.length > MAX_MESSAGE_LENGTH) return true;
  const letters = [...text].filter((character) => /[A-Za-z]/.test(character));
  if (letters.length >= 8) {
    const upper = letters.filter((character) => character === character.toUpperCase()).length;
    if (upper / letters.length > ALL_CAPS_RATIO) return true;
  }
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized.length < 2) return true;
  const duplicate = recent.some((candidate) =>
    candidate.id !== message.id && candidate.message.toLowerCase().replace(/[^a-z0-9]+/g, "") === normalized
  );
  if (duplicate) return true;
  return false;
}

export function messageLengthCap(platform: "YOUTUBE" | "TWITCH"): number {
  return platform === "YOUTUBE" ? 200 : 500;
}

export function truncateReply(text: string, platform: "YOUTUBE" | "TWITCH"): string {
  const cap = messageLengthCap(platform);
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1)}…`;
}

export function youtubeReplyBudget(context: GuardrailContext): ReplyBudget {
  const remaining = context.youtubeDailyBudget - context.youtubeDailyUnits;
  if (remaining < context.youtubeReplyUnitCost) {
    return { remaining: 0, reason: "YOUTUBE_DAILY_QUOTA_EXHAUSTED" };
  }
  return { remaining, reason: null };
}

export function canReply(
  platform: "YOUTUBE" | "TWITCH",
  context: GuardrailContext,
  limiter: ReplyRateLimiter,
  now: Date
): ReplyBudget {
  if (platform === "YOUTUBE") {
    const budget = youtubeReplyBudget(context);
    if (budget.reason) return budget;
  }
  if (!limiter.tryConsume(now)) {
    return { remaining: 0, reason: "RATE_LIMITED" };
  }
  return { remaining: 1, reason: null };
}