import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { questionWordMatch } from "@space/db";
import { fitWhole, indexWords, rankByWords, rankIndexed, type WordIndex } from "./retrieval.js";

/**
 * The operator's facts and rules, pinned in Nous's world every turn (plan clipboard:bTm-5PGrt9po U2): the Space Memory entries
 * tagged operator-rule or operator-fact, newest first, one line each. On stable Nous relayed "we have no company" although the
 * operator's company was in memory (2026-10-20): a fact Nous must recall first is a fact it forgets.
 * Read from every monthly file with a light scan (since 31/10; was the newest two): the full memory reader parses them slowly (14 s cold).
 * The same scan recalls entries for the operator's message (2026-10-24): a lexical match over titles and bodies, no model.
 * Operator 31/10 16:25 BKK («Σταμάτα να βάζεις αυθαίρετα όρια»): no "newest 25"; the facts that match the turn's words come whole.
 */
const PINNED_TAG = /^operator-(?:rule|fact)s?$/i;

export interface OperatorFact { id: string; date: string; title: string; body: string }
export interface MemoryEntryLite { id: string; date: string; createdAt: string; title: string; body: string; tags: string[] }

/** The live entries of canonical memory text (archived and superseded ones left out, like the memory reader does), newest first. Callers never change them. */
export function memoryEntries(text: string): MemoryEntryLite[] {
  // The last text's entries: rules, facts and recall each parsed the whole memory (12 MB on stable 4/11, ~150 ms of main thread a call).
  if (entriesCache?.text !== text) entriesCache = { text, entries: parseMemoryEntries(text) };
  return entriesCache.entries;
}
let entriesCache: { text: string; entries: MemoryEntryLite[] } | null = null;
function parseMemoryEntries(text: string): MemoryEntryLite[] {
  const blocks = text.split(/^(?=<!-- space-memory:id=)/m).map((block) => ({
    block,
    id: /^<!-- space-memory:id=([A-Za-z0-9:_-]{3,200}) -->/.exec(block)?.[1] ?? null,
    heading: /^## (\d{4}-\d{2}-\d{2}) - (?:Space canonical memory: )?(.+)$/m.exec(block),
    createdAt: /\bcreated_at=(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(block)?.[1] ?? null,
    active: !/(?:lifecycle_status|status)=ARCHIVED\b/.test(block)
  })).filter((entry) => entry.id && entry.heading && entry.active);
  const superseded = new Set(blocks.flatMap((entry) => [...entry.block.matchAll(/\bsupersedes=([A-Za-z0-9:_-]{3,200})\b/g)].map((match) => match[1]!)));
  return blocks.filter((entry) => !superseded.has(entry.id!)).map((entry) => {
    const lines = entry.block.split("\n");
    const headingAt = lines.findIndex((line) => line.startsWith("## "));
    // The body: the entry's lines after its heading, without the metadata lines (source, created_at, tags) and the next entry's heading.
    const body = lines.slice(headingAt + 1).filter((line) => !/^\s*-\s*(?:Source:|created_at=|Tags:)/i.test(line) && !line.startsWith("<!-- "))
      .join("\n").split(/\n## /)[0]!.trim();
    return { id: entry.id!, date: entry.heading![1]!, createdAt: entry.createdAt ?? `${entry.heading![1]!}T00:00:00.000Z`, title: entry.heading![2]!.replace(/\s+/g, " ").trim().slice(0, 200), body,
      tags: [...entry.block.matchAll(/^\s*-\s*Tags:\s*(.+)$/gim)].flatMap((match) => match[1]!.split(",").map((tag) => tag.trim()).filter(Boolean)) };
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** R11-2 (6): the operator-rule entries (tag operator-rule), with their text, newest first. */
export function operatorRules(text: string): Array<{ id: string; title: string; body: string }> {
  return memoryEntries(text).filter((entry) => entry.tags.some((tag) => /^operator-rules?$/i.test(tag)))
    .map((entry) => ({ id: entry.id, title: entry.title, body: entry.body }));
}

/** The pinned entries of canonical memory text, newest first. */
export function operatorFacts(text: string): OperatorFact[] {
  return memoryEntries(text).filter((entry) => entry.tags.some((tag) => PINNED_TAG.test(tag)))
    .map((entry) => ({ id: entry.id, date: entry.date, title: entry.title, body: entry.body }));
}

/**
 * Every entry that matches the text by its words (titles count twice), best first, ties newest first; no count (operator 31/10:
 * no "top 3"). Lexical on purpose: the full reader is 14 s cold, a model call is slower.
 */
export function recallEntries(text: string, query: string): Array<{ id: string; title: string; body: string; createdAt: string }> {
  return rankIndexed(() => recallIndexOf(text), query).map(({ doc: entry }) => ({ id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt }));
}
// The last memory text's entries with their folded words: parsing and folding it each recall held the API's main thread 2.7 s (stable 4/11, 12 MB, 3,000 entries).
let recallIndex: { text: string; index: WordIndex<ReturnType<typeof memoryEntries>[number]> } | null = null;
function recallIndexOf(text: string) {
  if (recallIndex?.text !== text) recallIndex = { text, index: indexWords(memoryEntries(text), (entry) => `${entry.title} ${entry.title} ${entry.body}`) };
  return recallIndex.index;
}

/** The facts that match this turn's words, whole and best first, then how many there are in all and how to find the others. */
export function renderOperatorFacts(facts: OperatorFact[], query = ""): string {
  if (!facts.length) return "";
  const matched = rankByWords(facts, (fact) => `${fact.title} ${fact.title} ${fact.body}`, query).map(({ doc }) => doc);
  const short = (fact: OperatorFact) => fact.id.replace(/^space_memory:/, "").slice(0, 8);
  return ["## Operator facts and rules (Space Memory; the operator's own words: they win over a pane, a note or your reading)",
    ...fitWhole(matched.map((fact) => ({ whole: `- [${short(fact)}] ${fact.date} ${fact.title}\n  ${fact.body.replace(/\n+/g, "\n  ")}`, name: `[${short(fact)}] ${fact.title}` })),
      "space_memory_recall reads them"),
    `- ${facts.length} in all; ${matched.length ? "those above match this turn's words" : "none matches this turn's words"}. space_memory_recall finds any other by its words: look before you act on something the operator may have ruled on.`].join("\n");
}

/** Every monthly Space Memory file (the gemini_* names are compatibility symlinks and skipped); the light scan of all nine took 33 ms on 31/10. */
export async function readMemoryMonthlies(monthlyPath: string): Promise<string> {
  const directory = dirname(monthlyPath);
  const names = (await readdir(directory)).filter((name) => /^space_memory_\d{4}-\d{2}\.md$/.test(name));
  const all = [...new Set([...names, basename(monthlyPath)])].sort();
  const texts = await Promise.all(all.map((name) => readFile(join(directory, name), "utf8").catch(() => "")));
  return texts.join("\n");
}

/** The operator's pinned entry a copilot question shares words with; `rule` when the operator ruled it (tag operator-rule). */
export interface PinnedMemoryHit { id: string; title: string; body: string; rule: boolean }
let pinnedCache: { at: number; path: string; entries: Promise<MemoryEntryLite[]> } | null = null;
/**
 * Plan clipboard:7L5KyWp3kQsP step 3: the operator's pinned Space Memory entries holding at least two of a copilot question's own words and
 * half of them (a variant counts for its word), for the copilot's pre-ask recall. Shown, never a refusal: on 2/11 a Mail Copilot card rule
 * shared "identity" and "form" with a date-of-birth question. The monthly files (12 MB on 2/11) are scanned at most every 5 minutes.
 */
export async function pinnedMemoryFor(monthlyPath: string, question: string, at = Date.now()): Promise<PinnedMemoryHit[]> {
  if (!pinnedCache || pinnedCache.path !== monthlyPath || pinnedCache.at < at - 5 * 60_000) {
    pinnedCache = { at, path: monthlyPath, entries: readMemoryMonthlies(monthlyPath).then((text) => memoryEntries(text).filter((entry) => entry.tags.some((tag) => PINNED_TAG.test(tag)))) };
  }
  return (await pinnedCache.entries).filter((entry) => { const match = questionWordMatch(question, `${entry.title} ${entry.body}`); return match.matched >= 2 && match.share >= 0.5; })
    .map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, rule: entry.tags.some((tag) => /^operator-rules?$/i.test(tag)) }));
}

export async function readOperatorFacts(monthlyPath: string): Promise<OperatorFact[]> {
  return operatorFacts(await readMemoryMonthlies(monthlyPath));
}
