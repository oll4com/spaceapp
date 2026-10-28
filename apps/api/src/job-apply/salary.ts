import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { SpaceConflictError } from "@space/runtime";
import { fetchPublicUrl } from "../public-url-fetch.js";

// Salary research for Job Copilot (operator rule 2026-10-25: research what each position pays, answer below the market
// average). The server reads public pages only, with no cookies, logins or CAPTCHA; a walled source is skipped. Only
// validated numbers and short labels leave this module, never page text. levels.fyi (AWS WAF challenge) and Glassdoor
// (HTTP 403) wall this server, so the market sources are Payscale and Paylab; the posting itself always comes first.

export const salaryResearchRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  seniority: z.string().trim().min(1).max(60).optional(),
  city: z.string().trim().min(1).max(120),
  country: z.string().trim().min(2).max(100),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  postingUrl: z.string().trim().url().max(2000).optional(),
  applicationId: z.string().regex(/^jobapp:[A-Za-z0-9_-]{6,80}$/).optional(),
  refresh: z.boolean().optional()
}).strict();
export type SalaryResearchRequest = z.infer<typeof salaryResearchRequestSchema>;

export type SalaryPeriod = "YEAR" | "MONTH" | "WEEK" | "DAY" | "HOUR";
type Percentile = "p10" | "p25" | "median" | "p75" | "p90";
type Figures = Partial<Record<Percentile, number>> & { median: number };
export interface SalaryRange { currency: string; period: SalaryPeriod; min: number; max: number }
type PostingRange = SalaryRange & { source: "greenhouse" | "linkedin" | "page"; url: string };
export interface MarketRow {
  source: "payscale" | "paylab"; url: string; scope: "city" | "country"; matched: string; fetchedAt: string;
  currency: string; period: SalaryPeriod; figures: Figures; medianEstimated?: boolean; sampleCount: number | null;
}
export interface SkippedSource { source: string; url: string | null; reason: string }
type Yearly = { p25: number | null; median: number; p75: number | null };
export interface SalaryResearchResult {
  query: { title: string; seniority: string | null; city: string; country: string; currency: string; paymentsPerYear: number };
  postingRange: (PostingRange & { yearly: { min: number; max: number } }) | null;
  market: { currency: string; paymentsPerYear: number; sampleCount: number | null; yearly: Yearly; monthly: Yearly; sources: Array<MarketRow & { yearly: Yearly }> } | null;
  skipped: SkippedSource[];
  recommended: { yearly: number; monthly: number; currency: string; belowPercent: number; rule: string } | null;
  confidence: "low" | "medium" | "high";
  /** Low confidence: Job Copilot asks the operator instead of answering. */
  askOperator: boolean;
  cached: boolean;
  researchedAt: string;
}

export type SalaryFetch = (url: string) => Promise<{ status: number; text: string }>;
const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const publicFetch: SalaryFetch = async (url) => {
  const response = await fetchPublicUrl(url, { timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024, headers: {
    "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" } });
  return { status: response.status, text: response.text };
};

const CACHE_TTL_MS = 30 * 24 * 3_600_000;
const FOURTEEN_PAYMENTS = new Set(["GR", "ES", "PT"]);
const PERIOD_PER_YEAR: Record<Exclude<SalaryPeriod, "MONTH">, number> = { YEAR: 1, WEEK: 52, DAY: 260, HOUR: 2080 };
const PLAUSIBLE: Record<SalaryPeriod, [number, number]> = { YEAR: [5_000, 1e8], MONTH: [300, 1e7], WEEK: [80, 2e6], DAY: [20, 5e5], HOUR: [5, 1e5] };
// shortcut: default currencies for the euro area and the ECB reference currencies; elsewhere pass `currency` (else USD).
const COUNTRY_CURRENCY = new Map<string, string>([
  ..."AT BE BG HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES".split(" ").map((code) => [code, "EUR"] as [string, string]),
  ..."US USD,GB GBP,CH CHF,CA CAD,AU AUD,NZ NZD,SE SEK,NO NOK,DK DKK,PL PLN,CZ CZK,HU HUF,RO RON,IS ISK,TR TRY,JP JPY,SG SGD,HK HKD,IN INR,IL ILS,TH THB,ZA ZAR,BR BRL,MX MXN,KR KRW,CN CNY,MY MYR,PH PHP,ID IDR"
    .split(",").map((pair) => pair.split(" ") as [string, string])
]);

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_BY_NAME = new Map<string, string>([["uk", "GB"], ["usa", "US"], ["united states of america", "US"], ["hellas", "GR"], ["ελλαδα", "GR"]]);
for (let first = 65; first <= 90; first += 1) for (let second = 65; second <= 90; second += 1) {
  const code = String.fromCharCode(first, second);
  const name = regionNames.of(code);
  if (name && name !== code && !COUNTRY_BY_NAME.has(fold(name))) COUNTRY_BY_NAME.set(fold(name), code);
}
export function countryCode(input: string): string | null {
  const upper = input.trim().toUpperCase();
  if (upper === "UK") return "GB";
  if (/^[A-Z]{2}$/.test(upper) && regionNames.of(upper) !== upper) return upper;
  return COUNTRY_BY_NAME.get(fold(input)) ?? null;
}

/** Short page labels only (a job title, a city name): letters, digits and simple punctuation. */
const label = (value: unknown) => typeof value === "string" ? value.replace(/[^\p{L}\p{N} .,&/()+#-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1e10 ? value
  : typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
/** Percentiles must be positive and ascending; anything else is not salary data. */
function figuresOf(raw: Partial<Record<Percentile, unknown>>): Figures | null {
  const figures: Partial<Record<Percentile, number>> = {};
  for (const key of ["p10", "p25", "median", "p75", "p90"] as const) { const value = number(raw[key]); if (value !== null) figures[key] = value; }
  const ordered = (["p10", "p25", "median", "p75", "p90"] as const).flatMap((key) => figures[key] === undefined ? [] : [figures[key]!]);
  return figures.median !== undefined && ordered.every((value, index) => index === 0 || value >= ordered[index - 1]!) ? figures as Figures : null;
}
const plausible = (period: SalaryPeriod, min: number, max: number) => min >= PLAUSIBLE[period][0] && max <= PLAUSIBLE[period][1] && max >= min && max <= min * 4;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", euro: "€", pound: "£", dollar: "$" };
const decode = (text: string) => text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => name.startsWith("#")
  ? String.fromCodePoint(name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))) : ENTITIES[name.toLowerCase()] ?? entity);
/** Plain text of (possibly double-escaped) HTML, as Greenhouse sends job content. */
export const plainText = (html: string) => decode(decode(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

const CODES = "USD|EUR|GBP|CHF|CAD|AUD|NZD|SEK|NOK|DKK|PLN|CZK|SGD|INR";
const SYMBOLS: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP" };
const AMOUNT = String.raw`(\d{1,3}(?:[,.]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d+)?)\s?([kK]\b)?`;
const UNIT = String.raw`(?:\s?\/\s?(yr|year|hr|hour|mo|month)\b)?`;
const RANGE_PATTERN = new RegExp(String.raw`(?:\b(${CODES})\s?|([$€£])\s?)${AMOUNT}${UNIT}\s*(?:-|–|—|to)\s*(?:\b(${CODES})\s?|([$€£])\s?)?${AMOUNT}${UNIT}(?:\s?\b(${CODES})\b)?`, "gi");
function amount(digits: string, thousands: string | undefined): number {
  if (thousands) return Number(digits.replace(/,/g, "")) * 1000;
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(digits)) return Number(digits.replace(/,/g, ""));
  if (/^\d{1,3}(?:\.\d{3})+$/.test(digits)) return Number(digits.replace(/\./g, ""));
  return Number(digits);
}
function periodNear(unit: string | undefined, around: string): SalaryPeriod | null {
  if (unit) return /^y/i.test(unit) ? "YEAR" : /^h/i.test(unit) ? "HOUR" : "MONTH";
  if (/\b(per (year|annum)|annual(ly)?|yearly|a year|p\.a)\b|\/year/i.test(around)) return "YEAR";
  if (/\b(per month|monthly|a month)\b|\/month/i.test(around)) return "MONTH";
  if (/\b(per hour|hourly|an hour)\b|\/hour/i.test(around)) return "HOUR";
  return null;
}
/** The first plausible pay range written in a job description ("$192,000 — $216,000 USD", "€60k-80k per year"). */
export function salaryRangeFromText(text: string): SalaryRange | null {
  for (const match of text.matchAll(RANGE_PATTERN)) {
    let min = amount(match[3]!, match[4]);
    const max = amount(match[8]!, match[9] ?? match[4]);
    if (match[9] && !match[4] && min < 1000) min *= 1000; // "€50-60k"
    const symbol = match[2] ?? match[7];
    const currency = (match[1] ?? match[6] ?? match[11])?.toUpperCase() ?? (symbol ? SYMBOLS[symbol] : undefined);
    const around = text.slice(Math.max(0, match.index! - 80), match.index! + match[0].length + 80);
    const period = periodNear(match[5] ?? match[10], around) ?? (min >= 15_000 ? "YEAR" : null);
    if (currency && period && plausible(period, min, max)) return { currency, period, min, max };
  }
  return null;
}

const UNIT_TEXT: Record<string, SalaryPeriod> = { YEAR: "YEAR", MONTH: "MONTH", WEEK: "WEEK", DAY: "DAY", HOUR: "HOUR" };
/** schema.org JobPosting.baseSalary (Ashby, Lever, Workday and most career sites), else a range in its description. */
export function salaryRangeFromJsonLd(html: string): SalaryRange | null {
  const nodes: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node["@type"] === "JobPosting" || (Array.isArray(node["@type"]) && node["@type"].includes("JobPosting"))) nodes.push(node);
    if (node["@graph"]) visit(node["@graph"]);
  };
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(block[1]!)); } catch { /* a broken block is no data */ }
  }
  for (const node of nodes) {
    const salary = node.baseSalary as { currency?: unknown; value?: unknown } | undefined;
    const value = (salary?.value && typeof salary.value === "object" ? salary.value : { value: salary?.value }) as Record<string, unknown>;
    const min = number(value.minValue ?? value.value); const max = number(value.maxValue ?? value.value);
    const period = UNIT_TEXT[String(value.unitText ?? "YEAR").toUpperCase()];
    const currency = String(salary?.currency ?? "").toUpperCase();
    if (min && max && period && /^[A-Z]{3}$/.test(currency) && plausible(period, min, max)) return { currency, period, min, max };
  }
  for (const node of nodes) if (typeof node.description === "string") { const range = salaryRangeFromText(plainText(node.description)); if (range) return range; }
  return null;
}

/** Greenhouse's job API with pay_transparency=true: pay_input_ranges, else a range in the content. */
export function greenhouseSalaryRange(payload: unknown): SalaryRange | null {
  const job = (payload ?? {}) as { pay_input_ranges?: unknown; content?: unknown };
  for (const raw of Array.isArray(job.pay_input_ranges) ? job.pay_input_ranges : []) {
    const range = raw as { min_cents?: unknown; max_cents?: unknown; currency_type?: unknown; title?: unknown };
    const min = (number(range.min_cents) ?? 0) / 100; const max = (number(range.max_cents) ?? 0) / 100;
    const currency = String(range.currency_type ?? "").toUpperCase();
    const period: SalaryPeriod = /hour/i.test(String(range.title ?? "")) ? "HOUR" : "YEAR";
    if (/^[A-Z]{3}$/.test(currency) && plausible(period, min, max)) return { currency, period, min, max };
  }
  return typeof job.content === "string" ? salaryRangeFromText(plainText(job.content)) : null;
}

/** Payscale research pages (Next.js data): base salary percentiles, the page's job title and its city pages. */
export function parsePayscale(html: string): { currency: string; figures: Figures; sampleCount: number | null; matched: string; cities: Array<{ name: string; url: string }> } | null {
  const script = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) return null;
  let data: Record<string, any>;
  try { data = JSON.parse(script)?.props?.pageProps?.pageData ?? {}; } catch { return null; }
  const salary = data.compensation?.salary ?? {};
  const figures = figuresOf({ p10: salary["10"], p25: salary["25"], median: salary["50"], p75: salary["75"], p90: salary["90"] });
  const currency = typeof data.currencyCode === "string" && /^[A-Z]{3}$/.test(data.currencyCode) ? data.currencyCode : null;
  if (!figures || !currency) return null;
  const rows: unknown[] = data.byDimension?.["Job by Location"]?.rows ?? [];
  const cities = rows.flatMap((row) => {
    const entry = row as { name?: unknown; url?: unknown };
    return typeof entry.url === "string" && /^\/research\/[A-Za-z0-9=_/.,()%-]+$/.test(entry.url) && label(entry.name) ? [{ name: label(entry.name), url: entry.url }] : [];
  });
  return { currency, figures, sampleCount: number(salary.profileCount), matched: label(data.dimensions?.job), cities };
}

/** Paylab's Information Technology category page: every position with its p10-p90 monthly gross range. */
export function parsePaylabCategory(html: string): Array<{ slug: string; name: string; currency: string; p10: number; p90: number }> {
  return [...html.matchAll(/<a href="https:\/\/www\.paylab\.com\/[a-z]{2}\/salaryinfo\/information-technology\/([a-z0-9-]+)\?lang=en"[^>]*>([\s\S]*?)<\/a>/g)].flatMap((match) => {
    const name = label(plainText(/<div class="col">([\s\S]*?)<\/div>/.exec(match[2]!)?.[1] ?? ""));
    const range = /([\d,]+)\s*-\s*([\d,]+)\s*([A-Z]{3})\s*$/.exec(plainText(match[2]!).trim());
    const p10 = range ? amount(range[1]!, undefined) : 0; const p90 = range ? amount(range[2]!, undefined) : 0;
    return name && range && plausible("MONTH", p10, p90) ? [{ slug: match[1]!, name, currency: range[3]!, p10, p90 }] : [];
  });
}

/** ECB euro reference rates: units of each currency per euro. */
export function parseEcbRates(xml: string): Map<string, number> {
  const rates = new Map<string, number>([["EUR", 1]]);
  for (const match of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) { const rate = number(match[2]); if (rate) rates.set(match[1]!, rate); }
  return rates;
}

const SENIORITY = /\b(senior|sr|junior|jr|lead|principal|staff|mid|entry|intern|graduate|i{1,3}|iv)\b\.?/gi;
const cleanTitle = (title: string) => title.replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}+#&\- ]/gu, " ").replace(/\s+/g, " ").trim();
const bareTitle = (title: string) => cleanTitle(title).replace(SENIORITY, " ").replace(/-level\b/gi, " ").replace(/\s+/g, " ").trim();
const titleTokens = (text: string) => fold(text).split(/[^\p{L}\p{N}+#.]+/u).filter(Boolean).map((word) => /^(developer|engineer|programmer|dev)$/.test(word) ? "dev" : word);
/** The Paylab position whose every word is in the title (developer, engineer and programmer count as one word); the longest wins. */
export function matchPosition<T extends { name: string }>(title: string, positions: T[]): T | null {
  const wanted = new Set(titleTokens(bareTitle(title)));
  let best: T | null = null; let bestSize = 0;
  for (const position of positions) {
    const words = new Set(titleTokens(position.name));
    if (words.size > bestSize && [...words].every((word) => wanted.has(word))) { best = position; bestSize = words.size; }
  }
  return best;
}

/** A clean figure at or below the value: two significant digits (2.5 for values starting with 1). */
function cleanDown(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = value < 2 * magnitude ? magnitude / 20 : magnitude / 10;
  return Math.max(step, Math.floor(value / step) * step);
}
const amountText = (value: number) => Math.round(value).toLocaleString("en-US");
const money = (currency: string, value: number) => `${currency} ${amountText(value)}`;

export interface SalaryResearchOptions { cacheFile: string; fetch?: SalaryFetch; now?: () => Date }
type CacheEntry = { fetchedAt: string; rows: MarketRow[]; skipped: SkippedSource[] };

export function createSalaryResearch(options: SalaryResearchOptions) {
  const fetchText = options.fetch ?? publicFetch;
  const now = options.now ?? (() => new Date());
  let rates: { day: string; table: Map<string, number> } | null = null;

  async function get(source: string, url: string): Promise<{ text: string } | SkippedSource> {
    try {
      const response = await fetchText(url);
      if (response.status === 404 || response.status === 410) return { source, url, reason: "no page for this query" };
      if (response.status < 200 || response.status >= 300) return { source, url, reason: `blocked or unavailable (HTTP ${response.status})` };
      return { text: response.text };
    } catch (error) {
      return { source, url, reason: error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be fetched" };
    }
  }
  const failed = (value: { text: string } | SkippedSource): value is SkippedSource => "reason" in value;

  async function postingRange(url: string): Promise<{ range: PostingRange } | SkippedSource> {
    const parsed = new URL(url);
    const greenhouse = /^(?:job-boards|boards)(\.eu)?\.greenhouse\.io$/.exec(parsed.hostname);
    const greenhousePath = /^\/([A-Za-z0-9_-]+)\/jobs\/(\d+)/.exec(parsed.pathname);
    const greenhouseEmbed = parsed.searchParams.get("for") && /^\d+$/.test(parsed.searchParams.get("token") ?? "") ? [parsed.searchParams.get("for")!, parsed.searchParams.get("token")!] as const : null;
    const linkedin = /(^|\.)linkedin\.com$/.test(parsed.hostname) ? (/\/jobs\/view\/(?:[^/]*?-)?(\d{6,})/.exec(parsed.pathname)?.[1] ?? parsed.searchParams.get("currentJobId")) : null;
    if (greenhouse && (greenhousePath || greenhouseEmbed)) {
      const [board, id] = greenhousePath ? [greenhousePath[1]!, greenhousePath[2]!] : greenhouseEmbed!;
      const api = `https://boards-api${greenhouse[1] ?? ""}.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${id}?pay_transparency=true`;
      const page = await get("posting", api);
      if (failed(page)) return page;
      let payload: unknown = null;
      try { payload = JSON.parse(page.text); } catch { /* no data */ }
      const range = greenhouseSalaryRange(payload);
      return range ? { range: { ...range, source: "greenhouse", url } } : { source: "posting", url, reason: "the posting states no pay range" };
    }
    const target = linkedin && /^\d{6,}$/.test(linkedin) ? `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${linkedin}` : url;
    const page = await get("posting", target);
    if (failed(page)) return { ...page, url };
    const range = linkedin ? salaryRangeFromText(plainText(page.text)) : salaryRangeFromJsonLd(page.text);
    return range ? { range: { ...range, source: linkedin ? "linkedin" : "page", url } } : { source: "posting", url, reason: "the posting states no pay range" };
  }

  async function payscale(titles: string[], city: string, country: string): Promise<MarketRow | SkippedSource> {
    let last: SkippedSource = { source: "payscale", url: null, reason: "no page for this title" };
    for (const title of titles) {
      const url = `https://www.payscale.com/research/${country}/Job=${encodeURIComponent(title.replace(/(^| )(\p{Ll})/gu, (_, space: string, letter: string) => space + letter.toUpperCase()).replace(/ /g, "_"))}/Salary`;
      const page = await get("payscale", url);
      if (failed(page)) { last = page; if (!page.reason.startsWith("no page")) return page; continue; }
      const data = parsePayscale(page.text);
      if (!data) { last = { source: "payscale", url, reason: "no salary figures on the page" }; continue; }
      const row = (pageUrl: string, scope: MarketRow["scope"], parsed: NonNullable<ReturnType<typeof parsePayscale>>, place = ""): MarketRow => ({
        source: "payscale", url: pageUrl, scope, matched: place ? `${parsed.matched} (${place})` : parsed.matched, fetchedAt: now().toISOString(),
        currency: parsed.currency, period: "YEAR", figures: parsed.figures, sampleCount: parsed.sampleCount });
      const cityRow = data.cities.find((entry) => fold(entry.name).startsWith(fold(city)));
      if (cityRow) {
        const cityUrl = `https://www.payscale.com${cityRow.url}`;
        const cityPage = await get("payscale", cityUrl);
        const cityData = failed(cityPage) ? null : parsePayscale(cityPage.text);
        if (cityData) return row(cityUrl, "city", cityData, cityRow.name);
      }
      return row(url, "country", data);
    }
    return last;
  }

  async function paylab(title: string, country: string): Promise<MarketRow | SkippedSource> {
    // shortcut: only Paylab's Information Technology category is searched; other fields need their category pages.
    // Paylab shows some countries (the US) annual figures unless asked for monthly ones.
    const url = `https://www.paylab.com/${country.toLowerCase()}/salaryinfo/information-technology?lang=en&global_salary_period=monthly`;
    const page = await get("paylab", url);
    if (failed(page)) return page;
    const position = matchPosition(title, parsePaylabCategory(page.text));
    if (!position) return { source: "paylab", url, reason: "no matching position" };
    // Paylab publishes the 10th and 90th percentiles only; their geometric mean estimates a log-normal median.
    const figures = figuresOf({ p10: position.p10, median: Math.round(Math.sqrt(position.p10 * position.p90)), p90: position.p90 })!;
    return { source: "paylab", url: `https://www.paylab.com/${country.toLowerCase()}/salaryinfo/information-technology/${position.slug}`, scope: "country",
      matched: position.name, fetchedAt: now().toISOString(), currency: position.currency, period: "MONTH", figures, medianEstimated: true, sampleCount: null };
  }

  async function readCache(): Promise<Record<string, CacheEntry>> {
    try { return JSON.parse(await readFile(options.cacheFile, "utf8")) as Record<string, CacheEntry>; } catch { return {}; }
  }
  async function writeCache(key: string, entry: CacheEntry): Promise<void> {
    const all = await readCache();
    for (const [other, value] of Object.entries(all)) if (now().getTime() - Date.parse(value.fetchedAt) > CACHE_TTL_MS) delete all[other];
    all[key] = entry;
    await mkdir(dirname(options.cacheFile), { recursive: true });
    const temporary = `${options.cacheFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(all), "utf8");
    await rename(temporary, options.cacheFile);
  }

  async function rateTable(): Promise<Map<string, number> | null> {
    const day = now().toISOString().slice(0, 10);
    if (rates?.day === day) return rates.table;
    const page = await get("ecb", "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml");
    const table = failed(page) ? null : parseEcbRates(page.text);
    if (table && table.size > 1) rates = { day, table };
    return rates?.table ?? null;
  }

  return {
    async research(raw: SalaryResearchRequest, belowPercent: number): Promise<SalaryResearchResult> {
      const input = salaryResearchRequestSchema.parse(raw);
      const country = countryCode(input.country);
      if (!country) throw new SpaceConflictError(`Unknown country "${input.country}"; use its English name or ISO code (GR, US).`);
      const currency = input.currency ?? COUNTRY_CURRENCY.get(country) ?? "USD";
      const paymentsPerYear = FOURTEEN_PAYMENTS.has(country) ? 14 : 12;
      const seniorTitle = input.seniority && !fold(input.title).includes(fold(input.seniority)) ? `${input.seniority} ${input.title}` : input.title;
      const titles = [...new Set([cleanTitle(seniorTitle), bareTitle(seniorTitle)].filter(Boolean))];
      const cacheKey = [fold(cleanTitle(seniorTitle)), fold(input.city), country].join("|");

      const cached = input.refresh ? undefined : (await readCache())[cacheKey];
      const fresh = cached && now().getTime() - Date.parse(cached.fetchedAt) <= CACHE_TTL_MS ? cached : null;
      const [posting, market] = await Promise.all([
        input.postingUrl ? postingRange(input.postingUrl) : Promise.resolve(null),
        fresh ?? Promise.all([payscale(titles, input.city, country), paylab(seniorTitle, country)]).then((results): CacheEntry => ({
          fetchedAt: now().toISOString(),
          rows: results.filter((result): result is MarketRow => "figures" in result),
          skipped: results.filter((result): result is SkippedSource => "reason" in result)
        }))
      ]);
      if (!fresh && market.rows.length) await writeCache(cacheKey, market);

      const skipped = [...market.skipped, ...(posting && "reason" in posting ? [posting] : [])];
      const needsRates = market.rows.some((row) => row.currency !== currency);
      const table = needsRates ? await rateTable() : null;
      const fx = (from: string) => from === currency ? 1 : table?.get(from) && table.get(currency) ? table.get(currency)! / table.get(from)! : null;
      const perYear = (period: SalaryPeriod) => period === "MONTH" ? paymentsPerYear : PERIOD_PER_YEAR[period];

      const sources = market.rows.flatMap((row) => {
        const rate = fx(row.currency);
        if (!rate) { skipped.push({ source: row.source, url: row.url, reason: `no exchange rate for ${row.currency}` }); return []; }
        const yearly = (value: number | undefined) => value === undefined ? null : Math.round(value * perYear(row.period) * rate);
        return [{ ...row, yearly: { p25: yearly(row.figures.p25), median: yearly(row.figures.median)!, p75: yearly(row.figures.p75) } }];
      });
      const pick = (key: "p25" | "median" | "p75") => median(sources.flatMap((row) => row.yearly[key] === null ? [] : [row.yearly[key]!]));
      const marketMedian = pick("median");
      let marketView: SalaryResearchResult["market"] = null;
      if (marketMedian !== null) {
        const p25 = pick("p25"); const p75 = pick("p75");
        const yearly: Yearly = { p25: p25 !== null && p25 <= marketMedian ? Math.round(p25) : null, median: Math.round(marketMedian), p75: p75 !== null && p75 >= marketMedian ? Math.round(p75) : null };
        const monthly = (value: number | null) => value === null ? null : Math.round(value / paymentsPerYear);
        const counts = sources.flatMap((row) => row.sampleCount === null ? [] : [row.sampleCount]);
        marketView = { currency, paymentsPerYear, sampleCount: counts.length ? counts.reduce((sum, value) => sum + value, 0) : null, yearly,
          monthly: { p25: monthly(yearly.p25), median: monthly(yearly.median)!, p75: monthly(yearly.p75) }, sources };
      }

      // A stated range stays in its own currency and so does the answer to it (a EUR 75,000-95,000 posting was answered
      // "USD 85,000" when the query asked USD, 2026-10-26).
      const postingView: SalaryResearchResult["postingRange"] = posting && "range" in posting
        ? { ...posting.range, yearly: { min: Math.round(posting.range.min * perYear(posting.range.period)), max: Math.round(posting.range.max * perYear(posting.range.period)) } }
        : null;
      const answerCurrency = postingView?.currency ?? currency;

      const base = postingView ? (postingView.yearly.min + postingView.yearly.max) / 2 : marketView?.yearly.median ?? null;
      let recommended: SalaryResearchResult["recommended"] = null;
      if (base) {
        // Never below the posting's own minimum: that would only lower the offer, not keep it under the midpoint.
        const yearly = Math.max(cleanDown(base * (1 - belowPercent / 100)), postingView?.yearly.min ?? 0);
        const what = postingView ? `the posting range midpoint (${money(answerCurrency, postingView.yearly.min)}-${amountText(postingView.yearly.max)} a year)` : `the market median (${money(currency, base)} a year)`;
        recommended = { yearly, monthly: cleanDown(yearly / paymentsPerYear), currency: answerCurrency, belowPercent, rule: `${belowPercent}% below ${what}, rounded down` };
      }
      const samples = marketView?.sampleCount ?? null;
      const confidence: SalaryResearchResult["confidence"] = postingView ? (sources.length ? "high" : "medium")
        : sources.length >= 3 && (samples ?? 0) >= 30 ? "high" : sources.length >= 2 && (samples === null || samples >= 10) ? "medium" : "low";
      return {
        query: { title: input.title, seniority: input.seniority ?? null, city: input.city, country, currency, paymentsPerYear },
        postingRange: postingView, market: marketView, skipped, recommended, confidence, askOperator: confidence === "low" || !recommended,
        cached: Boolean(fresh), researchedAt: now().toISOString()
      };
    }
  };
}
export type SalaryResearch = ReturnType<typeof createSalaryResearch>;

/** One Activity line for the application: what the market pays and what Job Copilot answers. */
export function salaryResearchNote(result: SalaryResearchResult): string {
  const { query, market, postingRange, recommended, confidence } = result;
  const parts = [`Salary research for ${query.seniority ? `${query.seniority} ` : ""}${query.title} in ${query.city}, ${query.country}:`];
  if (postingRange) parts.push(`posting states ${money(postingRange.currency, postingRange.min)}-${amountText(postingRange.max)} per ${postingRange.period.toLowerCase()};`);
  if (market) parts.push(`market median ${money(market.currency, market.yearly.median)} a year (${market.sources.map((row) => row.source).join(", ")});`);
  parts.push(recommended ? `answer ${money(recommended.currency, recommended.yearly)} a year / ${money(recommended.currency, recommended.monthly)} a month x${query.paymentsPerYear} (${recommended.rule}).` : "no figures found.");
  parts.push(`Confidence ${confidence}${result.askOperator ? ", asking the operator" : ""}.`);
  return parts.join(" ").slice(0, 1000);
}
