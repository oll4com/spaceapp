import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * The operator's facts and rules, pinned in Nous's world every turn (plan clipboard:bTm-5PGrt9po U2): the Space Memory entries
 * tagged operator-rule or operator-fact, newest first, one line each. On stable Nous relayed "we have no company" although the
 * operator's company was in memory (2026-10-20): a fact Nous must recall first is a fact it forgets.
 * Read from the newest two monthly files with a light scan: the full memory reader parses every file (13 s on its first call).
 */
export const NOUS_OPERATOR_FACTS_MAX = 25;
const PINNED_TAG = /^operator-(?:rule|fact)s?$/i;

export interface OperatorFact { id: string; date: string; title: string }

/** The pinned entries of canonical memory text, newest first: archived and superseded entries are left out, like the memory reader does. */
export function operatorFacts(text: string): OperatorFact[] {
  const blocks = text.split(/^(?=<!-- space-memory:id=)/m).map((block) => ({
    block,
    id: /^<!-- space-memory:id=([A-Za-z0-9:_-]{3,200}) -->/.exec(block)?.[1] ?? null,
    heading: /^## (\d{4}-\d{2}-\d{2}) - (?:Space canonical memory: )?(.+)$/m.exec(block),
    createdAt: /\bcreated_at=(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(block)?.[1] ?? null,
    active: !/(?:lifecycle_status|status)=ARCHIVED\b/.test(block)
  })).filter((entry) => entry.id && entry.heading && entry.active);
  const superseded = new Set(blocks.flatMap((entry) => [...entry.block.matchAll(/\bsupersedes=([A-Za-z0-9:_-]{3,200})\b/g)].map((match) => match[1]!)));
  return blocks.filter((entry) => !superseded.has(entry.id!) && [...entry.block.matchAll(/^\s*-\s*Tags:\s*(.+)$/gim)]
    .some((match) => match[1]!.split(",").some((tag) => PINNED_TAG.test(tag.trim()))))
    .sort((left, right) => (right.createdAt ?? right.heading![1]!).localeCompare(left.createdAt ?? left.heading![1]!))
    .slice(0, NOUS_OPERATOR_FACTS_MAX)
    .map((entry) => ({ id: entry.id!, date: entry.heading![1]!, title: entry.heading![2]!.replace(/\s+/g, " ").trim().slice(0, 200) }));
}

export function renderOperatorFacts(facts: OperatorFact[]): string {
  if (!facts.length) return "";
  return ["## Operator facts and rules (Space Memory, newest first; the operator's own words: they win over a pane, a note or your reading)",
    ...facts.map((fact) => `- [${fact.id.replace(/^space_memory:/, "").slice(0, 8)}] ${fact.date} ${fact.title}`)].join("\n");
}

/** The two newest monthly Space Memory files next to the current one (the gemini_* names are compatibility symlinks and skipped). */
export async function readOperatorFacts(monthlyPath: string): Promise<string> {
  const directory = dirname(monthlyPath);
  const names = (await readdir(directory)).filter((name) => /^space_memory_\d{4}-\d{2}\.md$/.test(name));
  const newest = [...new Set([...names, basename(monthlyPath)])].sort().slice(-2);
  const texts = await Promise.all(newest.map((name) => readFile(join(directory, name), "utf8").catch(() => "")));
  return renderOperatorFacts(operatorFacts(texts.join("\n")));
}
