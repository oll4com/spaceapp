import { SpaceConflictError, SpaceNotFoundError, TelegramApiError, TelegramBotApiClient, type TelegramPersistence, type TelegramUpdate } from "@space/runtime";
import type { NousDecision } from "@space/contracts";
import type { NousService } from "./service.js";

/**
 * Telegram two-way for Nous (operator request 2026-10-24): the operator writes to Nous from the paired chat and gets the answer
 * there, and answers Nous's decisions with Approve/Decline buttons under the decision's card (or a reply in words to the card).
 * Long polling with getUpdates, never a webhook (ADR-007 rejected the public callback); one poller process-wide (the `nous` job,
 * stable only), sharing the connected chat's stored offset; it pauses while a pairing is pending, so the two never read at once.
 * Only the paired chat is the operator: every other chat is ignored without a trace. The dock's gates stay: a button press is a
 * person's answer with no "always"; RELEASE and DESTRUCTIVE decisions and the Away grants work exactly as in the dock.
 */
export const NOUS_TELEGRAM_IDLE_MS = 10_000;
export const NOUS_TELEGRAM_POLL_SECONDS = 20;
export const NOUS_TELEGRAM_BACKOFF_MS = 5_000;
export const NOUS_TELEGRAM_BACKOFF_MAX_MS = 60_000;
/** Technical: Telegram's 4,096-character message; a longer answer goes as several messages. */
export const NOUS_TELEGRAM_CHUNK = 3_900;
/** Whole text in Telegram-sized parts (a message holds 4,096 characters). */
const sendWhole = async (client: NousTelegramClient, chatId: string, text: string) => {
  for (let at = 0; at < text.length; at += NOUS_TELEGRAM_CHUNK) await client.sendMessage(chatId, text.slice(at, at + NOUS_TELEGRAM_CHUNK));
};
const DECISION_TAIL = /Decision (nous_decision:[A-Za-z0-9_-]{6,80})\s*$/;
/** A button's data stays under Telegram's 64 bytes: the decision id without its prefix and one letter. */
const BUTTON = /^nd:([A-Za-z0-9_-]{6,80}):(a|d)$/;

export type NousTelegramClient = Pick<TelegramBotApiClient, "getUpdates" | "sendMessage" | "answerCallbackQuery">;

export interface NousTelegramDeps {
  persistence: Pick<TelegramPersistence, "getIntegration" | "getPendingPairing" | "updateIntegrationOffset">;
  secrets: { read(version: string): Promise<string> };
  /** The owner whose Nous takes Telegram (its setting on): one per paired chat, null when none or more than one. */
  owner(): Promise<string | null>;
  service: Pick<NousService, "send" | "answer">;
  clientFactory?(botToken: string): NousTelegramClient;
  log?: { warn(details: Record<string, unknown>, message: string): void; info?(details: Record<string, unknown>, message: string): void };
  now?: () => number;
}

export function createNousTelegram(deps: NousTelegramDeps) {
  const now = deps.now ?? Date.now;
  const clientFactory = deps.clientFactory ?? ((token: string) => new TelegramBotApiClient(token, { timeoutMs: (NOUS_TELEGRAM_POLL_SECONDS + 5) * 1_000 }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let backoffMs = 0;
  let running: Promise<void> | null = null;

  /** The connected chat, its bot client and the owner, or null when inbound is not possible now. */
  async function connection(): Promise<{ owner: string; chatId: string; offset: number; client: NousTelegramClient } | null> {
    const owner = await deps.owner();
    if (!owner) return null;
    const integration = await deps.persistence.getIntegration();
    if (!integration.isEnabled || integration.connectionStatus !== "CONNECTED" || !integration.chatId || !integration.secretVersion) return null;
    if (await deps.persistence.getPendingPairing()) return null;
    return { owner, chatId: integration.chatId, offset: integration.pollingOffset, client: clientFactory(await deps.secrets.read(integration.secretVersion)) };
  }

  async function handle(owner: string, chatId: string, client: NousTelegramClient, update: TelegramUpdate): Promise<void> {
    const query = update.callbackQuery;
    if (query) {
      const button = query.data ? BUTTON.exec(query.data) : null;
      if (!button || query.chatId !== chatId) return;
      const id = `nous_decision:${button[1]}`;
      let notice: string;
      try {
        const answered = await deps.service.answer(owner, id, { answer: button[2] === "a" ? "APPROVE" : "DECLINE" }, { via: "TELEGRAM" });
        // Technical: a callback notice holds 200 characters (Bot API answerCallbackQuery); the outcome is whole in the dock.
        notice = answered.status === "APPROVED" ? `Approved${answered.outcome ? `: ${answered.outcome.slice(0, 150)}` : "."}` : "Declined.";
      } catch (error) {
        notice = error instanceof SpaceConflictError ? "Already answered." : error instanceof SpaceNotFoundError ? "This decision no longer exists." : "That did not work; answer it in the Nous dock.";
      }
      await client.answerCallbackQuery(query.id, notice).catch(() => undefined);
      return;
    }
    const message = update.message;
    if (!message?.text || message.chat.id !== chatId || message.text.startsWith("/start")) return;
    const text = message.text.trim();
    if (!text) return;
    const replied = message.replyToText ? DECISION_TAIL.exec(message.replyToText) : null;
    if (replied) {
      // Technical: a decision's answer holds 2,000 characters (nousDecisionSchema.answer); longer words reach Nous whole as the
      // operator's message naming the decision, never cut (plan xCBrZwhCTzmC step 4).
      if (text.length > 2_000) {
        await deps.service.send(owner, `Answer to decision ${replied[1]} (longer than a decision answer holds, so here whole):\n${text}`, { person: true, via: "TELEGRAM" });
        await sendWhole(client, chatId, "Too long for the card's answer, so it went to Nous whole: Nous reads your words now.");
        return;
      }
      try {
        const answered = await deps.service.answer(owner, replied[1]!, { answer: "ANSWER", text }, { via: "TELEGRAM" });
        await sendWhole(client, chatId, answered.status === "APPROVED" ? `Approved${answered.outcome ? `: ${answered.outcome}` : "."}` : answered.status === "DECLINED" ? "Declined." : "Noted: Nous reads your words now.");
      } catch (error) {
        await client.sendMessage(chatId, error instanceof SpaceConflictError ? "That decision was already answered." : error instanceof SpaceNotFoundError ? "That decision no longer exists." : "That did not work; answer it in the Nous dock.").catch(() => undefined);
      }
      return;
    }
    const sent = await deps.service.send(owner, text, { person: true, via: "TELEGRAM" });
    // /goal and /goals (2026-10-27) are answered by Space itself: the answer rides on the stored message.
    if (typeof sent.meta.reply === "string") await sendWhole(client, chatId, sent.meta.reply).catch(() => undefined);
  }

  async function cycle(): Promise<void> {
    let delay = NOUS_TELEGRAM_IDLE_MS;
    try {
      const live = await connection();
      if (live) {
        const updates = [...await live.client.getUpdates(live.offset, { allowed: ["message", "callback_query"], timeoutSeconds: NOUS_TELEGRAM_POLL_SECONDS })].sort((a, b) => a.updateId - b.updateId);
        let next = live.offset;
        for (const update of updates) {
          if (update.updateId < live.offset) continue;
          next = Math.max(next, update.updateId + 1);
          await handle(live.owner, live.chatId, live.client, update).catch((error) => deps.log?.warn({ err: error, updateId: update.updateId }, "Nous Telegram update failed."));
        }
        if (next !== live.offset) await deps.persistence.updateIntegrationOffset(next, new Date(now()).toISOString());
        backoffMs = 0;
        delay = 0;
      }
    } catch (error) {
      const retryAfter = error instanceof TelegramApiError && error.retryAfterSeconds ? error.retryAfterSeconds * 1_000 : 0;
      backoffMs = Math.min(NOUS_TELEGRAM_BACKOFF_MAX_MS, Math.max(NOUS_TELEGRAM_BACKOFF_MS, backoffMs * 2, retryAfter));
      delay = backoffMs;
      deps.log?.warn({ err: error, delayMs: delay }, "Nous Telegram poll failed.");
    }
    if (!stopped) schedule(delay);
  }

  function schedule(delayMs: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; running = cycle().finally(() => { running = null; }); }, delayMs);
    timer.unref?.();
  }

  async function chat(): Promise<{ chatId: string; client: NousTelegramClient } | null> {
    const live = await connection().catch(() => null);
    return live ? { chatId: live.chatId, client: live.client } : null;
  }

  return {
    start(): void { if (!stopped) return; stopped = false; schedule(0); },
    stop(): void { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
    /** For tests: one poll now. */
    async poll(): Promise<void> { await (running ?? cycle()); },

    /** Nous's answer to a message that came from the chat, in Telegram-sized parts. */
    async answer(owner: string, text: string): Promise<boolean> {
      const live = await chat();
      if (!live || (await deps.owner()) !== owner) return false;
      const body = text.trim() || "Done.";
      await sendWhole(live.client, live.chatId, body);
      return true;
    },

    /** A decision's card with its Approve and Decline buttons; false hands the text to the outbox. */
    async decisionCard(owner: string, decision: NousDecision, text: string): Promise<boolean> {
      const live = await chat();
      if (!live || (await deps.owner()) !== owner) return false;
      const tail = `\n\nDecision ${decision.id}`;
      const id = decision.id.replace(/^nous_decision:/, "");
      // A long card goes whole: its earlier parts first, the last one (under Telegram's 4,096) with the id and the buttons.
      const room = NOUS_TELEGRAM_CHUNK - tail.length;
      const split = Math.max(0, text.length - room);
      if (split) await sendWhole(live.client, live.chatId, text.slice(0, split));
      await live.client.sendMessage(live.chatId, `${text.slice(split)}${tail}`,
        { replyMarkup: { inline_keyboard: [[{ text: "Approve", callback_data: `nd:${id}:a` }, { text: "Decline", callback_data: `nd:${id}:d` }]] } });
      return true;
    }
  };
}

export type NousTelegram = ReturnType<typeof createNousTelegram>;
