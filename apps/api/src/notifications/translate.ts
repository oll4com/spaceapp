import { readFile } from "node:fs/promises";
import { NEEDS_YOU_CHECKED_HEADER, NEEDS_YOU_FIXED_WORDS, needsYouCardTexts, type NeedsYouMailTranslation, type NeedsYouTranslation, type SpaceNotification, type UiLanguage } from "@space/contracts";
import { gatewayRequestIdHeader } from "../gateway-request-id.js";
import { codexServiceRoot } from "../room-agent-model-resolver.js";
import { createGatewayFallback, FREE_POOLS } from "../gateway-fallback.js";

/**
 * Translates strings into the operator's language, same order; null when no translator is set up; throws (no card text) when the answer is unusable.
 * `traceId` (the card's id) goes to Space Gateway as x-request-id, so its request log rows name the card (OBS-006).
 */
export type CardTranslate = (texts: string[], language: UiLanguage, traceId?: string) => Promise<string[] | null>;

const NAMES: Record<UiLanguage, string> = { en: "English", el: "Greek" };
/** Technical bound: the translations kept in memory (about 2 MB); a text dropped from them is only asked again. */
const CACHED = 5_000;

/**
 * Operator 1/11 23:09 BKK «needs you να ειναι στην γλώσσα που εχω ορισει … και επεξηγηματικα»: agents, copilots and Space write cards in English,
 * so a card's text is translated once when it is raised through Space Gateway (the API's own key): the free pools first, then the cheapest Codex
 * model, so translations leave the Codex week to the operator's panes (plan clipboard:nsWKwUFhUFWA slice 7). A text translated before (the same
 * title, an Approve/Decline pair, a step) comes from a least-recently-used memory and is not asked again.
 */
export function createCardTranslator(options: { baseUrl: string | null; keyFile: string | null; model?: string; fetchImpl?: typeof fetch }): CardTranslate {
  const askGateway = createGatewayFallback(options.fetchImpl);
  const cache = new Map<string, string>();
  const cacheKey = (language: UiLanguage, text: string) => `${language}\n${text}`;
  return async (texts, language, traceId) => {
    const key = options.keyFile ? (await readFile(options.keyFile, "utf8").catch(() => "")).trim() : "";
    if (!options.baseUrl || !key) return null;
    // Keyed, empty strings left out: given an array, the model dropped the empty "Checked first" string about 1 call in 10 (1/11), and the whole card stayed English.
    // The keys run without gaps (12/11 public-host reboot card: given 0,1,3,4,5 the model renumbered them, the question read «Έγκριση» and both buttons «Απόρριψη»).
    const ask = async (asked: Record<string, string>): Promise<Record<string, unknown>> => {
      const root = codexServiceRoot(options.baseUrl!);
      const headers = { authorization: `Bearer ${key}`, "content-type": "application/json", ...gatewayRequestIdHeader(traceId) };
      const system = `Translate each value of the user's JSON object into ${NAMES[language]} for the operator of SpaceApp, addressing them informally. `
        + "Keep ids (pane:…, qm:207, mailrev:…, clipboard:…), URLs, e-mail addresses, file paths, commands, code, numbers, hashes, product and people's names, "
        + "and a mail's subject or a list's name in quotes exactly as they are. Translate labels such as \"Template:\" or \"Sender:\". "
        + "Keep line breaks, bullets and numbering. Answer with only a JSON object with the same keys.";
      const { content } = await askGateway({ root, headers, pools: [...FREE_POOLS, { path: "/v1", model: options.model ?? "gpt-5.6-luna" }], timeoutMs: 30_000,
        body: { messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(asked) }] } });
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
    const known = (text: string) => {
      const hit = cache.get(cacheKey(language, text));
      if (hit !== undefined) { cache.delete(cacheKey(language, text)); cache.set(cacheKey(language, text), hit); }
      return hit;
    };
    const places = texts.flatMap((text, index) => text.trim() && known(text) === undefined ? [index] : []);
    if (!places.length) return texts.map((text) => text.trim() ? cache.get(cacheKey(language, text))! : text);
    const asked = Object.fromEntries(places.map((place, key) => [String(key), texts[place]!]));
    const answer = await ask(asked);
    // A number or yes/no kept as written is its text; a key the model left out is asked once more alone, so one value never throws the card away.
    const value = (key: string) => typeof answer[key] === "string" ? answer[key] : typeof answer[key] === "number" || typeof answer[key] === "boolean" ? String(answer[key]) : null;
    const missing = Object.keys(asked).filter((key) => value(key) === null);
    if (missing.length) Object.assign(answer, await ask(Object.fromEntries(missing.map((key) => [key, asked[key]!]))));
    const still = missing.filter((key) => value(key) === null);
    if (still.length) throw new Error(`The card translator left out texts ${still.join(", ")} of ${Object.keys(asked).length}, twice.`);
    for (const [index, place] of places.entries()) cache.set(cacheKey(language, texts[place]!), value(String(index))!);
    while (cache.size > CACHED) cache.delete(cache.keys().next().value!);
    return texts.map((text, index) => !text.trim() ? text : places.includes(index) ? value(String(places.indexOf(index)))! : cache.get(cacheKey(language, text))!);
  };
}

/**
 * The translator's version, kept on each translation. 2 (1/11): texts keyed by place, labels translated, subjects and list names kept; stable's
 * 19:47 UTC translation of campaign card ab76acad (version 1) left its labels English and read 40 % Greek. 3 (12/11): keys without gaps, so the cards
 * a renumbered answer shifted are made again. Raise it when the prompt or protocol changes.
 */
export const CARD_TRANSLATOR_VERSION = 3;

const ENGLISH_WORDS = new Set("the and to of a an in is are be you your for on with this that it we our i my me as at by from have has will can not or please if do".split(" "));
/**
 * Whether a text reads in a language other than English or Greek (operator 21/11 nous_msg:e9b4df3e: a French mail on a card stayed French): mostly
 * another script (Cyrillic, CJK, Thai…), or Latin words of which under 1 in 10 is a common English word (English prose runs about 1 in 3).
 * shortcut: a word list, not a language detector; upgrade to the model's own verdict if real cards are misjudged.
 */
export function foreignLanguage(text: string): boolean {
  const plain = text.replace(/https?:\/\/\S+|\S+@\S+|\b[a-z_]+:[\w-]{4,}/gi, " ");
  const letters = plain.match(/\p{L}/gu)?.length ?? 0;
  const latin = plain.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const greek = plain.match(/\p{Script=Greek}/gu)?.length ?? 0;
  if (letters - latin - greek > letters * 0.3) return true;
  if (latin <= greek) return false;
  const words = plain.toLowerCase().match(/\p{Script=Latin}+/gu) ?? [];
  return words.length >= 3 && words.filter((word) => ENGLISH_WORDS.has(word)).length < words.length * 0.1;
}

/** Into Greek, a card with any Latin word (Nous writes Greek already); into English, one with a text in a third language. */
const needsTranslation = (texts: string[], language: UiLanguage) => language === "en" ? texts.some(foreignLanguage) : texts.some((text) => /[A-Za-z]{3,}/.test(text));

/**
 * The mail a card names, translated when it reads in neither Greek nor English (the original kept beside it); null when no translator is set up.
 * Throws when the model fails, so the card stays as it is and its mail shows in its own language.
 */
export async function translateMail(translate: CardTranslate, mail: NeedsYouMailTranslation["original"], language: UiLanguage, traceId?: string): Promise<NeedsYouMailTranslation | null> {
  if (!foreignLanguage(`${mail.subject}\n${mail.text}`)) return { language, original: mail };
  const out = await translate([mail.subject, mail.text], language, traceId);
  return out ? { language, original: mail, subject: out[0]!, text: out[1]! } : null;
}

/** A card's translation into `language`, null when it needs none or the model failed. */
export async function translateCard(translate: CardTranslate, record: Pick<SpaceNotification, "title" | "body" | "payload"> & { id?: string }, language: UiLanguage): Promise<NeedsYouTranslation | null> {
  const { texts, from } = needsYouCardTexts(record);
  if (!needsTranslation(texts, language)) return null;
  const out = await translate(texts, language, record.id);
  if (!out) return null;
  const [title, main, checked, question, ...options] = out as [string, string, string, string, ...string[]];
  const fixed = (index: number, translated: string) => NEEDS_YOU_FIXED_WORDS[language]?.[texts[index]!] ?? translated;
  return { language, from, title, body: checked.trim() ? `${main}${NEEDS_YOU_CHECKED_HEADER}${checked}` : main, question: fixed(3, question),
    options: options.map((option, index) => fixed(4 + index, option)), version: CARD_TRANSLATOR_VERSION };
}
