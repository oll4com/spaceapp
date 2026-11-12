/**
 * Relevance retrieval for what Nous reads (operator 31/10 16:25 BKK «Σταμάτα να βάζεις αυθαίρετα όρια», Space Memory 1d753e68): instead of
 * "the newest N", every entry whose words match the turn's text, best first. Words are accent-folded (the operator often types without
 * accents), weighted by how rare they are among the entries, and a long entry counts its words less. An entry stays when it scores at
 * least RELATIVE_FLOOR of the best one (inclusive on purpose: the operator wants nothing relevant left out): a relevance threshold, not a count.
 */
import { NOUS_PROMPT_MAX_CHARS, type NousMessage } from "@space/contracts";

const STOP = new Set(("the and for with that this from not are was were his him her you your have has had its but all any can will what when then than into "
  + "out who how why each one two only also more most very just been being does did done said says say instead never always before after their them they there "
  + "here which while where would should could same again every once now today told tell "
  + "και για στο στη στην στον στα στις στους απο απ με να το τα τη την της του των τον τις οι ο η ενα μια μου σου μας σας τους δεν μην θα που πως "
  + "οτι αλλα ουτε ειναι εχω εχεις εχει εγω εσυ αυτο αυτα αυτη αυτες αυτοι ολα ολες ολοι κανεις κανω κανε πολυ πιο ακομα ηδη τωρα μετα πριν οταν γιατι αν "
  + "εδω εκει ποτε παντα θελω εγινε").split(/\s+/));
const RELATIVE_FLOOR = 0.3;

export const foldWords = (text: string): string[] =>
  (text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !STOP.has(word));

/** The docs whose words `query` shares, best first (ties: input order, so pass them newest first). No match, nothing. */
export function rankByWords<T>(docs: readonly T[], textOf: (doc: T) => string, query: string): Array<{ doc: T; score: number }> {
  return rankIndexed(() => indexWords(docs, textOf), query);
}

export type WordIndex<T> = Array<{ doc: T; set: Set<string>; size: number }>;
/** The docs' folded words, for a caller that ranks the same docs many times (rankIndexed). */
export const indexWords = <T>(docs: readonly T[], textOf: (doc: T) => string): WordIndex<T> =>
  docs.map((doc) => ({ doc, ...foldedOf(textOf(doc)) }));

/**
 * A text's folded words, kept by the text (CPU report 12/11): every call folded every doc again, ~350 ms of main thread for the first recall
 * after a memory save on stable's 3,900 entries and ~300 ms for each space_notes call. Technical bound (heap): once the texts kept since the
 * last turnover pass FOLDED_CHARS the older generation goes, and a text only it held is folded again when next used; results never change.
 */
const FOLDED_CHARS = 32 * 1024 * 1024;
type Folded = { set: Set<string>; size: number };
let folded = new Map<string, Folded>();
let olderFolded = new Map<string, Folded>();
let foldedChars = 0;
function foldedOf(text: string): Folded {
  const kept = folded.get(text);
  if (kept) return kept;
  const own = ownCopy(text);
  const older = olderFolded.get(text);
  // Moved, not copied, into the current generation: a text in use is never kept twice.
  if (older) olderFolded.delete(text);
  const words = older ?? (() => { const list = foldWords(own); return { set: new Set(list), size: list.length }; })();
  folded.set(own, words);
  foldedChars += own.length;
  if (foldedChars > FOLDED_CHARS) { olderFolded = folded; folded = new Map(); foldedChars = 0; }
  return words;
}

/** A string that keeps no parent alive: a V8 slice of a file or transcript would keep all of it for as long as a cache keeps the slice. */
export const ownCopy = (text: string): string => ` ${text}`.slice(1);

/** Runs `each` over the items 10 ms of main thread at a time (setImmediate between slices), for a startup build. */
export async function inSlices<T>(items: Iterable<T>, each: (item: T) => unknown): Promise<void> {
  let since = performance.now();
  for (const item of items) {
    each(item);
    if (performance.now() - since > 10) { await new Promise((resolve) => setImmediate(resolve)); since = performance.now(); }
  }
}
/** Folds the texts not kept yet in slices, so a later rank over them finds them kept (the first recall held the main thread 946 ms). */
export const warmFolds = (texts: Iterable<string>) => inSlices(texts, foldedOf);

/** rankByWords over an index built once (`index` is called only when the query has words). */
export function rankIndexed<T>(index: WordIndex<T> | (() => WordIndex<T>), query: string): Array<{ doc: T; score: number }> {
  const terms = new Set(foldWords(query));
  if (!terms.size) return [];
  const indexed = typeof index === "function" ? index() : index;
  if (!indexed.length) return [];
  const df = new Map<string, number>();
  for (const entry of indexed) for (const word of entry.set) if (terms.has(word)) df.set(word, (df.get(word) ?? 0) + 1);
  // A word most entries carry weighs little (inverse document frequency), so a rare shared word decides.
  const scored = indexed.map((entry) => ({
    doc: entry.doc,
    score: [...terms].filter((word) => entry.set.has(word))
      .reduce((sum, word) => sum + Math.log((indexed.length + 1) / df.get(word)!), 0) * Math.min(1, Math.sqrt(120 / Math.max(1, entry.size)))
  })).filter((item) => item.score > 0);
  const best = Math.max(0, ...scored.map((item) => item.score));
  return scored.filter((item) => item.score >= best * RELATIVE_FLOOR).sort((left, right) => right.score - left.score);
}

/**
 * Technical bound (model context): one retrieved section stays well inside the turn's prompt budget beside the world and the dialogue.
 * Past it the remaining entries are named, never dropped silently. 40,000 until 1/11: four such sections (facts, notes, memory, lessons) and
 * their name lists pushed an operator turn past the worker's NOUS_PROMPT_MAX_CHARS (05:45-07:33 UTC, every operator turn "Invalid prompt.").
 */
export const NOUS_RETRIEVED_SECTION_CHARS = 20_000;
/**
 * Technical bound (model context): the names of the entries past a section's budget. 1/11: 610 Space Memory matches named one by one made
 * a 77,000-character line. Past it the line gives the count left and how to read them.
 */
export const NOUS_RETRIEVED_NAMES_CHARS = 2_000;

/** "a; b; c" within NOUS_RETRIEVED_NAMES_CHARS, then "and N more". */
export function nameList(names: readonly string[], max = NOUS_RETRIEVED_NAMES_CHARS): string {
  const shown: string[] = [];
  let used = 0;
  for (const name of names) {
    if (shown.length && used + name.length + 2 > max) break;
    shown.push(name);
    used += name.length + 2;
  }
  const more = names.length - shown.length;
  return `${shown.join("; ")}${more ? `; and ${more} more` : ""}`;
}

export function fitWhole(items: ReadonlyArray<{ whole: string; name: string }>, readHow: string, max = NOUS_RETRIEVED_SECTION_CHARS): string[] {
  const out: string[] = [];
  let used = 0;
  let index = 0;
  for (; index < items.length && used + items[index]!.whole.length <= max; index += 1) { out.push(items[index]!.whole); used += items[index]!.whole.length + 1; }
  const rest = items.slice(index);
  // The first entry always goes whole, however long: a match is never only a name.
  if (!out.length && rest.length) { out.push(rest[0]!.whole); rest.shift(); }
  return rest.length ? [...out, `- ${rest.length} more match${rest.length === 1 ? "" : "es"} (${readHow}): ${nameList(rest.map((item) => item.name))}`] : out;
}

/**
 * Technical bound (model context and the worker's request): a turn's prompt. The worker's own NOUS_PROMPT_MAX_CHARS (operator 1/11 14:53 BKK:
 * 200,000 here against the worker's 150,000 made the line-boundary pass cut sections that could have left whole and named), so the request
 * body (640 KiB; Greek takes two bytes a character) and the model's context beside the system text and the tools keep their room.
 */
export const NOUS_PROMPT_BUDGET_CHARS = NOUS_PROMPT_MAX_CHARS;

/**
 * One part of a turn's prompt or world: its text, how much the turn needs it (higher stays longer; null: never left out) and the tool that
 * reads it whole when it is left out.
 */
export interface PromptPart { name: string; text: string; rank: number | null; readWith?: string;
  /** A list of entries ("- " lines or "### " blocks) a turn that does not answer the operator gets only the relevant ones of (relevantParts). */
  entries?: boolean }

/**
 * The parts a turn that does not answer the operator needs (token study 1/11: INBOX and STANDING turns carried the whole world, 276,000
 * characters on average, every turn). The entries of the list parts (`entries`: goals, notifications, plans, plan activity, tasks) are
 * ranked together by the turn's words (rankByWords: rare shared words, every entry at least 0.3 of the best): a list keeps its heading and
 * its relevant entries and counts the others with the tool that reads them; a list with none gets rank -1 (fitPrompt leaves it out whole
 * and names it). Other parts are already chosen by the turn's words (notes, facts, lessons) or are the state itself (rooms): they stay.
 * No words to go by: every part stays whole.
 */
export function relevantParts(parts: readonly PromptPart[], query: string): PromptPart[] {
  const lists = parts.filter((part) => part.entries && part.rank !== null && part.text.trim());
  if (!foldWords(query).length || !lists.length) return [...parts];
  const split = new Map(lists.map((part) => {
    const chunks = part.text.split(/\n(?=- |### )/);
    const head = /^(- |### )/.test(chunks[0] ?? "") ? "" : chunks.shift()!;
    return [part, { head, items: chunks }] as const;
  }));
  const relevant = new Set(rankByWords([...split.values()].flatMap(({ items }) => items), (item) => item, query).map(({ doc }) => doc));
  return parts.map((part) => {
    const unit = split.get(part);
    if (!unit) return part;
    const kept = unit.items.filter((item) => relevant.has(item));
    if (!kept.length) return { ...part, rank: -1 };
    if (kept.length === unit.items.length) return part;
    const rest = unit.items.length - kept.length;
    return { ...part, text: [unit.head, ...kept, `- ${rest} other entr${rest === 1 ? "y" : "ies"} not about this turn: ${part.readWith ?? `space_world {"section": "${part.name}"}`}`].filter(Boolean).join("\n") };
  });
}

/**
 * The text without the paragraphs an earlier message already said (operator 9/11 12:56 BKK, «μην μου επαναλαμβάνεις»): a paragraph of 6+ words
 * whose words are at least 80% in one earlier message goes; a code block (a draft to copy) always stays. Measured on 4 days of stable answers.
 */
export function withoutSaid(text: string, earlier: readonly string[]): string {
  const said = earlier.map((message) => new Set(foldWords(message)));
  return text.split(/\n\s*\n/).filter((block) => {
    const words = new Set(foldWords(block));
    if (!block.trim() || block.includes("```") || words.size < 6) return Boolean(block.trim());
    return !said.some((set) => [...words].filter((word) => set.has(word)).length >= 0.8 * words.size);
  }).join("\n\n").trim();
}

/** The ids a text names: records (nous_msg:, pane:, clipboard:, notification:, task:, nous_goal:, …) and merge-queue tickets. */
export const references = (text: string): string[] => text.match(/\b[a-z_]+:[A-Za-z0-9_-]{8,}|\bq-\d{8}-\d{6}-[a-z0-9]{2,12}/g) ?? [];

/** The conversation, one line a message (the prompt's "Conversation so far" and space_conversation). */
export function historyLines(messages: readonly NousMessage[]): Array<{ id: string; at: string; text: string }> {
  return messages.flatMap((message) => {
    if (message.status === "RUNNING") return [];
    const text = message.kind === "OPERATOR" ? `Operator: ${message.content}`
      : message.kind === "INBOX" ? `${message.meta?.standing ? "Standing orders (from Space, not the operator)" : "Inbox (room monitor and notifications, not the operator)"}:\n${message.content}`
        : message.kind === "DECISION" ? message.content
          : message.kind === "ANSWER" && message.content.trim() ? `Nous: ${message.content}` : "";
    return text ? [{ id: message.id, at: message.createdAt, text }] : [];
  });
}

/**
 * The conversation for a turn that does not answer the operator: the message it works on, then every other message whose words match the
 * turn's text (rankByWords over the others, so the message itself does not set the bar), within NOUS_RETRIEVED_SECTION_CHARS, in time order; the others are counted and read with space_conversation. 1/11: every
 * goal, inbox and standing turn carried the last 55,000 characters of the dialogue, mostly inbox lines earlier turns had handled.
 */
export function relevantHistory(messages: readonly NousMessage[], query: string, current?: string): string {
  const lines = historyLines(messages);
  const first = lines.find((line) => line.id === current);
  // Round 2 (1/11): an earlier inbox line shares words with everything (room names, "reported", "finished"), so every turn carried 10-15
  // inbox messages it had handled; it is about this turn only when it names the same thing (a request, pane, plan, notification, ticket).
  const refs = new Set(references(query));
  const others = lines.filter((line) => line !== first);
  const inbox = (line: { text: string }) => /^(?:Inbox|Standing orders) \(/.test(line.text);
  const order = [...(first ? [first] : []), ...rankByWords(others.filter((line) => !inbox(line)), (line) => line.text, query).map(({ doc }) => doc),
    ...others.filter((line) => inbox(line) && references(line.text).some((ref) => refs.has(ref)))];
  const kept: typeof lines = [];
  let used = 0;
  for (const line of order) {
    if (kept.length && used + line.text.length > NOUS_RETRIEVED_SECTION_CHARS) continue;
    kept.push(line);
    used += line.text.length + 2;
  }
  const rest = lines.length - kept.length;
  const shown = lines.filter((line) => kept.includes(line)).map((line) => line.text);
  return [...(shown.length ? shown : ["(nothing in the dialogue is about this turn)"]),
    ...(rest ? [`- ${rest} other message${rest === 1 ? "" : "s"} of the dialogue (not about this turn, or past ${NOUS_RETRIEVED_SECTION_CHARS.toLocaleString("en-US")} characters): space_conversation {"q": …} reads them`] : [])].join("\n\n");
}

const leftLine = (part: PromptPart) => `- ${part.name} (${part.text.length} characters): ${part.readWith ?? `space_world {"section": "${part.name}"}`}`;

/**
 * The parts in their order within `budget`: when they do not fit, the lowest-ranked parts (the largest first within a rank) are left out
 * whole and named with the tool that reads each, never cut silently. Parts that never leave are kept whole up to `max` (the worker's bound);
 * only past it is the largest of them cut, and the cut is named. A turn never fails on its prompt's size.
 */
export function fitPrompt(parts: readonly PromptPart[], budget = NOUS_PROMPT_BUDGET_CHARS, max = NOUS_PROMPT_MAX_CHARS, named = budget): { text: string; left: PromptPart[] } {
  const present = parts.filter((part) => part.text.trim()).map((part) => ({ ...part }));
  const size = (part: PromptPart) => part.text.length + 2;
  const left: PromptPart[] = [];
  const note = () => left.length ? [`# Left out of this prompt (not about this turn, or past the prompt's budget of ${named.toLocaleString("en-US")} characters; read them with these tools when the turn needs them)`, ...left.map(leftLine)].join("\n") : "";
  let total = present.reduce((sum, part) => sum + size(part), 0);
  for (const part of present.filter((entry) => entry.rank !== null && entry.rank < 0)) { left.push(part); total -= size(part); }
  for (const part of present.filter((entry) => entry.rank !== null && entry.rank >= 0).sort((a, b) => a.rank! - b.rank! || b.text.length - a.text.length)) {
    if (total + note().length <= budget) break;
    left.push(part);
    total -= size(part);
  }
  const kept = present.filter((part) => !left.includes(part));
  for (let over = total + note().length - max; over > 0;) {
    const largest = kept.reduce((big, part) => part.text.length > big.text.length ? part : big);
    const marker = `\n… [cut here: ${over.toLocaleString("en-US")} more characters of ${largest.name} past the prompt's technical bound of ${max.toLocaleString("en-US")}]`;
    const keep = Math.max(0, largest.text.length - over - marker.length);
    total -= largest.text.length - keep - marker.length;
    largest.text = `${largest.text.slice(0, keep)}${marker}`;
    over = total + note().length - max;
    if (keep === 0) break;
  }
  return { text: [...kept.map((part) => part.text), note()].filter(Boolean).join("\n\n"), left };
}

/** One named section of the world whole (space_world {"section"}): every section whose name holds the words, else the names there are. */
export function promptSection(parts: readonly PromptPart[], name: string): string {
  const wanted = name.trim().toLowerCase();
  const found = parts.filter((part) => part.text.trim() && part.name.toLowerCase().includes(wanted));
  return found.length ? found.map((part) => part.text).join("\n\n")
    : `No section of the world is named "${name}". Its sections now: ${parts.filter((part) => part.text.trim()).map((part) => part.name).join("; ")}.`;
}
