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
export const NOUS_TELEGRAM_CHUNK = 3_900;
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
      try {
        const answered = await deps.service.answer(owner, replied[1]!, { answer: "ANSWER", text: text.slice(0, 2_000) }, { via: "TELEGRAM" });
        await client.sendMessage(chatId, answered.status === "APPROVED" ? `Approved${answered.outcome ? `: ${answered.outcome.slice(0, 500)}` : "."}` : answered.status === "DECLINED" ? "Declined." : "Noted: Nous reads your words now.");
      } catch (error) {
        await client.sendMessage(chatId, error instanceof SpaceConflictError ? "That decision was already answered." : error instanceof SpaceNotFoundError ? "That decision no longer exists." : "That did not work; answer it in the Nous dock.").catch(() => undefined);
      }
      return;
    }
    await deps.service.send(owner, text, { person: true, via: "TELEGRAM" });
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
      for (let at = 0; at < body.length; at += NOUS_TELEGRAM_CHUNK) await live.client.sendMessage(live.chatId, body.slice(at, at + NOUS_TELEGRAM_CHUNK));
      return true;
    },

    /** A decision's card with its Approve and Decline buttons; false hands the text to the outbox. */
    async decisionCard(owner: string, decision: NousDecision, text: string): Promise<boolean> {
      const live = await chat();
      if (!live || (await deps.owner()) !== owner) return false;
      const tail = `\n\nDecision ${decision.id}`;
      const id = decision.id.replace(/^nous_decision:/, "");
      await live.client.sendMessage(live.chatId, `${text.slice(0, NOUS_TELEGRAM_CHUNK - tail.length)}${tail}`,
        { replyMarkup: { inline_keyboard: [[{ text: "Approve", callback_data: `nd:${id}:a` }, { text: "Decline", callback_data: `nd:${id}:d` }]] } });
      return true;
    }
  };
}

export type NousTelegram = ReturnType<typeof createNousTelegram>;
