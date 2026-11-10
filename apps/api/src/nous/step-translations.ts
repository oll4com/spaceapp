import type { NousMessage, UiLanguage } from "@space/contracts";
import type { CardTranslate } from "../notifications/translate.js";

/** Technical bounds: one model call's batch, and the texts kept in memory (about 2 MB). */
const BATCH = 40;
const KEPT = 20_000;
const RETRY_MS = 10 * 60_000;

/**
 * The Nous conversation's tool steps in the operator's agent language (operator 2/11 09:51 BKK: «6 steps Checked Cody in Alex: ok working»
 * read English). Space writes each step in English, so a page's steps are translated in the background on the card translator's cheap model,
 * the folded rows' last steps first; the next read carries them as `meta.translation {language, text}`, the dock shows them. Each owner has
 * one batch in flight; a failed batch waits 10 minutes.
 * shortcut: kept in the API's memory (asked again after a restart); store them on the rows if restarts make that costly.
 */
export function createStepTranslations(deps: { translate: CardTranslate; language(owner: string): Promise<UiLanguage>; warn(error: unknown): void; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const kept = new Map<string, string>();
  const busy = new Set<string>();
  const failedAt = new Map<string, number>();
  const keyOf = (language: UiLanguage, text: string) => `${language}\n${text}`;

  async function work(owner: string, language: UiLanguage, texts: string[], traceId?: string) {
    for (let index = 0; index < texts.length; index += BATCH) {
      const batch = texts.slice(index, index + BATCH).filter((text) => !kept.has(keyOf(language, text)));
      if (!batch.length) continue;
      const out = await deps.translate(batch, language, traceId);
      if (!out) return;
      batch.forEach((text, at) => kept.set(keyOf(language, text), out[at]!));
      while (kept.size > KEPT) kept.delete(kept.keys().next().value!);
    }
  }

  return async (owner: string, messages: NousMessage[], traceId?: string): Promise<NousMessage[]> => {
    const language = await deps.language(owner).catch(() => "en" as const);
    if (language === "en") return messages;
    const steps = messages.flatMap((message, index) => message.kind === "TOOL" && /[A-Za-z]{3,}/.test(message.content)
      ? [{ text: message.content, last: messages[index + 1]?.kind !== "TOOL" }] : []).reverse();
    // The folded line shows a run's last step: those first, newest first, then every other step newest first.
    const missing = new Set([...steps.filter((step) => step.last), ...steps].map((step) => step.text).filter((text) => !kept.has(keyOf(language, text))));
    const failed = failedAt.get(owner);
    if (missing.size && !busy.has(owner) && (failed === undefined || failed <= now() - RETRY_MS)) {
      busy.add(owner);
      void work(owner, language, [...missing], traceId).catch((error: unknown) => { failedAt.set(owner, now()); deps.warn(error); }).finally(() => busy.delete(owner));
    }
    return messages.map((message) => {
      const text = message.kind === "TOOL" ? kept.get(keyOf(language, message.content)) : undefined;
      return text ? { ...message, meta: { ...message.meta, translation: { language, text } } } : message;
    });
  };
}
