import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelInboundMessage } from "@space/contracts";

/**
 * Space Dots Stage 6: Slack Events API adapter.
 *
 * Requests are accepted only with a valid v0 signature
 * (HMAC-SHA256 of "v0:{timestamp}:{raw body}" with the app's signing secret)
 * and a timestamp within five minutes. Messages from bots, edits and other
 * subtypes are ignored; retries are deduplicated by event id upstream.
 */
export function verifySlackSignature(input: { rawBody: string; timestamp: string | undefined; signature: string | undefined; signingSecret: string; nowMs?: number }): boolean {
  const { timestamp, signature } = input;
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs((input.nowMs ?? Date.now()) / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", input.signingSecret).update(`v0:${timestamp}:${input.rawBody}`).digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export type SlackEnvelope =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; message: ChannelInboundMessage }
  | { kind: "ignored"; reason: string };

/** Reads a verified Events API payload. */
export function parseSlackEnvelope(raw: string): SlackEnvelope {
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return { kind: "ignored", reason: "not json" }; }
  if (body.type === "url_verification" && typeof body.challenge === "string") return { kind: "challenge", challenge: body.challenge.slice(0, 200) };
  if (body.type !== "event_callback" || typeof body.event_id !== "string" || typeof body.team_id !== "string") return { kind: "ignored", reason: "not an event" };
  const event = (body.event ?? {}) as Record<string, unknown>;
  if (event.bot_id || event.subtype) return { kind: "ignored", reason: "bot or subtype" };
  if (event.type !== "message" && event.type !== "app_mention") return { kind: "ignored", reason: "event type" };
  const channel = typeof event.channel === "string" ? event.channel : null;
  const user = typeof event.user === "string" ? event.user : null;
  const ts = typeof event.ts === "string" ? event.ts : null;
  const text = typeof event.text === "string" ? event.text : "";
  if (!channel || !user || !ts) return { kind: "ignored", reason: "incomplete" };
  const direct = event.channel_type === "im";
  // In channels only mentions reach the Dot, so ordinary conversation is never read.
  if (!direct && event.type !== "app_mention") return { kind: "ignored", reason: "not addressed" };
  const cleaned = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!cleaned) return { kind: "ignored", reason: "empty" };
  return { kind: "message", message: { provider: "SLACK", tenantId: body.team_id, eventId: body.event_id, conversationId: channel,
    threadKey: typeof event.thread_ts === "string" ? event.thread_ts : direct ? "direct" : ts, conversationKind: direct ? "DIRECT" : "GROUP",
    externalUserId: user, replyAddress: user, displayName: null, text: cleaned.slice(0, 8000), serviceUrl: null } };
}

export interface SlackClient {
  post(input: { channel: string; text: string; threadTs?: string | null }): Promise<void>;
  /** Opens (or reuses) the direct conversation with a user. */
  openDirect(userId: string): Promise<string>;
}

export function createSlackClient(input: { botToken: string; fetchImpl?: typeof fetch }): SlackClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  async function call(method: string, payload: Record<string, unknown>) {
    const response = await fetchImpl(`https://slack.com/api/${method}`, { method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${input.botToken}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || body.ok !== true) throw new Error(`Slack ${method} failed: ${typeof body.error === "string" ? body.error.slice(0, 80) : response.status}`);
    return body;
  }
  return {
    async post({ channel, text, threadTs }) {
      await call("chat.postMessage", { channel, text: text.slice(0, 39_000), ...(threadTs && threadTs !== "direct" ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false });
    },
    async openDirect(userId) {
      const body = await call("conversations.open", { users: userId });
      const id = (body.channel as { id?: unknown } | undefined)?.id;
      if (typeof id !== "string") throw new Error("Slack did not open a direct conversation.");
      return id;
    }
  };
}
