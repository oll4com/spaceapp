import type { FastifyInstance, FastifyRequest } from "fastify";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { NOUS_CRYPTO_VERDICTS, type NousCryptoReport, type NousCryptoRow, type NousCryptoVerdict, type NousJobReport, type NousMarketingReport } from "@space/contracts";
import { NOUS_PROGRAMS_IMPORT_OWNER } from "./programs.js";
import { SPACE_AGENT_HOME } from "@space/contracts";

/**
 * The Nous "Crypto" page (operator 3/11 22:33 BKK, nous_msg:e734994004dd): the crypto team's final table, read when the page asks.
 * final-table.md replaces the draft the moment it exists (Bruno/Oscar, 4/11). Each row's first source link names its registry row, whose
 * cells (where it ran, test mode, start, hours logged, status, owner, evidence) are read from that line. Only table lines of Markdown files
 * under the agent workspace are read; nothing named like a code, key or secret (binance-code.txt, binance-login-code.txt) ever is.
 */
export const NOUS_CRYPTO_DIR = `${SPACE_AGENT_HOME}/agent-workspace/nous/crypto`;
export const NOUS_CRYPTO_TABLES = [{ file: "final-table.md", final: true }, { file: "final-table-draft.md", final: false }] as const;
const READABLE_ROOT = `${SPACE_AGENT_HOME}/agent-workspace/`;
const SECRET_NAME = /code|secret|key|token|password|credential|\.env/i;

const strip = (text: string) => text.replace(/\*\*/g, "").replace(/<br\s*\/?>/gi, " · ").trim();
const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
const isSeparator = (line: string | undefined) => /^\|\s*:?-{3,}/.test(line?.trim() ?? "");
const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();

export function verdictOf(cell: string): NousCryptoVerdict {
  const text = plain(strip(cell));
  if (text.startsWith("PASS")) return "PASS";
  if (text.startsWith("FAIL")) return "FAIL";
  if (text.startsWith("SKIP")) return "SKIP";
  if (/^(ΑΝΕΠΑΡΚ|INSUFFICIENT)/.test(text)) return "INSUFFICIENT";
  if (/^(ΕΡΕΥΝΑ|RESEARCH)/.test(text)) return "RESEARCH";
  if (/^(ΕΚΚΡΕΜ|PENDING)/.test(text)) return "PENDING";
  return "OTHER";
}

/** Hours, when the registry's "h logged" starts with a number of hours ("60.4 (stopped 1/11)", "~4"); "179 pool events" is no hours. */
export function hoursOf(text: string | undefined): number | null {
  const match = /^~?\s*(\d+(?:[.,]\d+)?)\s*(?:(?:h|hours?)\b|$|\(|;|,|\+|live\b|runtime\b)/i.exec(text?.trim() ?? "");
  return match ? Number(match[1]!.replace(",", ".")) : null;
}

// A rejection's stated reason, grouped by its words (a row can name several reasons).
const REASONS: Array<[string, RegExp]> = [
  ["Success rate below 70%", /<<?\s*70\b|\bbelow 70\b|\bunder 70\b|CI reaches 70|upper \d+(?:[.,]\d+)?\s*%?\s*<\s*70|Άνω όριο CI/i],
  ["Net result negative after costs", /mean net\s*<\s*0|net per trade\s*<\s*0|net (?:return )?<\s*0|net negative|negative mean|net loss|lost money|cost\s*(?:>|exceeds)|adverse selection|pays gas|backtest negative|exceeds (?:lease revenue|payout|spread)|equals buy-and-hold|negative expected/i],
  ["No trade or opportunity found", /no opportunity|does not trade|forward n\s*=\s*0|not reproducible|no dry-run/i],
  // Only a program's own "(closed": "0/4 closed trades" and "closed round" are results (stable 3/11: eight FAIL rows read "Program closed").
  ["Program closed or nothing open", /discontinued|no live|nothing live|none live|no open|nothing open|\(closed\b|signups closed|in person only|no public bounties/i],
  // "zero-capital (read)" is how a test ran, "idle capital", "a paying program" and "zero operator money" are no need (fourteen rows read it as one).
  ["Needs capital or the operator", /needs capital|without capital|capital unavailable|bought with capital|\(capital\)|operator action|(?<!zero )operator money|operator's hands|without paying|account or a bypass|needs a product|no cash/i],
  ["Reviewed only, never run", /source review|classification|eligibility review|research only|not verifiable|shadow \/ research/i],
  ["One-off or not repeatable", /unrepeatable|one-off|historic win|μοναδικό/i],
  ["Not eligible", /we are excluded|not a grant/i]
];
// "(CI 10.2-49.5)": the first interval the reason states, when its upper end is under 70.
const ciBelow70 = (text: string) => { const ci = /\bCI\s*(\d+(?:[.,]\d+)?)\s*%?\s*[-–]\s*(\d+(?:[.,]\d+)?)/.exec(text); return ci ? Number(ci[2]!.replace(",", ".")) < 70 : false; };
const meanNegative = (text: string) => /\b(?:mean|net)\s*[-−]\s*\$?\d/i.test(text);
export const reasonsOf = (text: string) => {
  const named = REASONS.filter(([reason, pattern]) => pattern.test(text) || (reason.startsWith("Success rate") && ciBelow70(text))
    || (reason.startsWith("Net result") && meanNegative(text))).map(([reason]) => reason);
  return named.length ? named : ["Not grouped (see the row)"];
};

const allowed = (path: string) => resolve(path).startsWith(READABLE_ROOT) && path.endsWith(".md") && !SECRET_NAME.test(basename(path));

/** The table, its notes and every row, with each row's registry cells. */
export function parseCryptoTable(markdown: string, readLines: (path: string) => string[] | null): Omit<NousCryptoReport, "source"> & { title: string } {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line, index) => /^\|\s*ID\s*\|/i.test(line.trim()) && isSeparator(lines[index + 1]) && cellsOf(line).length >= 9);
  const title = strip(lines.find((line) => line.startsWith("# "))?.slice(2) ?? "");
  const notes = (at < 0 ? lines : lines.slice(0, at)).filter((line) => line.trim() && !line.trim().startsWith("|") && !line.startsWith("#")).map((line) => strip(line.replace(/^\s*-\s+/, "")));
  const header = at < 0 ? [] : cellsOf(lines[at]!);
  const column = (pattern: RegExp, fallback: number) => { const index = header.findIndex((cell, position) => position > 0 && pattern.test(cell)); return index > 0 ? index : fallback; };
  // By the header's first word ("Κέρδος ανά μήνα / βάση πηγής" also says πηγή), else the draft's order.
  const columns = { method: column(/^(μέθοδος|method)/i, 1), category: column(/^(κατηγορία|category)/i, 2), success: column(/^(ποσοστό|success)/i, 3),
    monthly: column(/^(κέρδος|expected|profit|€)/i, 4), capital: column(/^(κεφάλαιο|capital)/i, 5), risk: column(/^(κίνδυνος|risk)/i, 6),
    source: column(/^(πηγή|source|evidence)/i, 7), verdict: column(/^(PASS|verdict|status|κατάσταση)/i, 8) };
  const rows: NousCryptoRow[] = [];
  for (const line of at < 0 ? [] : lines.slice(at + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = cellsOf(line);
    const cell = (index: number) => strip(cells[index] ?? "");
    const sourceCell = cells[columns.source] ?? "";
    const sources = [...sourceCell.matchAll(/\[([^\]]*)\]\(([^)\s]+?)(?::(\d+))?\)/g)].map((match) => ({ label: match[1]!, path: match[2]!, line: match[3] ? Number(match[3]) : null }));
    const first = sources.find((source) => source.line !== null && allowed(source.path));
    let registry: Record<string, string> | null = null;
    const file = first ? readLines(first.path) : null;
    if (file && first?.line && file[first.line - 1]?.trim().startsWith("|")) {
      for (let index = first.line - 2; index >= 0; index -= 1) {
        if (file[index]?.trim().startsWith("|") && isSeparator(file[index + 1])) {
          const names = cellsOf(file[index]!), values = cellsOf(file[first.line - 1]!);
          registry = Object.fromEntries(names.map((name, position) => [name, strip(values[position] ?? "")]));
          break;
        }
      }
    }
    const id = cell(0), verdictText = cell(columns.verdict), verdict = verdictOf(verdictText);
    const registryField = (name: string) => registry ? Object.entries(registry).find(([key]) => key.toLowerCase() === name)?.[1] : undefined;
    rows.push({ id, method: cell(columns.method), category: cell(columns.category), success: cell(columns.success), monthly: cell(columns.monthly), capital: cell(columns.capital),
      risk: cell(columns.risk), verdict, verdictText, sources, sourceText: strip(sourceCell.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "")).replace(/^[\s·]+|[\s·]+$/g, ""),
      registry, hours: hoursOf(registryField("h logged")), retestOf: /^(.+)-n2$/i.exec(id)?.[1] ?? null, retests: [],
      reasons: verdict === "FAIL" || verdict === "SKIP" ? reasonsOf([registryField("status"), verdictText, cell(columns.success), registryField("test mode"), registryField("h logged")].filter(Boolean).join(" ")) : [] });
  }
  for (const row of rows) if (row.retestOf) rows.find((entry) => entry.id === row.retestOf)?.retests.push(row.id);
  const verdicts = Object.fromEntries(NOUS_CRYPTO_VERDICTS.map((verdict) => [verdict, rows.filter((row) => row.verdict === verdict).length])) as Record<NousCryptoVerdict, number>;
  const categories = new Map<string, { category: string; total: number; verdicts: Partial<Record<NousCryptoVerdict, number>> }>();
  for (const row of rows) {
    const entry = categories.get(row.category) ?? categories.set(row.category, { category: row.category, total: 0, verdicts: {} }).get(row.category)!;
    entry.total += 1;
    entry.verdicts[row.verdict] = (entry.verdicts[row.verdict] ?? 0) + 1;
  }
  const reasons = new Map<string, string[]>();
  for (const row of rows) for (const reason of row.reasons) reasons.set(reason, [...reasons.get(reason) ?? [], row.id]);
  return { title, notes, rows, verdicts, categories: [...categories.values()].sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
    reasons: [...reasons].map(([reason, ids]) => ({ reason, ids })).sort((a, b) => b.ids.length - a.ids.length) };
}

/** A registry "started" cell as a day: "2026-10-29 12:30Z", or "14/10" / "29/10 19:30 BKK" (day/month, the latest such day not after `now`); else null. */
export function startedOf(text: string | undefined, now: number): string | null {
  const iso = text?.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`;
  const short = text?.match(/^\s*(\d{1,2})\/(\d{1,2})\b/);
  const [day, month] = short ? [Number(short[1]), Number(short[2])] : [0, 0];
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return null;
  const year = new Date(now).getUTCFullYear();
  const at = Date.UTC(year, month - 1, day);
  return new Date(at > now ? Date.UTC(year - 1, month - 1, day) : at).toISOString();
}

/** `dir` null: no table (another account than the operator's). */
export async function readCryptoReport(dir: string | null): Promise<NousCryptoReport> {
  for (const table of dir ? NOUS_CRYPTO_TABLES : []) {
    const path = join(dir!, table.file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const files = new Map<string, string[] | null>();
    const read = await readFile(path, "utf8");
    // The registry files the rows link to, read once each.
    const linked = [...new Set([...read.matchAll(/\]\(([^)\s]+?\.md)(?::\d+)?\)/g)].map((match) => match[1]!))].filter(allowed);
    await Promise.all(linked.map(async (file) => files.set(file, await readFile(file, "utf8").then((text) => text.split("\n"), () => null))));
    const { title, ...report } = parseCryptoTable(read, (file) => files.get(file) ?? null);
    return { source: { path, final: table.final, modifiedAt: info.mtime.toISOString(), title }, ...report };
  }
  return { source: null, notes: [], rows: [], verdicts: Object.fromEntries(NOUS_CRYPTO_VERDICTS.map((verdict) => [verdict, 0])) as Record<NousCryptoVerdict, number>, categories: [], reasons: [] };
}

/** Both pages read only; the crypto files are the operator's (this server's), so another account sees an empty table. */
export function registerNousReportRoutes(app: FastifyInstance, deps: {
  routeOptions: Record<string, unknown>; owner(request: FastifyRequest): Promise<string>; jobReport: ((owner: string) => Promise<NousJobReport>) | null; cryptoDir?: string;
  marketingReport?: ((owner: string) => Promise<NousMarketingReport>) | null;
}): void {
  app.get("/api/nous/marketing-report", deps.routeOptions, async (request) => {
    const owner = await deps.owner(request);
    if (!deps.marketingReport) throw Object.assign(new Error("The Marketing Copilot is not running on this server."), { statusCode: 409 });
    return { report: await deps.marketingReport(owner) };
  });
  app.get("/api/nous/job-report", deps.routeOptions, async (request) => {
    const owner = await deps.owner(request);
    if (!deps.jobReport) throw Object.assign(new Error("The Job Copilot is not running on this server."), { statusCode: 409 });
    return { report: await deps.jobReport(owner) };
  });
  app.get("/api/nous/crypto-report", deps.routeOptions, async (request) => {
    const owner = await deps.owner(request);
    return { report: await readCryptoReport(owner === NOUS_PROGRAMS_IMPORT_OWNER ? deps.cryptoDir ?? NOUS_CRYPTO_DIR : null) };
  });
}
