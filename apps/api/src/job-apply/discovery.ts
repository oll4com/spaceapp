import { jobApplyDiscoverRequestSchema, type JobApplyDiscoverRequest, type JobApplyDiscoveredPosting, type JobApplyDiscoverResult, type JobApplyDiscoverySite } from "@space/contracts";

/**
 * Public ATS job-board APIs (JSON, no auth), scanned by board token. The API does the fetching so
 * the agent never needs network access of its own; results are deduped against the tracker by URL.
 */
export interface DiscoveryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  userAgent?: string;
}

type BoardSite = Exclude<JobApplyDiscoverySite, SearchSite>;
type SearchSite = "himalayas" | "linkedin" | "workable";
const SEARCH_SITES: readonly JobApplyDiscoverySite[] = ["himalayas", "linkedin", "workable"];
type SearchInput = Pick<JobApplyDiscoverRequest, "location" | "remote"> & { query: string };

const BOARD_URL: Record<BoardSite, (token: string) => string> = {
  greenhouse: (token) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
  lever: (token) => `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
  ashby: (token) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`
};
/** Searches by query, page by page (1-based); Greece is the server-side half of the Greece/EU filter unless the caller names a location. */
const SEARCH_URL: Record<SearchSite, (input: SearchInput, page: number, cursor: string | null) => string> = {
  himalayas: (input, page) => `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(input.query)}&country=Greece&page=${page}`,
  // Guest job search (HTML cards, 10 a page); f_WT=2 is remote, f_TPR=r2592000 the last 30 days (MAX_POSTING_AGE_MS).
  linkedin: (input, page) => `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(input.query)}`
    + `&location=${encodeURIComponent(input.location ?? "Greece")}${input.remote === true ? "&f_WT=2" : ""}&f_TPR=r2592000&start=${(page - 1) * 10}`,
  workable: (input, _page, cursor) => `https://jobs.workable.com/api/v1/jobs?query=${encodeURIComponent(input.query)}`
    + `&location=${encodeURIComponent(input.location ?? "Greece")}${input.remote === true ? "&workplace=remote" : ""}${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ""}`
};
/** Himalayas returns 20 jobs a page and LinkedIn 10 (no cursor): a short page is the last. Workable pages by nextPageToken. */
const SEARCH_PAGE_SIZE: Record<SearchSite, number> = { himalayas: 20, linkedin: 10, workable: 0 };

function titleCase(token: string): string {
  return token.split(/[-_.]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function iso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return null;
}
/** The first value that says something decides; hybrid or on-site wording is not remote even beside "remote" ("Remote or Hybrid"). */
function looksRemote(...values: Array<string | null | boolean | undefined>): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /\bhybrid\b|\bon-?site\b|\bin[- ]office\b/i.test(value)) return false;
    if (typeof value === "string" && /\bremote\b/i.test(value)) return true;
  }
  return null;
}

type RawPosting = Omit<JobApplyDiscoveredPosting, "tracked">;

function htmlText(value: string | undefined): string | null {
  const decoded = value?.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
  return text(decoded);
}

/** LinkedIn's guest search answers HTML job cards; the canonical /jobs/view/<id> URL dedupes the same posting across searches. */
function parseLinkedInCards(html: string, remote: boolean | null): RawPosting[] {
  return html.split(/<li[\s>]/).flatMap((card) => {
    const id = card.match(/urn:li:jobPosting:(\d+)/)?.[1];
    const role = htmlText(card.match(/base-search-card__title[^>]*>([^<]+)</)?.[1]);
    if (!id || !role) return [];
    const company = htmlText(card.match(/base-search-card__subtitle[^>]*>\s*(?:<a[^>]*>)?([^<]+)</)?.[1]) ?? "LinkedIn";
    const slug = card.match(/linkedin\.com\/company\/([^?"/]+)/)?.[1];
    return [{ url: `https://www.linkedin.com/jobs/view/${id}`, ats: "linkedin" as const, board: (slug ?? company).slice(0, 120), company: company.slice(0, 200),
      role: role.slice(0, 300), location: htmlText(card.match(/job-search-card__location[^>]*>([^<]+)</)?.[1])?.slice(0, 200) ?? null,
      remote, postedAt: iso(card.match(/datetime="([^"]+)"/)?.[1]) }];
  });
}

/** Each ATS payload becomes the same shape; unknown fields are ignored, broken entries skipped. */
export function parseBoardPayload(ats: JobApplyDiscoverySite, board: string, payload: unknown, now = Date.now(), remoteSearch = true): RawPosting[] {
  const company = titleCase(board);
  if (ats === "linkedin") return typeof payload === "string" ? parseLinkedInCards(payload, remoteSearch ? true : null) : [];
  if (ats === "workable") {
    const jobs = payload && typeof payload === "object" && Array.isArray((payload as { jobs?: unknown }).jobs) ? (payload as { jobs: unknown[] }).jobs : [];
    return jobs.flatMap((job) => {
      const entry = job as { title?: unknown; url?: unknown; state?: unknown; workplace?: unknown; created?: unknown; company?: { title?: unknown }; location?: { city?: unknown; countryName?: unknown } };
      const url = text(entry.url); const role = text(entry.title);
      if (!url || !role || (entry.state !== undefined && entry.state !== "published")) return [];
      const name = text(entry.company?.title) ?? "Workable";
      const place = [text(entry.location?.city), text(entry.location?.countryName)].filter(Boolean).join(", ") || null;
      return [{ url, ats, board: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "workable", company: name.slice(0, 200), role: role.slice(0, 300),
        location: place, remote: typeof entry.workplace === "string" ? entry.workplace === "remote" : null, postedAt: iso(entry.created) }];
    });
  }
  if (ats === "himalayas") {
    const jobs = payload && typeof payload === "object" && Array.isArray((payload as { jobs?: unknown }).jobs) ? (payload as { jobs: unknown[] }).jobs : [];
    return jobs.flatMap((job) => {
      const entry = job as { title?: unknown; guid?: unknown; applicationLink?: unknown; companyName?: unknown; companySlug?: unknown; locationRestrictions?: unknown; pubDate?: unknown; expiryDate?: unknown };
      const url = text(entry.guid) ?? text(entry.applicationLink); const role = text(entry.title);
      if (!url || !role) return [];
      if (typeof entry.expiryDate === "number" && entry.expiryDate * 1000 < now) return [];
      // Goal 91e45be1: 54 of 55 "Worldwide"-labelled jobs were closed to Greece, so only the country list decides: empty, or naming Greece/the EU.
      const places = Array.isArray(entry.locationRestrictions) ? entry.locationRestrictions.filter((place): place is string => typeof place === "string") : [];
      const eligible = places.find((place) => /^(?:greece|eu|europe|european union)$/i.test(place.trim()));
      if (places.length > 0 && !eligible) return [];
      const slug = text(entry.companySlug) ?? board;
      return [{
        url, ats, board: slug.slice(0, 120), company: (text(entry.companyName) ?? titleCase(slug)).slice(0, 200), role: role.slice(0, 300),
        location: eligible ? `Remote (${eligible}${places.length > 1 ? ` and ${places.length - 1} more countries` : ""})` : "Remote",
        remote: true, postedAt: typeof entry.pubDate === "number" ? iso(entry.pubDate * 1000) : null
      }];
    });
  }
  if (ats === "greenhouse") {
    const jobs = payload && typeof payload === "object" && Array.isArray((payload as { jobs?: unknown }).jobs) ? (payload as { jobs: unknown[] }).jobs : [];
    return jobs.flatMap((job) => {
      const entry = job as { title?: unknown; absolute_url?: unknown; location?: { name?: unknown }; updated_at?: unknown; first_published?: unknown };
      const url = text(entry.absolute_url); const role = text(entry.title);
      if (!url || !role) return [];
      const location = text(entry.location?.name);
      return [{ url, ats, board, company, role: role.slice(0, 300), location, remote: looksRemote(location, role), postedAt: iso(entry.first_published ?? entry.updated_at) }];
    });
  }
  if (ats === "lever") {
    const jobs = Array.isArray(payload) ? payload : [];
    return jobs.flatMap((job) => {
      const entry = job as { text?: unknown; hostedUrl?: unknown; categories?: { location?: unknown }; workplaceType?: unknown; createdAt?: unknown };
      const url = text(entry.hostedUrl); const role = text(entry.text);
      if (!url || !role) return [];
      const location = text(entry.categories?.location);
      return [{ url, ats, board, company, role: role.slice(0, 300), location, remote: looksRemote(text(entry.workplaceType), location, role), postedAt: iso(entry.createdAt) }];
    });
  }
  const jobs = payload && typeof payload === "object" && Array.isArray((payload as { jobs?: unknown }).jobs) ? (payload as { jobs: unknown[] }).jobs : [];
  return jobs.flatMap((job) => {
    const entry = job as { title?: unknown; jobUrl?: unknown; location?: unknown; workplaceType?: unknown; isRemote?: unknown; publishedAt?: unknown };
    const url = text(entry.jobUrl); const role = text(entry.title);
    if (!url || !role) return [];
    const location = text(entry.location);
    return [{ url, ats, board, company, role: role.slice(0, 300), location, remote: looksRemote(text(entry.workplaceType), typeof entry.isRemote === "boolean" ? entry.isRemote : null, location, role), postedAt: iso(entry.publishedAt) }];
  });
}

/** `word` as a whole token: "go" drops "Backend (Go)" but not "Django"; an edge that is a symbol ("c#", ".net") needs no boundary. */
function hasWord(haystack: string, word: string): boolean {
  const letter = /[\p{L}\p{N}]/u;
  for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1)) {
    const end = at + word.length;
    if ((!letter.test(word[0]!) || !letter.test(haystack[at - 1] ?? " ")) && (!letter.test(word.at(-1)!) || !letter.test(haystack[end] ?? " "))) return true;
  }
  return false;
}

/** Postings older than this are mostly closed (goal 91e45be1: 15 queued postings from Dec 2025 to Apr 2026 answered 404/410). */
const MAX_POSTING_AGE_MS = 30 * 86_400_000;
// shortcut: Greece/EU is the operator's work authorization, hardcoded; read the candidate profile's country when another candidate uses discovery.
const ELIGIBLE_PLACE = /\b(?:greece|athens|eu|europe|european union|emea|worldwide|anywhere|global(?:ly)?)\b/;
/** Words a "remote" location qualifier may carry that name no place ("Remote, fully distributed", "Remote (UTC+2)"). */
const NOT_A_PLACE = new Set(["remote", "remotely", "fully", "full", "time", "first", "from", "home", "work", "wfh", "distributed", "flexible", "or", "and", "in", "the", "any", "timezone", "timezones", "zone", "zones", "utc", "gmt", "cet", "cest", "eet", "eest"]);

/** A remote posting closed to Greece by its own words: "<place> only", residency wording, or a remote qualifier naming another place ("Remote (Brazil)"). */
function geofenced(posting: RawPosting, wanted: string | undefined): boolean {
  const location = (posting.location ?? "").toLowerCase();
  const allows = (value: string) => ELIGIBLE_PLACE.test(value) || (wanted !== undefined && value.includes(wanted));
  const restricts = (value: string) => /\bonly\b|\bresidents?\b|\bcitizens?\b|\bbased in\b|\bmust (?:live|reside)\b/.test(value) && !allows(value);
  if (restricts(posting.role.toLowerCase()) || restricts(location)) return true;
  if (!/\bremote\b/.test(location) || allows(location)) return false;
  return (location.match(/\p{L}+/gu) ?? []).some((word) => !NOT_A_PLACE.has(word));
}

export function matchesQuery(posting: RawPosting, input: Pick<JobApplyDiscoverRequest, "query" | "location" | "remote" | "exclude">, now = Date.now()): boolean {
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const title = posting.role.toLowerCase();
  if (!words.every((word) => title.includes(word))) return false;
  // Goal 91e45be1 (jobrun:FxwhONTgsfU2): stacks off the CV and geofenced "remote" roles were queued, then failed as not eligible.
  const place = `${title} ${posting.location ?? ""}`.toLowerCase();
  if (input.exclude?.some((word) => hasWord(place, word.toLowerCase()))) return false;
  // Operator 27/11: every workplace (remote, hybrid, on-site, relocation); remote ranks first in search, remote: true asks for remote only.
  if (input.remote === true && posting.remote !== true) return false;
  const posted = posting.postedAt ? Date.parse(posting.postedAt) : Number.NaN;
  if (now - posted > MAX_POSTING_AGE_MS) return false;
  if (posting.remote === true && geofenced(posting, input.location?.toLowerCase())) return false;
  if (input.location) {
    const wanted = input.location.toLowerCase();
    const haystack = `${posting.location ?? ""} ${posting.role}`.toLowerCase();
    if (!haystack.includes(wanted) && !(posting.remote === true && input.remote !== false)) return false;
  }
  return true;
}

export function createDiscovery(options: DiscoveryOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
  const userAgent = options.userAgent ?? "SpaceJobCopilot/2.0 (+http://127.0.0.1:4911)";

  async function fetchBody(url: string, html = false): Promise<{ payload: unknown; error: string | null }> {
    try {
      const response = await fetchImpl(url, { headers: { accept: html ? "text/html" : "application/json", "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 404) return { payload: null, error: "no board" };
      if (!response.ok) return { payload: null, error: `HTTP ${response.status}` };
      return { payload: html ? await response.text() : await response.json(), error: null };
    } catch (error) {
      return { payload: null, error: error instanceof Error ? error.name === "TimeoutError" ? "timeout" : error.message.slice(0, 120) : "fetch failed" };
    }
  }

  /** The matching postings of one board, or of a search paged until its last page, or until one more match than `limit` shows the result
   *  is truncated. A failed page keeps what the earlier pages found (LinkedIn answers 429 after about 3 pages). */
  async function board(ats: JobApplyDiscoverySite, token: string, input: SearchInput, keep: (posting: RawPosting) => boolean, limit: number): Promise<{ postings: RawPosting[]; error: string | null }> {
    if (!SEARCH_SITES.includes(ats)) {
      const { payload, error } = await fetchBody(BOARD_URL[ats as BoardSite](token));
      return { postings: error ? [] : parseBoardPayload(ats, token, payload).filter(keep), error };
    }
    const site = ats as SearchSite;
    const postings: RawPosting[] = [];
    let cursor: string | null = null;
    for (let page = 1; ; page++) {
      const { payload, error } = await fetchBody(SEARCH_URL[site](input, page, cursor), site === "linkedin");
      if (error) return { postings, error };
      const parsed = parseBoardPayload(ats, token, payload, Date.now(), input.remote === true);
      postings.push(...parsed.filter(keep));
      const jobs = site === "himalayas" ? (payload as { jobs?: unknown } | null)?.jobs : null;
      cursor = site === "workable" ? text((payload as { nextPageToken?: unknown } | null)?.nextPageToken) : null;
      const more = site === "workable" ? cursor !== null : (site === "himalayas" ? (Array.isArray(jobs) ? jobs.length : 0) : parsed.length) >= SEARCH_PAGE_SIZE[site];
      if (!more || postings.length > limit) return { postings, error: null };
    }
  }

  return {
    /** `tokensByAts` are the boards to scan; `isTracked` marks URLs already in the tracker. */
    async search(raw: JobApplyDiscoverRequest, extraTokens: Array<{ ats: JobApplyDiscoverySite; token: string }>, isTracked: (url: string) => Promise<boolean>): Promise<JobApplyDiscoverResult> {
      const input = jobApplyDiscoverRequestSchema.parse(raw);
      const targets = new Map<string, { ats: JobApplyDiscoverySite; token: string }>();
      for (const ats of input.sites) if (!SEARCH_SITES.includes(ats)) for (const token of input.tokens) targets.set(`${ats}:${token.toLowerCase()}`, { ats, token: token.toLowerCase() });
      for (const extra of extraTokens) if (input.sites.includes(extra.ats)) targets.set(`${extra.ats}:${extra.token.toLowerCase()}`, { ats: extra.ats, token: extra.token.toLowerCase() });
      const scanned: JobApplyDiscoverResult["scanned"] = [];
      // Himalayas, LinkedIn and Workable are one search by the query each, not a board per token.
      for (const ats of SEARCH_SITES) if (input.sites.includes(ats)) {
        if (input.query) targets.set(`${ats}:`, { ats, token: input.query });
        else scanned.push({ ats, board: "search", count: 0, error: "needs a query" });
      }
      const queue = [...targets.values()];
      const found: RawPosting[] = [];
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (;;) {
          const target = queue[index++];
          if (!target) return;
          const result = await board(target.ats, target.token, { query: target.token, location: input.location, remote: input.remote }, (posting) => matchesQuery(posting, input), input.limit);
          scanned.push({ ats: target.ats, board: target.token, count: result.postings.length, error: result.error });
          found.push(...result.postings);
        }
      }));
      const seen = new Set<string>();
      const unique = found.filter((posting) => { if (seen.has(posting.url)) return false; seen.add(posting.url); return true; })
        .sort((left, right) => Number(right.remote === true) - Number(left.remote === true) || (right.postedAt ?? "").localeCompare(left.postedAt ?? "") || left.company.localeCompare(right.company) || left.role.localeCompare(right.role));
      const postings: JobApplyDiscoveredPosting[] = [];
      for (const posting of unique.slice(0, input.limit)) postings.push({ ...posting, tracked: await isTracked(posting.url) });
      return { postings, scanned: scanned.sort((left, right) => left.ats.localeCompare(right.ats) || left.board.localeCompare(right.board)), truncated: unique.length > input.limit };
    }
  };
}
export type Discovery = ReturnType<typeof createDiscovery>;
