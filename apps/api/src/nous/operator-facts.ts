import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * The operator's facts and rules, pinned in Nous's world every turn (plan clipboard:bTm-5PGrt9po U2): the Space Memory entries
 * tagged operator-rule or operator-fact, newest first, one line each. On stable Nous relayed "we have no company" although the
 * operator's company was in memory (2026-10-20): a fact Nous must recall first is a fact it forgets.
 * Read from the newest two monthly files with a light scan: the full memory reader parses every file (14 s on its first call).
 * The same scan recalls entries for the operator's message (2026-10-24): a lexical match over titles and bodies, no model.
 */
export const NOUS_OPERATOR_FACTS_MAX = 25;
const PINNED_TAG = /^operator-(?:rule|fact)s?$/i;

export interface OperatorFact { id: string; date: string; title: string }
export interface MemoryEntryLite { id: string; date: string; createdAt: string; title: string; body: string; tags: string[] }

/** The live entries of canonical memory text (archived and superseded ones left out, like the memory reader does), newest first. */
export function memoryEntries(text: string): MemoryEntryLite[] {
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

/** The pinned entries of canonical memory text, newest first. */
export function operatorFacts(text: string): OperatorFact[] {
  return memoryEntries(text).filter((entry) => entry.tags.some((tag) => PINNED_TAG.test(tag))).slice(0, NOUS_OPERATOR_FACTS_MAX)
    .map((entry) => ({ id: entry.id, date: entry.date, title: entry.title }));
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "what", "από", "και", "για", "που", "την", "τον", "της", "του", "στο", "στη", "στην", "στον", "ένα", "μια", "τι", "πως", "πώς", "είναι", "έγινε", "θέλω", "θελω", "να", "με", "σε"]);
const words = (text: string) => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]{2,}/gu) ?? [])].filter((word) => !STOP_WORDS.has(word));

/**
 * The entries that match the operator's message best: each query word found in the title counts three, in the body one (at most
 * three per word); ties go to the newest. No match, no entry. Lexical on purpose: the full reader is 14 s cold, a model call is slower.
 */
export function recallEntries(text: string, query: string, limit: number): Array<{ id: string; title: string; body: string; createdAt: string }> {
  const terms = words(query);
  if (!terms.length) return [];
  return memoryEntries(text).map((entry) => {
    const title = entry.title.toLowerCase();
    const body = entry.body.toLowerCase();
    const score = terms.reduce((sum, term) => {
      const inTitle = title.includes(term) ? 3 : 0;
      const inBody = Math.min(3, body.split(term).length - 1);
      return sum + inTitle + inBody;
    }, 0);
    return { entry, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt)).slice(0, limit)
    .map(({ entry }) => ({ id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt }));
}

export function renderOperatorFacts(facts: OperatorFact[]): string {
  if (!facts.length) return "";
  return ["## Operator facts and rules (Space Memory, newest first; the operator's own words: they win over a pane, a note or your reading)",
    ...facts.map((fact) => `- [${fact.id.replace(/^space_memory:/, "").slice(0, 8)}] ${fact.date} ${fact.title}`)].join("\n");
}

/** The two newest monthly Space Memory files next to the current one (the gemini_* names are compatibility symlinks and skipped). */
export async function readMemoryMonthlies(monthlyPath: string): Promise<string> {
  const directory = dirname(monthlyPath);
  const names = (await readdir(directory)).filter((name) => /^space_memory_\d{4}-\d{2}\.md$/.test(name));
  const newest = [...new Set([...names, basename(monthlyPath)])].sort().slice(-2);
  const texts = await Promise.all(newest.map((name) => readFile(join(directory, name), "utf8").catch(() => "")));
  return texts.join("\n");
}

export async function readOperatorFacts(monthlyPath: string): Promise<string> {
  return renderOperatorFacts(operatorFacts(await readMemoryMonthlies(monthlyPath)));
}
