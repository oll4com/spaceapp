import { readFile } from "node:fs/promises";
import { NEEDS_YOU_CHECKED_HEADER, needsYouCardTexts, type NeedsYouTranslation, type SpaceNotification, type UiLanguage } from "@space/contracts";
import { gatewayRequestIdHeader } from "../gateway-request-id.js";
import { codexServiceRoot, GATEWAY_CLAUDE_MODEL } from "../room-agent-model-resolver.js";

/**
 * Translates strings into the operator's language, same order; null when no translator is set up; throws (no card text) when the answer is unusable.
 * `traceId` (the card's id) goes to Space Gateway as x-request-id, so its request log rows name the card (OBS-006).
 */
export type CardTranslate = (texts: string[], language: UiLanguage, traceId?: string) => Promise<string[] | null>;

const NAMES: Record<UiLanguage, string> = { en: "English", el: "Greek" };
/**
 * Operator 1/11 23:09 BKK «needs you να ειναι στην γλώσσα που εχω ορισει … και επεξηγηματικα»: agents, copilots and Space write cards in English,
 * so a card's text is translated once when it is raised, on the cheapest Codex model through Space Gateway (the API's own key; ~3 s), else Claude.
 */
export function createCardTranslator(options: { baseUrl: string | null; keyFile: string | null; model?: string; fetchImpl?: typeof fetch }): CardTranslate {
  const request = options.fetchImpl ?? fetch;
  return async (texts, language, traceId) => {
    const key = options.keyFile ? (await readFile(options.keyFile, "utf8").catch(() => "")).trim() : "";
    if (!options.baseUrl || !key) return null;
    // Keyed by place, empty strings left out: given an array, the model dropped the empty "Checked first" string about 1 call in 10 (1/11), and the whole card stayed English.
    const ask = async (asked: Record<string, string>): Promise<Record<string, unknown>> => {
      const root = codexServiceRoot(options.baseUrl!);
      const headers = { authorization: `Bearer ${key}`, "content-type": "application/json", ...gatewayRequestIdHeader(traceId) };
      const system = `Translate each value of the user's JSON object into ${NAMES[language]} for the operator of SpaceApp, addressing them informally. `
        + "Keep ids (pane:…, qm:207, mailrev:…, clipboard:…), URLs, e-mail addresses, file paths, commands, code, numbers, hashes, product and people's names, "
        + "and a mail's subject or a list's name in quotes exactly as they are. Translate labels such as \"Template:\" or \"Sender:\". "
        + "Keep line breaks, bullets and numbering. Answer with only a JSON object with the same keys.";
      const codex = await request(`${root}/v1/chat/completions`, {
        method: "POST", signal: AbortSignal.timeout(30_000), headers,
        body: JSON.stringify({ model: options.model ?? "gpt-5.6-luna", store: false, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(asked) }] })
      }).catch(() => null);
      let content: unknown;
      if (codex?.ok) content = ((await codex.json()) as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
      else {
        // Claude's subscription route next (never the API-key route; the pace cap applies): with every Codex week spent (5-11/11) every card stayed English.
        const claude = await request(`${root}/v1/messages`, {
          method: "POST", signal: AbortSignal.timeout(30_000), headers: { ...headers, "anthropic-version": "2023-06-01" },
          // max_tokens is required by the Messages API; a card's texts are far below it.
          body: JSON.stringify({ model: GATEWAY_CLAUDE_MODEL, max_tokens: 16_384, system, messages: [{ role: "user", content: JSON.stringify(asked) }] })
        }).catch(() => null);
        if (!claude?.ok) throw new Error(`The card translator answered HTTP ${codex?.status ?? "unreachable"} (Codex) and ${claude?.status ?? "unreachable"} (Claude).`);
        content = ((await claude.json()) as { content?: Array<{ type?: string; text?: string }> }).content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
      }
      const text = typeof content === "string" ? content.replace(/^```(?:json)?\s*|\s*```$/g, "") : "";
      // A reply with words around its object is still that object.
      for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
        try {
          const parsed: unknown = JSON.parse(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
        } catch { /* the next candidate */ }
      }
      throw new Error(`The card translator's answer was not a JSON object (${text.length} characters).`);
    };
    const asked = Object.fromEntries(texts.flatMap((text, index) => text.trim() ? [[String(index), text]] : []));
    const answer = await ask(asked);
    // A number or yes/no kept as written is its text; a key the model left out is asked once more alone, so one value never throws the card away.
    const value = (key: string) => typeof answer[key] === "string" ? answer[key] : typeof answer[key] === "number" || typeof answer[key] === "boolean" ? String(answer[key]) : null;
    const missing = Object.keys(asked).filter((key) => value(key) === null);
    if (missing.length) Object.assign(answer, await ask(Object.fromEntries(missing.map((key) => [key, asked[key]!]))));
    const still = missing.filter((key) => value(key) === null);
    if (still.length) throw new Error(`The card translator left out texts ${still.join(", ")} of ${Object.keys(asked).length}, twice.`);
    return texts.map((text, index) => text.trim() ? value(String(index))! : text);
  };
}

/**
 * The translator's version, kept on each translation. 2 (1/11): texts keyed by place, labels translated, subjects and list names kept; stable's
 * 19:47 UTC translation of campaign card ab76acad (version 1) left its labels English and read 40 % Greek. Raise it when the prompt or protocol changes.
 */
export const CARD_TRANSLATOR_VERSION = 2;

/** Nothing to translate into Greek when no string has a Latin word (Nous writes Greek already). */
const needsTranslation = (texts: string[], language: UiLanguage) => language !== "en" && texts.some((text) => /[A-Za-z]{3,}/.test(text));

/** A card's translation into `language`, null when it needs none or the model failed. */
export async function translateCard(translate: CardTranslate, record: Pick<SpaceNotification, "title" | "body" | "payload"> & { id?: string }, language: UiLanguage): Promise<NeedsYouTranslation | null> {
  const { texts, from } = needsYouCardTexts(record);
  if (!needsTranslation(texts, language)) return null;
  const out = await translate(texts, language, record.id);
  if (!out) return null;
  const [title, main, checked, question, ...options] = out as [string, string, string, string, ...string[]];
  return { language, from, title, body: checked.trim() ? `${main}${NEEDS_YOU_CHECKED_HEADER}${checked}` : main, question, options, version: CARD_TRANSLATOR_VERSION };
}
