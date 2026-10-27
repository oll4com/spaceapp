import { securityAdvisoryUrlAllowed, type SecurityAdvisory, type SecurityInventory, type SecurityPriority, type SecurityProduct, type SecuritySeverity } from "@space/contracts";

// Security Copilot matching (plan clipboard:8ce8_URHW9Dk step 4): pure functions that turn an inventory and the public feeds
// into finding records. Distro security metadata (dnf updateinfo, apt's security origin) is the truth for distro packages; NVD
// CPE ranges are used only for software outside a distro's metadata (PHP builds, Node, Chrome, Proxmox VE); OSV covers the npm
// and PyPI libraries; KEV marks what is exploited. Third-party free text never reaches a finding: titles are built here.

export interface KevEntry { cveID: string; vendorProject: string; product: string; dateAdded: string }
export interface CpeRange { criteria: string; vulnerable: boolean; versionStartIncluding?: string; versionStartExcluding?: string; versionEndIncluding?: string; versionEndExcluding?: string }
export interface NvdCve { id: string; published: string | null; cvss: number | null; severity: SecuritySeverity; ranges: CpeRange[] }
export interface OsvVuln { id: string; aliases: string[]; severity: SecuritySeverity; cvss: number | null; fixed: string | null; published: string | null }
export interface NewsItem { feed: string; link: string; title: string; publishedAt: string | null; cves: string[] }
export interface FindingDraft { advisoryId: string; advisory: SecurityAdvisory; package: string; installedVersion: string; fixedVersion: string | null; priority: SecurityPriority }

/** NVD product per inventory product (cpe:2.3:a:<vendor>:<product>). */
export const PRODUCT_CPE: Partial<Record<SecurityProduct, string>> = {
  php: "cpe:2.3:a:php:php", node: "cpe:2.3:a:nodejs:node.js", chrome: "cpe:2.3:a:google:chrome", proxmox_ve: "cpe:2.3:a:proxmox:virtual_environment"
};
/** Words a news headline names a product by, mapped to what the inventory calls it (products, then distro package names). */
export const NEWS_KEYWORDS: Record<string, { products?: SecurityProduct[]; packages?: RegExp }> = {
  php: { products: ["php"], packages: /^(php[0-9.]*|plesk-php\d+)(-|$)/ }, "node.js": { products: ["node"], packages: /^nodejs$/ }, nodejs: { products: ["node"], packages: /^nodejs$/ },
  chrome: { products: ["chrome"] }, proxmox: { products: ["proxmox_ve"] }, openssh: { packages: /^openssh(-server)?$/ }, openssl: { packages: /^(openssl|libssl3t?6?4?)$/ },
  nginx: { packages: /^nginx(-common)?$/ }, exim: { packages: /^exim4?(-base|-daemon-light)?$/ }, postfix: { packages: /^postfix$/ }, dovecot: { packages: /^dovecot(-core)?$/ },
  sudo: { packages: /^sudo$/ }, glibc: { packages: /^(glibc|libc6)$/ }, "linux kernel": { packages: /^(kernel|linux-image-amd64|proxmox-kernel.*)$/ }, docker: { packages: /^(docker\.io|docker-ce)$/ },
  postgresql: { packages: /^postgresql(-\d+)?$/ }, apache: { packages: /^(apache2|httpd)$/ }, plesk: { packages: /^plesk-core$/ }
};
const CVE = /CVE-\d{4}-\d{4,8}/g;
const EXPLOITED = /\b(actively exploited|exploited in the wild|zero-day|0-day|in the wild)\b/i;
const SERIOUS = /\b(critical|remote code execution|rce|unauthenticated|arbitrary code)\b/i;

/** Compares dotted numeric versions (1.10 > 1.9); a non-numeric tail compares as text. */
export function compareVersions(left: string, right: string): number {
  const split = (version: string) => version.split(/[.\-+~_]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const a = split(left);
  const b = split(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** Whether `version` of the product named by `cpeBase` falls inside one vulnerable NVD configuration entry. */
export function cpeRangeMatches(range: CpeRange, cpeBase: string, version: string): boolean {
  if (!range.vulnerable || !range.criteria.startsWith(`${cpeBase}:`)) return false;
  const exact = range.criteria.slice(cpeBase.length + 1).split(":")[0] ?? "*";
  if (exact !== "*" && exact !== "-") return compareVersions(version, exact) === 0;
  const bounded = range.versionStartIncluding || range.versionStartExcluding || range.versionEndIncluding || range.versionEndExcluding;
  if (!bounded) return false;
  if (range.versionStartIncluding && compareVersions(version, range.versionStartIncluding) < 0) return false;
  if (range.versionStartExcluding && compareVersions(version, range.versionStartExcluding) <= 0) return false;
  if (range.versionEndIncluding && compareVersions(version, range.versionEndIncluding) > 0) return false;
  if (range.versionEndExcluding && compareVersions(version, range.versionEndExcluding) >= 0) return false;
  return true;
}

/** The first fixed version for this product line: the smallest end bound above the installed version. */
function fixedFor(ranges: CpeRange[], cpeBase: string, version: string): string | null {
  const ends = ranges.filter((range) => cpeRangeMatches(range, cpeBase, version) && range.versionEndExcluding).map((range) => range.versionEndExcluding!);
  return ends.sort(compareVersions)[0] ?? null;
}

export function severityOfScore(score: number | null): SecuritySeverity {
  if (score === null) return "UNKNOWN";
  return score >= 9 ? "CRITICAL" : score >= 7 ? "HIGH" : score >= 4 ? "MEDIUM" : "LOW";
}

/** P0 exploited (KEV); P1 critical; P2 high (and distro security updates of unknown weight); P3 the rest. */
export function priorityOf(advisory: Pick<SecurityAdvisory, "kev" | "severity">, exploitedNews = false): SecurityPriority {
  if (advisory.kev || exploitedNews) return "P0";
  if (advisory.severity === "CRITICAL") return "P1";
  if (advisory.severity === "HIGH" || advisory.severity === "UNKNOWN") return "P2";
  return "P3";
}

const advisory = (input: Partial<SecurityAdvisory> & Pick<SecurityAdvisory, "id" | "sources" | "title" | "severity">): SecurityAdvisory => ({
  aliases: [], cvss: null, epss: null, kev: false, kevAddedAt: null, publishedAt: null, references: [], ...input
});
function withKev(base: SecurityAdvisory, kev: Map<string, KevEntry>): SecurityAdvisory {
  const hit = [base.id, ...base.aliases].map((id) => kev.get(id)).find(Boolean);
  return hit ? { ...base, kev: true, kevAddedAt: hit.dateAdded, sources: [...new Set([...base.sources, "KEV" as const])] } : base;
}
const installed = (inventory: SecurityInventory, name: string) => inventory.packages.find((pkg) => pkg.name === name)?.version ?? "";

/** Distro security updates the host's own package manager lists: one finding per advisory (dnf) or per source package (apt). */
export function distroFindings(inventory: SecurityInventory, kev: Map<string, KevEntry>, debianCves: Map<string, string[]> = new Map()): FindingDraft[] {
  const drafts = new Map<string, FindingDraft>();
  const sourceOf = new Map(inventory.packages.map((pkg) => [pkg.name, pkg.source ?? pkg.name]));
  for (const entry of inventory.pendingSecurity) {
    if (entry.advisory) {
      // One finding per advisory: the shortest package name (kernel over kernel-core) with every CVE of its lines.
      const existing = drafts.get(entry.advisory);
      const aliases = [...new Set([...(existing?.advisory.aliases ?? []), ...entry.cves])].slice(0, 40);
      if (existing && existing.package.length <= entry.package.length) { existing.advisory.aliases = aliases; continue; }
      drafts.set(entry.advisory, { advisoryId: entry.advisory, package: entry.package, installedVersion: installed(inventory, entry.package), fixedVersion: entry.version ?? null, priority: "P3",
        advisory: advisory({ id: entry.advisory, aliases, sources: ["DISTRO"], title: `${inventory.os.family === "ALMALINUX" ? "AlmaLinux" : "Distro"} security update for ${entry.package}`, severity: entry.severity }) });
      continue;
    }
    const source = sourceOf.get(entry.package) ?? entry.package;
    const id = `DEBSEC:${source}`;
    if (drafts.has(id)) continue;
    drafts.set(id, { advisoryId: id, package: source, installedVersion: installed(inventory, entry.package), fixedVersion: entry.version ?? null, priority: "P3",
      advisory: advisory({ id, aliases: (debianCves.get(source) ?? []).slice(0, 40), sources: ["DISTRO"], title: `Debian security update for ${source}`, severity: entry.severity }) });
  }
  // KEV and the priority only once every line's CVEs are in.
  return [...drafts.values()].map((draft) => { const enriched = withKev(draft.advisory, kev); return { ...draft, advisory: enriched, priority: priorityOf(enriched) }; });
}

/**
 * Software outside the distro's metadata against NVD CPE ranges: one finding per product binary (Chrome alone has hundreds of
 * CVEs a month and one upgrade fixes them all), keyed `NVD:<product>`, with the CVEs as aliases, the worst severity and KEV of
 * the group, and the release that fixes every one of them.
 */
export function productFindings(inventory: SecurityInventory, cves: NvdCve[], kev: Map<string, KevEntry>): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  const rank: Record<SecuritySeverity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
  for (const item of inventory.products) {
    const cpe = PRODUCT_CPE[item.product];
    if (!cpe) continue;
    const group = cves.filter((cve) => cve.ranges.some((range) => cpeRangeMatches(range, cpe, item.version)))
      .sort((left, right) => (right.cvss ?? 0) - (left.cvss ?? 0) || left.id.localeCompare(right.id));
    if (!group.length) continue;
    const ids = group.map((cve) => cve.id);
    const kevHit = ids.map((id) => kev.get(id)).find(Boolean);
    const worst = group.reduce<SecuritySeverity>((max, cve) => rank[cve.severity] > rank[max] ? cve.severity : max, "UNKNOWN");
    const fixes = group.map((cve) => fixedFor(cve.ranges, cpe, item.version));
    const fixed = fixes.includes(null) ? null : (fixes as string[]).sort(compareVersions).at(-1)!;
    const enriched = advisory({ id: `NVD:${item.product}`, aliases: [...(kevHit ? [kevHit.cveID] : []), ...ids.filter((cve) => cve !== kevHit?.cveID)].slice(0, 40),
      sources: kevHit ? ["NVD", "KEV"] : ["NVD"], kev: Boolean(kevHit), kevAddedAt: kevHit?.dateAdded ?? null,
      title: `${item.product} ${item.version} has ${group.length} known CVE${group.length === 1 ? "" : "s"}${fixed ? `; ${fixed} fixes ${group.length === 1 ? "it" : "them all"}` : ""} (worst ${ids[0]})`,
      severity: worst, cvss: group[0]!.cvss, publishedAt: group[0]!.published, references: ids.slice(0, 5).map((cve) => `https://nvd.nist.gov/vuln/detail/${cve}`) });
    drafts.push({ advisoryId: enriched.id, advisory: enriched, package: item.path ? `${item.product}:${item.path}` : item.product, installedVersion: item.version,
      fixedVersion: fixed, priority: priorityOf(enriched) });
  }
  return drafts;
}

/** npm and PyPI libraries against OSV (the query already chose the vulnerable versions). */
export function libraryFindings(hits: Array<{ library: SecurityInventory["libraries"][number]; vuln: OsvVuln }>, kev: Map<string, KevEntry>): FindingDraft[] {
  return hits.map(({ library, vuln }) => {
    const cve = vuln.aliases.find((alias) => /^CVE-/.test(alias));
    const enriched = withKev(advisory({ id: vuln.id, aliases: vuln.aliases.slice(0, 40), sources: ["OSV"], title: `${library.ecosystem} ${library.name} ${library.version} is affected by ${cve ?? vuln.id}`,
      severity: vuln.severity, cvss: vuln.cvss, publishedAt: vuln.published, references: [`https://osv.dev/vulnerability/${vuln.id}`] }), kev);
    return { advisoryId: vuln.id, advisory: enriched, package: `${library.ecosystem}:${library.name}`, installedVersion: library.version, fixedVersion: vuln.fixed, priority: priorityOf(enriched) };
  });
}

/** CVE ids Shodan's InternetDB lists for a public address the host serves. */
export function exposureFindings(ip: string, vulns: string[], kev: Map<string, KevEntry>): FindingDraft[] {
  return vulns.filter((id) => /^CVE-\d{4}-\d{4,8}$/.test(id)).slice(0, 100).map((id) => {
    const enriched = withKev(advisory({ id, sources: ["INTERNETDB"], title: `Seen from the internet on ${ip}: ${id}`, severity: "UNKNOWN", references: [`https://nvd.nist.gov/vuln/detail/${id}`] }), kev);
    return { advisoryId: id, advisory: enriched, package: `exposed:${ip}`, installedVersion: "", fixedVersion: null, priority: priorityOf(enriched) };
  });
}

/**
 * News headlines that name a product the host runs: a lead (source NEWS) until a structured source or a vendor page confirms it.
 * The title is built here from the feed name, the CVE ids and the keyword: a headline's own words never reach the agent.
 */
export function newsFindings(inventory: SecurityInventory, items: NewsItem[], kev: Map<string, KevEntry>): FindingDraft[] {
  const drafts: FindingDraft[] = [];
  for (const item of items) {
    const text = item.title.toLowerCase();
    for (const [keyword, match] of Object.entries(NEWS_KEYWORDS)) {
      if (!new RegExp(`\\b${keyword.replace(/[.]/g, "\\.")}\\b`, "i").test(text)) continue;
      const product = inventory.products.find((entry) => match.products?.includes(entry.product));
      const pkg = product ? null : match.packages ? inventory.packages.find((entry) => match.packages!.test(entry.name)) : null;
      if (!product && !pkg) continue;
      const id = item.cves[0] ?? `NEWS-${Buffer.from(item.link).toString("base64url").slice(-16)}`;
      const exploited = EXPLOITED.test(item.title);
      const enriched = withKev(advisory({ id, aliases: item.cves.slice(1, 40), sources: ["NEWS"], title: `${item.feed}: ${item.cves.slice(0, 3).join(", ") || "an advisory"} names ${keyword}${exploited ? " (exploited)" : ""}`,
        severity: SERIOUS.test(item.title) ? "CRITICAL" : "UNKNOWN", publishedAt: item.publishedAt,
        // A headline's link is text a third party may write (a forum thread's slug): only an allowlisted vendor page, else the CVE's NVD page.
        references: securityAdvisoryUrlAllowed(item.link) ? [item.link] : item.cves.slice(0, 3).map((cve) => `https://nvd.nist.gov/vuln/detail/${cve}`) }), kev);
      drafts.push({ advisoryId: id, advisory: enriched, package: product ? product.product : pkg!.name, installedVersion: product?.version ?? pkg!.version, fixedVersion: null,
        priority: priorityOf(enriched, exploited) === "P2" ? "P3" : priorityOf(enriched, exploited) });
    }
  }
  return drafts;
}

// ---- feed parsers -----------------------------------------------------------------------------------
const decode = (text: string) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
const tag = (block: string, name: string) => { const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block); return match ? decode(match[1]!) : null; };

/** RSS items or Atom entries: title, link, date and the CVE ids in title and link. */
export function parseFeed(feed: string, xml: string): NewsItem[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
  return blocks.slice(0, 200).map((block) => {
    const title = (tag(block, "title") ?? "").replace(/\s+/g, " ").slice(0, 300);
    const link = tag(block, "link") || /<link\b[^>]*href="([^"]+)"/i.exec(block)?.[1] || "";
    const date = tag(block, "pubDate") ?? tag(block, "updated") ?? tag(block, "published") ?? tag(block, "dc:date");
    const parsed = date ? Date.parse(date) : NaN;
    return { feed, link: decode(link), title, publishedAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(), cves: [...new Set(`${title} ${link}`.match(CVE) ?? [])] };
  }).filter((item) => item.title && /^https?:\/\//.test(item.link));
}

/** One NVD 2.0 record: CVSS (v3.1, else v4.0, else v3.0) and its CPE match entries. */
export function parseNvdCve(raw: unknown): NvdCve | null {
  const cve = (raw as { cve?: Record<string, unknown> })?.cve;
  if (!cve || typeof cve.id !== "string") return null;
  const metrics = (cve.metrics ?? {}) as Record<string, Array<{ cvssData?: { baseScore?: number } }>>;
  const score = ["cvssMetricV31", "cvssMetricV40", "cvssMetricV30"].map((key) => metrics[key]?.find((entry) => typeof entry.cvssData?.baseScore === "number")?.cvssData?.baseScore)
    .find((value) => typeof value === "number") ?? null;
  const ranges: CpeRange[] = [];
  for (const configuration of (cve.configurations ?? []) as Array<{ nodes?: Array<{ cpeMatch?: CpeRange[] }> }>) {
    for (const node of configuration.nodes ?? []) for (const match of node.cpeMatch ?? []) if (typeof match.criteria === "string") ranges.push(match);
  }
  return { id: cve.id, published: typeof cve.published === "string" ? cve.published : null, cvss: score, severity: severityOfScore(score), ranges };
}

/** One OSV record: aliases, the highest CVSS-like severity it states and the first fixed version for the package. */
export function parseOsvVuln(raw: unknown, packageName: string): OsvVuln | null {
  const vuln = raw as { id?: string; aliases?: string[]; published?: string; severity?: Array<{ score?: string }>; database_specific?: { severity?: string };
    affected?: Array<{ package?: { name?: string }; ranges?: Array<{ events?: Array<{ fixed?: string }> }> }> };
  if (!vuln || typeof vuln.id !== "string") return null;
  const label = String(vuln.database_specific?.severity ?? "").toUpperCase();
  const severity: SecuritySeverity = label === "CRITICAL" || label === "HIGH" || label === "LOW" ? label : label === "MODERATE" || label === "MEDIUM" ? "MEDIUM" : "UNKNOWN";
  const fixed = (vuln.affected ?? []).filter((entry) => entry.package?.name === packageName).flatMap((entry) => entry.ranges ?? []).flatMap((range) => range.events ?? [])
    .map((event) => event.fixed).find((value): value is string => typeof value === "string") ?? null;
  return { id: vuln.id, aliases: Array.isArray(vuln.aliases) ? vuln.aliases.filter((alias) => typeof alias === "string").slice(0, 40) : [], severity, cvss: null, fixed,
    published: typeof vuln.published === "string" ? vuln.published : null };
}
