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

const BOARD_URL: Record<JobApplyDiscoverySite, (token: string) => string> = {
  greenhouse: (token) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`,
  lever: (token) => `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
  ashby: (token) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`
};

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
function looksRemote(...values: Array<string | null | boolean | undefined>): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "string" && /\bremote\b/i.test(value)) return true;
  }
  return null;
}

type RawPosting = Omit<JobApplyDiscoveredPosting, "tracked">;

/** Each ATS payload becomes the same shape; unknown fields are ignored, broken entries skipped. */
export function parseBoardPayload(ats: JobApplyDiscoverySite, board: string, payload: unknown): RawPosting[] {
  const company = titleCase(board);
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
      const workplace = text(entry.workplaceType);
      return [{ url, ats, board, company, role: role.slice(0, 300), location, remote: workplace ? workplace.toLowerCase() === "remote" : looksRemote(location, role), postedAt: iso(entry.createdAt) }];
    });
  }
  const jobs = payload && typeof payload === "object" && Array.isArray((payload as { jobs?: unknown }).jobs) ? (payload as { jobs: unknown[] }).jobs : [];
  return jobs.flatMap((job) => {
    const entry = job as { title?: unknown; jobUrl?: unknown; location?: unknown; isRemote?: unknown; publishedAt?: unknown };
    const url = text(entry.jobUrl); const role = text(entry.title);
    if (!url || !role) return [];
    const location = text(entry.location);
    return [{ url, ats, board, company, role: role.slice(0, 300), location, remote: typeof entry.isRemote === "boolean" ? entry.isRemote : looksRemote(location, role), postedAt: iso(entry.publishedAt) }];
  });
}

export function matchesQuery(posting: RawPosting, input: Pick<JobApplyDiscoverRequest, "query" | "location" | "remote">): boolean {
  const words = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const title = posting.role.toLowerCase();
  if (!words.every((word) => title.includes(word))) return false;
  if (input.remote === true && posting.remote !== true) return false;
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

  async function board(ats: JobApplyDiscoverySite, token: string): Promise<{ postings: RawPosting[]; error: string | null }> {
    try {
      const response = await fetchImpl(BOARD_URL[ats](token), { headers: { accept: "application/json", "user-agent": userAgent }, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 404) return { postings: [], error: "no board" };
      if (!response.ok) return { postings: [], error: `HTTP ${response.status}` };
      return { postings: parseBoardPayload(ats, token, await response.json()), error: null };
    } catch (error) {
      return { postings: [], error: error instanceof Error ? error.name === "TimeoutError" ? "timeout" : error.message.slice(0, 120) : "fetch failed" };
    }
  }

  return {
    /** `tokensByAts` are the boards to scan; `isTracked` marks URLs already in the tracker. */
    async search(raw: JobApplyDiscoverRequest, extraTokens: Array<{ ats: JobApplyDiscoverySite; token: string }>, isTracked: (url: string) => Promise<boolean>): Promise<JobApplyDiscoverResult> {
      const input = jobApplyDiscoverRequestSchema.parse(raw);
      const targets = new Map<string, { ats: JobApplyDiscoverySite; token: string }>();
      for (const ats of input.sites) for (const token of input.tokens) targets.set(`${ats}:${token.toLowerCase()}`, { ats, token: token.toLowerCase() });
      for (const extra of extraTokens) if (input.sites.includes(extra.ats)) targets.set(`${extra.ats}:${extra.token.toLowerCase()}`, { ats: extra.ats, token: extra.token.toLowerCase() });
      const queue = [...targets.values()];
      const scanned: JobApplyDiscoverResult["scanned"] = [];
      const found: RawPosting[] = [];
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (;;) {
          const target = queue[index++];
          if (!target) return;
          const result = await board(target.ats, target.token);
          const matching = result.postings.filter((posting) => matchesQuery(posting, input));
          scanned.push({ ats: target.ats, board: target.token, count: matching.length, error: result.error });
          found.push(...matching);
        }
      }));
      const seen = new Set<string>();
      const unique = found.filter((posting) => { if (seen.has(posting.url)) return false; seen.add(posting.url); return true; })
        .sort((left, right) => (right.postedAt ?? "").localeCompare(left.postedAt ?? "") || left.company.localeCompare(right.company) || left.role.localeCompare(right.role));
      const postings: JobApplyDiscoveredPosting[] = [];
      for (const posting of unique.slice(0, input.limit)) postings.push({ ...posting, tracked: await isTracked(posting.url) });
      return { postings, scanned: scanned.sort((left, right) => left.ats.localeCompare(right.ats) || left.board.localeCompare(right.board)), truncated: unique.length > input.limit };
    }
  };
}
export type Discovery = ReturnType<typeof createDiscovery>;
