import type { SecurityInventory } from "@space/contracts";
import { parseFeed, parseNvdCve, parseOsvVuln, PRODUCT_CPE, type KevEntry, type NewsItem, type NvdCve, type OsvVuln } from "./matcher.js";

// Security Copilot feed readers (plan clipboard:8ce8_URHW9Dk step 4). The hosts are fixed constants, not user URLs, so the global
// fetch with a timeout is enough (link-inspect-routes.ts does the same); a body that does not parse counts as a feed error.

export type FeedFetch = (url: string, init?: { method?: "GET" | "POST"; body?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** CISA's own GitHub copy of the KEV catalogue: cisa.gov answers 403 to this server (checked 2026-10-24). */
export const KEV_URL = "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json";
export const NEWS_FEEDS: ReadonlyArray<{ name: string; url: string }> = [
  { name: "oss-security", url: "https://seclists.org/rss/oss-sec.rss" },
  { name: "Debian DSA", url: "https://www.debian.org/security/dsa" },
  { name: "Ubuntu USN", url: "https://ubuntu.com/security/notices/rss.xml" },
  { name: "PHP releases", url: "https://www.php.net/releases/feed.php" },
  { name: "Node.js vulnerabilities", url: "https://nodejs.org/en/feed/vulnerability.xml" },
  { name: "Chrome releases", url: "https://chromereleases.googleblog.com/feeds/posts/default" },
  { name: "Proxmox announcements", url: "https://forum.proxmox.com/forums/announcements.7/index.rss" }
];
const USER_AGENT = "SpaceApp-SecurityCopilot/1 (+https://spaceapp.dev)";
const OSV_BATCH = 1000;

export const defaultFeedFetch: FeedFetch = (url, init) => fetch(url, {
  method: init?.method ?? "GET", body: init?.body, headers: { "user-agent": USER_AGENT, accept: "application/json, application/xml, text/xml, */*", ...init?.headers },
  redirect: "follow", signal: AbortSignal.timeout(45_000)
});

export interface FeedState { lastOkAt: string | null; lastError: string | null }

/** The feed readers with their last success and error (shown on the pane and to Nous). */
export function createFeeds(fetchImpl: FeedFetch = defaultFeedFetch, now: () => number = Date.now) {
  const state = new Map<string, FeedState>();
  async function read(name: string, url: string, init?: Parameters<FeedFetch>[1]): Promise<string> {
    try {
      const response = await fetchImpl(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      state.set(name, { lastOkAt: new Date(now()).toISOString(), lastError: null });
      return text;
    } catch (error) {
      state.set(name, { lastOkAt: state.get(name)?.lastOkAt ?? null, lastError: error instanceof Error ? error.message.slice(0, 200) : "failed" });
      throw error;
    }
  }
  const json = async (name: string, url: string, init?: Parameters<FeedFetch>[1]) => {
    const text = await read(name, url, init);
    try { return JSON.parse(text) as unknown; } catch {
      state.set(name, { lastOkAt: null, lastError: "The answer was not JSON." });
      throw new Error(`${name} answered something that is not JSON.`);
    }
  };

  return {
    state: () => Object.fromEntries(state),
    async kev(): Promise<Map<string, KevEntry>> {
      const body = await json("KEV", KEV_URL) as { vulnerabilities?: KevEntry[] };
      if (!Array.isArray(body.vulnerabilities)) throw new Error("KEV has no vulnerabilities list.");
      return new Map(body.vulnerabilities.filter((entry) => typeof entry?.cveID === "string").map((entry) => [entry.cveID, entry]));
    },
    /** CVEs of one product modified in the window (NVD allows 120 days per query); one page of 2000 is plenty for 30 minutes. */
    async nvdModified(product: keyof typeof PRODUCT_CPE, since: Date, until: Date): Promise<NvdCve[]> {
      const cpe = PRODUCT_CPE[product];
      if (!cpe) return [];
      const params = new URLSearchParams({ virtualMatchString: cpe, lastModStartDate: since.toISOString(), lastModEndDate: until.toISOString() });
      const body = await json("NVD", `https://services.nvd.nist.gov/rest/json/cves/2.0?${params}`) as { vulnerabilities?: unknown[] };
      return (body.vulnerabilities ?? []).map(parseNvdCve).filter((cve): cve is NvdCve => cve !== null);
    },
    async nvdCve(id: string): Promise<NvdCve | null> {
      if (!/^CVE-\d{4}-\d{4,8}$/.test(id)) return null;
      const body = await json("NVD", `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${id}`) as { vulnerabilities?: unknown[] };
      return body.vulnerabilities?.[0] ? parseNvdCve(body.vulnerabilities[0]) : null;
    },
    /** OSV ids per library (querybatch answers ids only), then each distinct record once. */
    async osvLibraries(libraries: SecurityInventory["libraries"]): Promise<Array<{ library: SecurityInventory["libraries"][number]; vuln: OsvVuln }>> {
      const hits: Array<{ library: SecurityInventory["libraries"][number]; id: string }> = [];
      for (let start = 0; start < libraries.length; start += OSV_BATCH) {
        const batch = libraries.slice(start, start + OSV_BATCH);
        const body = await json("OSV", "https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ queries: batch.map((library) => ({ package: { name: library.name, ecosystem: library.ecosystem }, version: library.version })) }) }) as { results?: Array<{ vulns?: Array<{ id?: string }> }> };
        (body.results ?? []).forEach((result, index) => { for (const vuln of result.vulns ?? []) if (typeof vuln.id === "string") hits.push({ library: batch[index]!, id: vuln.id }); });
      }
      const records = new Map<string, unknown>();
      for (const id of new Set(hits.map((hit) => hit.id))) {
        if (records.size >= 300) break;
        records.set(id, await json("OSV", `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`).catch(() => null));
      }
      return hits.flatMap((hit) => {
        const vuln = records.get(hit.id) ? parseOsvVuln(records.get(hit.id), hit.library.name) : null;
        return vuln ? [{ library: hit.library, vuln }] : [];
      });
    },
    /** CVE aliases of Debian's advisories for source packages that have a security update waiting (OSV Debian ecosystem). */
    async debianCves(release: string, packages: Array<{ source: string; version: string }>): Promise<Map<string, string[]>> {
      const out = new Map<string, string[]>();
      if (!packages.length || !/^\d+$/.test(release)) return out;
      const body = await json("OSV", "https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: packages.slice(0, OSV_BATCH).map((pkg) => ({ package: { name: pkg.source, ecosystem: `Debian:${release}` }, version: pkg.version })) }) }) as { results?: Array<{ vulns?: Array<{ id?: string }> }> };
      (body.results ?? []).forEach((result, index) => {
        const ids = (result.vulns ?? []).map((vuln) => vuln.id).filter((id): id is string => typeof id === "string");
        // Debian's OSV ids are DSA-/DLA- advisories and DEBIAN-CVE-* records; the CVE id is inside the latter.
        const cves = [...new Set(ids.map((id) => /CVE-\d{4}-\d{4,8}/.exec(id)?.[0]).filter((id): id is string => Boolean(id)))];
        if (cves.length) out.set(packages[index]!.source, cves.slice(0, 40));
      });
      return out;
    },
    async internetDb(ip: string): Promise<{ ports: number[]; vulns: string[] }> {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return { ports: [], vulns: [] };
      const body = await json("InternetDB", `https://internetdb.shodan.io/${ip}`).catch((error: Error) => (/404/.test(error.message) ? {} : Promise.reject(error))) as { ports?: number[]; vulns?: string[] };
      return { ports: (body.ports ?? []).filter((port) => Number.isInteger(port)), vulns: (body.vulns ?? []).filter((id) => typeof id === "string") };
    },
    /** Every news feed's items of the last `days` days (a failing feed is skipped and recorded). */
    async news(days: number): Promise<NewsItem[]> {
      const since = now() - days * 86_400_000;
      const items: NewsItem[] = [];
      for (const feed of NEWS_FEEDS) {
        const xml = await read(`news:${feed.name}`, feed.url).catch(() => null);
        if (xml) items.push(...parseFeed(feed.name, xml).filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= since));
      }
      return items;
    }
  };
}
export type SecurityFeeds = ReturnType<typeof createFeeds>;
