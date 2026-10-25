// Telegram two-way for Nous (operator request 2026-10-24): the paired chat writes to Nous and gets the answer there, and answers
// Nous's decisions with the card's Approve/Decline buttons or a reply in words. Only the paired chat; the dock's gates stay.
import { describe, expect, it, vi } from "vitest";
import type { NousDecision } from "@space/contracts";
import { SpaceConflictError, SpaceNotFoundError, type TelegramIntegrationRecord, type TelegramUpdate } from "@space/runtime";
import { createNousTelegram, NOUS_TELEGRAM_CHUNK, type NousTelegramClient } from "../src/nous/telegram.js";

const owner = "user:operator";
const integration = (patch: Partial<TelegramIntegrationRecord> = {}): TelegramIntegrationRecord => ({
  connectionStatus: "CONNECTED", isEnabled: true, botUserId: "42", botUsername: "space_bot", chatId: "123", chatDisplayName: "Operator", secretVersion: "v1", generation: 1,
  pollingOffset: 7, legacySuppressionActive: false, pairedAt: null, enabledAt: null, disabledAt: null, lastTestedAt: null, lastDeliveredAt: null, lastErrorCode: null, lastErrorAt: null,
  createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z", ...patch
} as TelegramIntegrationRecord);
const message = (updateId: number, text: string, chatId = "123", replyToText?: string): TelegramUpdate =>
  ({ updateId, message: { text, chat: { id: chatId, type: "private" }, ...(replyToText ? { replyToText } : {}) } });
const button = (updateId: number, data: string, chatId = "123"): TelegramUpdate => ({ updateId, callbackQuery: { id: `q${updateId}`, data, chatId } });
const decision = (id: string, status: NousDecision["status"] = "APPROVED", outcome: string | null = "Sent to Andy.") =>
  ({ id, ownerUserId: owner, status, outcome, title: "Send the proposal?" } as unknown as NousDecision);

function fixture(options: { updates?: TelegramUpdate[][]; record?: Partial<TelegramIntegrationRecord>; pending?: boolean; owners?: Array<string | null>; failPoll?: Error } = {}) {
  const batches = [...(options.updates ?? [])];
  const sent: Array<{ chatId: string; text: string; markup?: unknown }> = [];
  const acknowledged: Array<{ id: string; text?: string }> = [];
  const offsets: number[] = [];
  let record = integration(options.record);
  const client: NousTelegramClient = {
    getUpdates: vi.fn(async () => { if (options.failPoll) throw options.failPoll; return batches.shift() ?? []; }),
    sendMessage: vi.fn(async (chatId: string, text: string, sendOptions?: { replyMarkup?: unknown }) => { sent.push({ chatId, text, markup: sendOptions?.replyMarkup }); return { messageId: String(sent.length) }; }),
    answerCallbackQuery: vi.fn(async (id: string, text?: string) => { acknowledged.push({ id, text }); })
  };
  const send = vi.fn(async (_owner: string, text: string) => ({ id: `nous_msg:${text.length}` }) as never);
  const answer = vi.fn(async (_owner: string, id: string, input: { answer: string; text?: string }) => {
    if (id.endsWith("gone")) throw new SpaceNotFoundError("This decision does not exist.");
    if (id.endsWith("done")) throw new SpaceConflictError("This decision was already answered.");
    return decision(id, input.answer === "DECLINE" || input.text === "όχι" ? "DECLINED" : input.text && input.text !== "ναι" ? "ANSWERED" : "APPROVED", input.answer === "APPROVE" || input.text === "ναι" ? "Sent to Andy." : null);
  });
  const owners = [...(options.owners ?? [])];
  const telegram = createNousTelegram({
    persistence: { getIntegration: async () => record, getPendingPairing: async () => (options.pending ? { pairingId: "p1" } as never : null),
      updateIntegrationOffset: async (offset) => { offsets.push(offset); record = { ...record, pollingOffset: Math.max(record.pollingOffset, offset) }; } },
    secrets: { read: async () => "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE" },
    owner: async () => (owners.length ? owners.shift()! : owner),
    service: { send, answer } as never,
    clientFactory: () => client,
    now: () => Date.parse("2026-10-24T10:00:00.000Z")
  });
  return { telegram, client, sent, acknowledged, offsets, send, answer, record: () => record };
}

describe("Nous on Telegram", () => {
  it("takes the paired chat's text as the operator's message, keeps the offset, skips older updates and ignores other chats", async () => {
    const f = fixture({ updates: [[message(9, "status?"), message(8, "old"), message(10, "hello from a stranger", "999"), message(3, "stale"), message(11, "/start abc")]] });
    await f.telegram.poll();
    expect(f.client.getUpdates).toHaveBeenCalledWith(7, { allowed: ["message", "callback_query"], timeoutSeconds: 20 });
    expect(f.send.mock.calls.map((call) => [call[1], call[2]])).toEqual([["old", { person: true, via: "TELEGRAM" }], ["status?", { person: true, via: "TELEGRAM" }]]);
    expect(f.offsets).toEqual([12]);
    expect(f.record().pollingOffset).toBe(12);
    // The answer goes back to the chat in Telegram-sized parts.
    expect(await f.telegram.answer(owner, "x".repeat(NOUS_TELEGRAM_CHUNK + 10))).toBe(true);
    expect(f.sent.map((item) => [item.chatId, item.text.length])).toEqual([["123", NOUS_TELEGRAM_CHUNK], ["123", 10]]);
  });

  it("sends a decision card with Approve and Decline buttons bound to the decision, and answers a button press like the dock", async () => {
    const f = fixture({ updates: [[button(20, "nd:abc123def456:a"), button(21, "nd:zzz999done:d"), button(22, "nd:abc123gone:a"), button(23, "nd:abc123def456:a", "999"), button(24, "garbage")]] });
    expect(await f.telegram.decisionCard(owner, decision("nous_decision:abc123def456", "OPEN", null), "Nous: Send the proposal?\nRecommendation: send")).toBe(true);
    expect(f.sent[0]).toEqual({ chatId: "123", text: "Nous: Send the proposal?\nRecommendation: send\n\nDecision nous_decision:abc123def456",
      markup: { inline_keyboard: [[{ text: "Approve", callback_data: "nd:abc123def456:a" }, { text: "Decline", callback_data: "nd:abc123def456:d" }]] } });
    await f.telegram.poll();
    expect(f.answer.mock.calls.map((call) => [call[1], call[2], call[3]])).toEqual([
      ["nous_decision:abc123def456", { answer: "APPROVE" }, { via: "TELEGRAM" }],
      ["nous_decision:zzz999done", { answer: "DECLINE" }, { via: "TELEGRAM" }],
      ["nous_decision:abc123gone", { answer: "APPROVE" }, { via: "TELEGRAM" }]
    ]);
    expect(f.acknowledged).toEqual([{ id: "q20", text: "Approved: Sent to Andy." }, { id: "q21", text: "Already answered." }, { id: "q22", text: "This decision no longer exists." }]);
    expect(f.offsets).toEqual([25]);
  });

  it("reads a reply to a card as the answer in words (a bare yes runs the action through the dock's rule), and never a reply to anything else", async () => {
    const card = "Nous: Send the proposal?\n\nDecision nous_decision:abc123def456";
    const f = fixture({ updates: [[message(30, "ναι", "123", card), message(31, "όχι", "123", card), message(32, "ναι, αλλά αύριο", "123", card), message(33, "ναι", "123", "Just a chat line")]] });
    await f.telegram.poll();
    expect(f.answer.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["nous_decision:abc123def456", { answer: "ANSWER", text: "ναι" }], ["nous_decision:abc123def456", { answer: "ANSWER", text: "όχι" }], ["nous_decision:abc123def456", { answer: "ANSWER", text: "ναι, αλλά αύριο" }]
    ]);
    expect(f.sent.map((item) => item.text)).toEqual(["Approved: Sent to Andy.", "Declined.", "Noted: Nous reads your words now."]);
    expect(f.send.mock.calls.map((call) => call[1])).toEqual(["ναι"]);
  });

  it("polls nothing without an owner, while a pairing is pending or when the integration is off, and backs off after an error", async () => {
    for (const f of [fixture({ owners: [null, null] }), fixture({ pending: true }), fixture({ record: { isEnabled: false } }), fixture({ record: { chatId: null, connectionStatus: "DISCONNECTED" } })]) {
      await f.telegram.poll();
      expect(f.client.getUpdates).not.toHaveBeenCalled();
      expect(await f.telegram.decisionCard(owner, decision("nous_decision:abc123def456", "OPEN", null), "card")).toBe(false);
    }
    const failing = fixture({ failPoll: new Error("boom") });
    await failing.telegram.poll();
    expect(failing.client.getUpdates).toHaveBeenCalledTimes(1);
    // Another owner's answer never reaches the paired chat.
    const other = fixture();
    expect(await other.telegram.answer("user:someone", "hi")).toBe(false);
    expect(other.sent).toEqual([]);
  });
});
