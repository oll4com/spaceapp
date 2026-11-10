import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NousLedgerRow, NousRepository, RailDecision } from "@space/db";

/**
 * R11-3 (goal 7365014c, 28/10: the DB ledger had 43 rows while the day's answers were 48): the operator's own answers in the copilot
 * rails (Mail reviews and rules, Marketing posts, campaigns and rules, Freelance messages, leads and rules, Job reviews, every copilot's
 * questions) join the decision ledger, one row each: source "RAIL:<copilot>", kind the event type, answer the decision, ref
 * "<copilot>:<event id>" so a row is never appended twice. Nous's own answers stay out (listRailDecisions leaves them out).
 */
export async function syncRailLedger(owner: string, answers: (owner: string, since: string) => Promise<RailDecision[]>,
  ledger: Pick<NousRepository, "listLedger" | "appendLedger">, now = Date.now()): Promise<number> {
  const since = new Date(now - 24 * 3_600_000).toISOString();
  // Plan clipboard:USQ6ktIIN_1D step 2 (rail rows were the ledger's only answers without a prediction): 30 days of rows for the base rate.
  const rows = await ledger.listLedger(owner, new Date(now - 30 * 86_400_000).toISOString());
  const held = new Set(rows.filter((row) => row.source.startsWith("RAIL:")).map((row) => row.ref));
  let added = 0;
  for (const row of await answers(owner, since)) {
    const ref = `${row.source}:${row.id}`;
    if (held.has(ref)) continue;
    held.add(ref);
    const source = `RAIL:${row.source}`;
    const predicted = row.decision === "answered" ? null : railBaseRate(rows, source, row.type);
    await ledger.appendLedger({ ownerUserId: owner, source, kind: row.type, title: row.title.trim() || row.type, predicted, answer: row.decision,
      match: predicted === null ? null : predicted === row.decision, ref });
    rows.push({ ownerUserId: owner, source, kind: row.type, title: row.title, predicted, answer: row.decision, match: null, ref, at: new Date(now).toISOString() });
    added += 1;
  }
  return added;
}

/** The answer of at least 80 % of this rail and kind's 5 or more earlier answers (R16-9's base rate for cards), known before this one. */
function railBaseRate(rows: Array<Pick<NousLedgerRow, "source" | "kind" | "answer">>, source: string, kind: string): string | null {
  const past = rows.filter((row) => row.source === source && row.kind === kind && row.answer !== "answered").map((row) => row.answer);
  if (past.length < 5) return null;
  const counts = new Map<string, number>();
  for (const answer of past) counts.set(answer, (counts.get(answer) ?? 0) + 1);
  const [answer, count] = [...counts].sort((left, right) => right[1] - left[1])[0]!;
  return count / past.length >= 0.8 ? answer : null;
}

export const DECISION_RULES_NOTE = "decision-rules";
const RULES_HEAD = "Learned from the operator's answers (Space rewrites this part from the decision ledger; a kind leaves it when an answer differs):";
const RULES_END = "(end of Space's part)";

/** What a row answered, for "the same answer again": a decision's or rail's word, a card's option without its note, a written answer whole. */
const answerKey = (answer: string) => { const head = answer.split(": ")[0]!.trim(); return /^answered$/i.test(head) ? answer.trim() : head; };
// Only the operator's answers teach a rule: never an allowance's, an "Always approve" or away grant's, or a copilot question's bare "answered".
const operatorAnswer = (row: NousLedgerRow) => row.source !== "ALLOWANCE" && !/^APPROVED: Approved by /.test(row.answer) && answerKey(row.answer).toLowerCase() !== "answered";

/** For each source and kind, the run of identical answers it ends with, oldest rows first; a run of 2 or more is a rule. */
export function ledgerRules(rows: NousLedgerRow[]): Array<{ key: string; answer: string; run: number; at: string }> {
  const runs = new Map<string, { answer: string; run: number; at: string }>();
  for (const row of [...rows].filter(operatorAnswer).sort((left, right) => left.at.localeCompare(right.at))) {
    const key = `${row.source} ${row.kind}`;
    const answer = answerKey(row.answer);
    const last = runs.get(key);
    runs.set(key, last && last.answer === answer ? { answer, run: last.run + 1, at: row.at } : { answer, run: 1, at: row.at });
  }
  return [...runs].filter(([, rule]) => rule.run >= 2).map(([key, rule]) => ({ key, ...rule })).sort((left, right) => right.at.localeCompare(left.at));
}

const cell = (text: string | null) => (text ?? "—").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim() || "—";

/**
 * Plan clipboard:USQ6ktIIN_1D steps 2-3 (operator 3/11 23:11 BKK: the rule from every answer reaches the ledger file and the note by itself):
 * every decision-ledger row since the last mirror becomes one line of `file` (the layout Nous writes by hand: when, source and kind, title,
 * prediction, answer, HIT/MISS, rule), and the decision-rules note's Space part lists every kind whose last 2 or more answers agree. The
 * first run only marks where it starts (the rows before it are Nous's own lines); the mark is kept beside the file.
 */
export async function mirrorLedger(owner: string, repo: Pick<NousRepository, "listLedger" | "listNotes" | "setNote">,
  options: { file: string; timeZone: string; now?: number }): Promise<number> {
  const markFile = join(dirname(options.file), ".ledger-mirror.json");
  const marks = JSON.parse(await readFile(markFile, "utf8").catch(() => "{}")) as Record<string, { at: string; refs: string[] }>;
  const all = await repo.listLedger(owner, new Date(0).toISOString());
  const mark = marks[owner];
  const id = (row: NousLedgerRow) => row.ref ?? `${row.source} ${row.title}`;
  // A row written in the mark's own millisecond after the last mirror is still new: the mark keeps the ids it saw at that time.
  const fresh = mark ? all.filter((row) => row.at > mark.at || (row.at === mark.at && !mark.refs.includes(id(row)))).sort((left, right) => left.at.localeCompare(right.at)) : [];
  const when = new Intl.DateTimeFormat("sv-SE", { timeZone: options.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  if (fresh.length) {
    await mkdir(dirname(options.file), { recursive: true });
    const lines = fresh.map((row) => {
      const rule = operatorAnswer(row) ? ledgerRules(all.filter((other) => other.at <= row.at)).find((found) => found.key === `${row.source} ${row.kind}`) : undefined;
      return `| ${when.format(new Date(row.at))} | ${cell(`${row.source} ${row.kind}`)} | ${cell(`${row.title}${row.ref ? ` (${row.ref})` : ""}`)} | ${cell(row.predicted)} | ${cell(row.answer)} | `
        + `${row.match === null ? "—" : row.match ? "HIT" : "MISS"} | ${rule ? cell(`rule: ${rule.answer} (${rule.run} in a row)`) : "—"} |`;
    });
    // A table row right after prose is no table: a header starts the block when the file does not end in one.
    const ends = (await readFile(options.file, "utf8").catch(() => "")).trimEnd().split("\n").at(-1) ?? "";
    const head = ends.startsWith("|") ? "" : "\n| When | Source kind | Title | Prediction | Answer | Match | Rule |\n|---|---|---|---|---|---|---|\n";
    await appendFile(options.file, `${head}${lines.join("\n")}\n`, { mode: 0o644 });
  }
  const latest = all.reduce((at, row) => row.at > at ? row.at : at, mark?.at ?? new Date(options.now ?? Date.now()).toISOString());
  marks[owner] = { at: latest, refs: all.filter((row) => row.at === latest).map(id) };
  await mkdir(dirname(markFile), { recursive: true });
  await writeFile(markFile, JSON.stringify(marks), { mode: 0o644 });
  // The note keeps Nous's own text; only the part between RULES_HEAD and RULES_END is Space's, rebuilt whole each time.
  const note = (await repo.listNotes(owner)).find((found) => found.key === DECISION_RULES_NOTE)?.text ?? "";
  const start = note.indexOf(RULES_HEAD);
  const end = start < 0 ? -1 : note.indexOf(RULES_END, start);
  const own = start < 0 ? note.trimEnd() : `${note.slice(0, start).trimEnd()}${end < 0 ? "" : `\n\n${note.slice(end + RULES_END.length).trim()}`}`.trimEnd();
  const rules = ledgerRules(all).map((rule) => `- ${rule.key}: ${rule.answer} (last ${rule.run} answers alike, latest ${when.format(new Date(rule.at))})`);
  const next = rules.length ? `${own ? `${own}\n\n` : ""}${RULES_HEAD}\n${rules.join("\n")}\n${RULES_END}` : own;
  if (next.trim() !== note.trim()) await repo.setNote(owner, DECISION_RULES_NOTE, next.trim() || null);
  return fresh.length;
}
